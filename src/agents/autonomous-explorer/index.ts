// Autonomous Explorer (PLAN.md §3, exploratory-testing SKILL): one time-boxed charter, approved actions only, a
// visited/unvisited state map, evidence-gain step selection, stop conditions. Read-mostly: only `save-attempt` mutates
// (guarded + audited through uiAttempt, capped), anything created is adopted (run tag + ledger) and removed by the
// verified cleanup. Findings come from deterministic oddities, each with evidence; they never become tests here —
// review.ts drafts REVIEW_REQUIRED cases and a human promotes them.
import { z } from 'zod';
import type { Logger } from '../../core/logger.js';
import type {
  Environment,
  ExplorationCharter,
  ExplorationFinding,
  ExplorationReport,
  ExplorationStep,
} from '../../core/schemas/index.js';
import type { EvidenceLedger, SourceRef } from '../../knowledge/evidenceLedger.js';
import type { ModelRouter } from '../../models/router.js';
import type { Redactor } from '../../security/redact.js';
import type { SnapshotFacts } from '../../sf/data/plan.js';
import { runStructured } from '../shared/structured.js';
import { CONTACT_FIELDS, type ActionDef, type ContactLabel } from './catalog.js';
import { matchConsoleNoise, type ConsoleNoiseEntry } from './consoleNoise.js';
import { predictSave, type Prediction } from './oracle.js';
import { applicable, candidates, formKey, type Candidate } from './select.js';
import { signatureOf, StateMap, type FormClasses, type Observation } from './stateMap.js';

export interface SaveOutcome {
  /** The dialog closed after Save (Lightning: the record was saved). */
  closed: boolean;
  messages: string[];
}

/** Browser actions of the charter (Playwright in driver.ts, a fake in unit tests). */
export interface ExplorerDriver {
  open(): Promise<void>;
  /** Types the value; returns what the input holds afterwards (an input may truncate). */
  fill(label: string, value: string): Promise<string>;
  clear(label: string): Promise<void>;
  select(label: string, value: string): Promise<void>;
  tab(): Promise<void>;
  cancel(): Promise<void>;
  escape(): Promise<void>;
  save(): Promise<SaveOutcome>;
  observe(): Promise<Observation>;
  /** Console errors since the last call (redacted by the caller). */
  takeConsoleErrors(): string[];
  screenshot(name: string): Promise<string | undefined>;
  close(): Promise<void>;
}

export interface ExplorerOrg {
  /** Contacts on the seed Account (SOQL), to see what a Save created. */
  contactsOnAccount(): Promise<string[]>;
  /** Adopt a record a Save created (run tag + ledger → cleaned up). */
  adopt(id: string, label: string): Promise<void>;
  /** Guarded, audited UI mutation. */
  uiAttempt<T>(fn: () => Promise<T>): Promise<T>;
  cleanup(): Promise<'CLEAN' | 'INCOMPLETE'>;
  /** Host the charter must stay on. */
  host: string;
}

export interface ExplorerDeps {
  driver: ExplorerDriver;
  org: ExplorerOrg;
  facts: SnapshotFacts | undefined;
  ledger: EvidenceLedger;
  router?: ModelRouter;
  redactor?: Redactor;
  logger?: Logger;
  say?: (m: string) => void;
  now?: () => Date;
  /** Accepted Salesforce-owned console noise for this org (config/console-noise.yaml). */
  consoleNoise?: readonly ConsoleNoiseEntry[];
}

export interface CharterRun {
  root: string;
  runId: string;
  orgAlias: string;
  environment: Environment;
  charter: ExplorationCharter;
  catalog: readonly ActionDef[];
  runPrefix: string;
  /** Let the reasoning model pick among the top candidates (default: deterministic score). */
  useModel?: boolean;
}

const Choice = z.object({ actionId: z.string(), reason: z.string().min(5).max(300) });

const API = CONTACT_FIELDS as Record<string, string>;

export async function runCharter(r: CharterRun, d: ExplorerDeps): Promise<ExplorationReport> {
  const say = d.say ?? (() => undefined);
  const now = d.now ?? (() => new Date());
  const startedAt = now();
  const deadline = startedAt.getTime() + r.charter.timeBoxMin * 60_000;
  const map = new StateMap();
  const steps: ExplorationStep[] = [];
  const findings: ExplorationFinding[] = [];
  const savedForms = new Set<string>();
  const constrained = new Set<string>();
  for (const [label, api] of Object.entries(API)) {
    const f = d.facts?.field('Contact', api);
    if (f?.required || f?.type === 'email' || f?.length) constrained.add(label);
    if (
      d.facts?.activeValidationRules('Contact').some((vr) => {
        const fm = vr.body?.['errorConditionFormula'];
        return typeof fm === 'string' && fm.includes(api);
      })
    )
      constrained.add(label);
  }
  let form: FormClasses = {};
  let values: Record<string, string> = {};
  let saves = 0;
  let errors = 0;
  let sinceNew = 0;
  let requiredChecked = false;
  const truncationSeen = new Set<string>();
  const consoleSeen = new Set<string>();
  /** Console messages matched by the accepted noise baseline, per entry id (reported in the coverage note). */
  const noiseSeen = new Map<string, number>();
  const trail: string[] = []; // action descriptions since the dialog opened
  let fseq = 0;

  const evidence = (claim: string, sources: SourceRef[], subject: string): string => {
    const id = `EV-${r.runId}-x${String(++fseq)}`;
    d.ledger.add({
      id,
      runId: r.runId,
      kind: 'exploration',
      claim: d.redactor ? d.redactor.redactText(claim) : claim,
      sources: sources.length ? sources : [{ type: 'result', ref: `${r.runId} exploration step` }],
      agent: 'autonomous-explorer',
      confidence: 0.9,
      environment: r.environment,
      createdAt: now().toISOString(),
      subject,
    });
    return id;
  };
  type FindingInput = Omit<ExplorationFinding, 'id' | 'charterId' | 'evidenceIds' | 'expectedEvidence'> & {
    expectedEvidence?: string[] | undefined;
  };
  const addFinding = (f: FindingInput, sources: SourceRef[]): void => {
    const id = `XF-${r.runId}-${String(findings.length + 1)}`;
    const ev = evidence(`${f.kind}: ${f.observation}`, sources, id);
    findings.push({ ...f, expectedEvidence: f.expectedEvidence ?? [], id, charterId: r.charter.id, evidenceIds: [ev] });
    say(`  FINDING ${id} ${f.kind}: ${f.title}`);
  };

  // Charter choice is evidence too (skill: "write the choice and its reason to the evidence ledger").
  evidence(
    `charter ${r.charter.id}: ${r.charter.mission} — chosen because ${r.charter.reason}`,
    [{ type: 'requirement', ref: r.charter.requirementIds.join(', ') || r.charter.area }],
    r.charter.id,
  );

  let obs = await d.driver.observe();
  let cur = signatureOf(obs, form);
  map.visit(cur.id, obs, cur.signature, 0);
  let stoppedBy: ExplorationReport['stoppedBy'] = 'max-steps';

  for (let step = 1; step <= r.charter.maxSteps; step++) {
    if (now().getTime() >= deadline) {
      stoppedBy = 'time-box';
      break;
    }
    if (sinceNew >= r.charter.saturationSteps) {
      stoppedBy = 'saturation';
      break;
    }
    if (errors >= 3) {
      stoppedBy = 'error-budget';
      break;
    }
    if (obs.url && /^https?:/.test(obs.url) && new URL(obs.url).host !== d.org.host) {
      stoppedBy = 'off-domain';
      break;
    }
    const dialogOpen = Boolean(obs.dialog);
    const prediction: Prediction = predictSave(values, d.facts);
    const cands = candidates({
      catalog: r.catalog,
      state: cur.id,
      dialogOpen,
      form,
      map,
      savesLeft: r.charter.maxSaves - saves,
      savedForms,
      prediction,
      constrainedFields: constrained,
    });
    if (!cands.length) {
      if (dialogOpen) {
        // nothing new here: leave the dialog (interruption) and continue from a fresh form
        await d.driver.cancel().catch(() => undefined);
        form = {};
        values = {};
        obs = await d.driver.observe();
        cur = signatureOf(obs, form);
        map.visit(cur.id, obs, cur.signature, step);
        sinceNew++;
        continue;
      }
      stoppedBy = 'catalog-done';
      break;
    }
    const pick = await choose(cands, r, d, { form, prediction });
    const a = pick.cand.action;
    const from = cur.id;
    let observation: string;
    try {
      switch (a.kind) {
        case 'open-dialog':
          await d.driver.open();
          form = {};
          values = {};
          trail.length = 0;
          observation = 'New Contact dialog opened from the seed Account';
          break;
        case 'fill': {
          const label = a.target as ContactLabel;
          const v = a.value?.(r.runPrefix) ?? '';
          const after = await d.driver.fill(label, v);
          form[label] = a.valueClass ?? 'value';
          values[API[label] ?? label] = after;
          observation = `${label} ← ${a.valueClass ?? ''}${after.length < v.length ? ` (input kept ${String(after.length)} of ${String(v.length)} characters)` : ''}`;
          if (after.length < v.length && !truncationSeen.has(label)) {
            truncationSeen.add(label);
            const len = d.facts?.field('Contact', API[label] ?? '')?.length;
            addFinding(
              {
                kind: 'question',
                title: `${label} input keeps at most ${String(after.length)} characters (longer input is cut, no message)`,
                observation: `typing ${String(v.length)} characters left ${String(after.length)} in the ${label} input${len ? `; the field length in the org is ${String(len)}` : ''}`,
                // only what reproduces it: open the dialog and type (explore-p7-fx-2 carried the whole trail)
                steps: [
                  'Open the New Contact dialog from the Account Contacts related list',
                  `Type ${String(v.length)} characters into ${label}`,
                ],
                ...(len
                  ? {
                      expected: `${label} accepts at most ${String(len)} characters`,
                      expectedEvidence: [`Field:Contact.${API[label] ?? ''}`],
                    }
                  : {}),
                severity: 'MINOR',
                suggestion: 'test-case',
              },
              [{ type: 'config', ref: `Field:Contact.${API[label] ?? ''}${len ? ` length ${String(len)}` : ''}` }],
            );
          }
          break;
        }
        case 'clear': {
          const label = a.target as ContactLabel;
          await d.driver.clear(label);
          form[label] = '';
          values[API[label] ?? label] = '';
          observation = `${label} cleared`;
          break;
        }
        case 'select': {
          const label = a.target as ContactLabel;
          const v = a.value?.(r.runPrefix) ?? '';
          await d.driver.select(label, v);
          form[label] = a.valueClass ?? v;
          values[API[label] ?? label] = v;
          observation = `${label} = ${v}`;
          break;
        }
        case 'tab-key':
          await d.driver.tab();
          observation = 'Tab pressed';
          break;
        case 'cancel':
        case 'escape':
          if (a.kind === 'cancel') await d.driver.cancel();
          else await d.driver.escape();
          // Only a dialog that really closed resets the form (explore-p7-fx-1: Escape left the fixture dialog open).
          if ((await d.driver.observe()).dialog) {
            observation = `${a.kind}: the dialog stayed open`;
          } else {
            form = {};
            values = {};
            observation = `${a.kind}: dialog left without saving`;
          }
          break;
        case 'save-attempt': {
          const before = new Set(await d.org.contactsOnAccount());
          const out = await d.org.uiAttempt(() => d.driver.save());
          const created = (await d.org.contactsOnAccount()).filter((id) => !before.has(id));
          for (const id of created) await d.org.adopt(id, `explore-${String(step)}`);
          saves++;
          savedForms.add(formKey(form));
          const shot = await d.driver.screenshot(`save-${String(step)}`);
          const sources: SourceRef[] = [
            {
              type: 'result',
              ref: `${r.runId} step ${String(step)}: save → ${created.length ? 'record created' : 'not saved'}`,
            },
            { type: 'soql', ref: 'SELECT Id FROM Contact WHERE AccountId = <seed Account>' },
            ...(shot ? [{ type: 'screenshot' as const, ref: shot }] : []),
          ];
          observation = `Save → ${created.length ? `record created (adopted for cleanup)` : 'not saved'}${out.messages.length ? `; messages: ${out.messages.join(' | ')}` : ''}`;
          const blocking = prediction.reasons.filter((x) => x.kind !== 'length');
          const stepsTo = [...trail, 'Click Save'];
          if (prediction.verdict === 'reject' && created.length) {
            for (const reason of blocking) {
              addFinding(
                {
                  kind: 'rule-not-enforced',
                  title: `Contact saved although ${reason.message} (${reason.ref})`,
                  observation: `the org's declared ${reason.kind} (${reason.ref}) predicts a rejection; the Save created a record`,
                  steps: stepsTo,
                  expected: `The Contact is not saved: ${reason.message}`,
                  expectedEvidence: [reason.ref],
                  severity: 'MAJOR',
                  suggestion: 'suspected-defect',
                },
                [...sources, { type: 'config', ref: reason.ref }],
              );
            }
          } else if (prediction.verdict === 'accept' && !created.length && !out.closed && out.messages.length) {
            addFinding(
              {
                kind: 'unexpected-message',
                title: `Save rejected with a message no declared rule explains: "${(out.messages[0] ?? '').slice(0, 80)}"`,
                observation: `declared required fields, formats and active validation rules predict a successful save; the org showed: ${out.messages.join(' | ')}`,
                steps: stepsTo,
                severity: 'MINOR',
                suggestion: 'question',
              },
              sources,
            );
          }
          if (out.closed) {
            form = {};
            values = {};
            trail.length = 0;
          }
          break;
        }
        default:
          observation = `${a.kind} not supported by this charter`;
      }
      trail.push(describe(a));
    } catch (e) {
      errors++;
      observation = `action failed: ${e instanceof Error ? (e.message.split('\n')[0] ?? '') : String(e)}`;
    }
    obs = await d.driver.observe();
    // Required markers (once, on the first dialog seen): UI vs declared configuration.
    if (obs.dialog && !requiredChecked && obs.requiredMarked.length) {
      requiredChecked = true;
      for (const [label, api] of Object.entries(API)) {
        const declared = d.facts?.field('Contact', api);
        if (!declared) continue;
        const marked = obs.requiredMarked.includes(label);
        if (marked !== declared.required) {
          addFinding(
            {
              kind: 'required-mismatch',
              title: `${label} is ${marked ? 'marked required in the dialog' : 'not marked required in the dialog'} but ${declared.required ? 'required' : 'optional'} in the org's field definition`,
              observation: `New Contact dialog marks ${label} ${marked ? 'required' : 'optional'}; describe says ${declared.required ? 'required' : 'optional'} (page layouts can make a field required in the UI only)`,
              steps: ['Open the New Contact dialog from an Account'],
              severity: 'MINOR',
              suggestion: 'question',
            },
            [
              { type: 'config', ref: `Field:Contact.${api}` },
              { type: 'aria', ref: `${r.runId} dialog required markers` },
            ],
          );
        }
      }
    }
    for (const c of d.driver.takeConsoleErrors()) {
      // A rejected save shows up as "Failed to load resource … 4xx": that is the expected rejection channel, not an
      // oddity (explore-p7-fx-1). 5xx and script errors stay findings.
      if (/Failed to load resource: the server responded with a status of 4\d\d/.test(c)) continue;
      // Accepted Salesforce-owned noise (operator 2026-11-28): counted, not reported.
      const noise = matchConsoleNoise(d.consoleNoise ?? [], c);
      if (noise) {
        noiseSeen.set(noise.id, (noiseSeen.get(noise.id) ?? 0) + 1);
        continue;
      }
      // de-duplicate by the message's start: one Salesforce-owned console message, many variants (explore-p7-live-1)
      const key = c.slice(0, 60);
      if (consoleSeen.has(key)) continue;
      consoleSeen.add(key);
      addFinding(
        {
          kind: 'console-error',
          title: `Browser console error during Contact creation: ${key.slice(0, 80)}`,
          observation: d.redactor ? d.redactor.redactText(c) : c,
          steps: [...trail],
          severity: 'MINOR',
          suggestion: 'question',
        },
        [{ type: 'result', ref: `${r.runId} step ${String(step)} console` }],
      );
    }
    const next = signatureOf(obs, form);
    const { isNew } = map.visit(next.id, obs, next.signature, step);
    map.markTried(
      from,
      a.id,
      applicable(r.catalog, Boolean(obs.dialog)).map((x) => x.id),
    );
    map.edge(from, next.id, a.id, step);
    sinceNew = isNew ? 0 : sinceNew + 1;
    steps.push({
      step,
      actionId: a.id,
      from,
      to: next.id,
      newState: isNew,
      reason: pick.reason,
      chosenBy: pick.by,
      observation: d.redactor ? d.redactor.redactText(observation) : observation,
      evidenceIds: [],
      at: now().toISOString(),
    });
    say(`  ${String(step).padStart(2)} ${a.id.padEnd(16)} ${isNew ? 'NEW ' : '    '}${observation}`);
    cur = next;
  }
  if (obs.dialog) await d.driver.cancel().catch(() => undefined);
  await d.driver.close();
  const cleanup = await d.org.cleanup();
  const endedAt = now();
  return {
    runId: r.runId,
    org: r.orgAlias,
    environment: r.environment,
    charter: r.charter,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    stoppedBy,
    steps,
    states: [...map.nodes.values()],
    edges: map.edges,
    saves,
    findings,
    coverageNote: `${String(steps.length)} steps in ${String(Math.round((endedAt.getTime() - startedAt.getTime()) / 1000))} s, ${String(map.nodes.size)} states (${String([...map.nodes.values()].filter((n) => n.finished).length)} finished), ${String(saves)}/${String(r.charter.maxSaves)} saves, ${String(findings.length)} finding(s); stopped by ${stoppedBy}${noiseSeen.size ? `; known console noise ignored: ${[...noiseSeen].map(([id, n]) => `${id} ×${String(n)}`).join(', ')}` : ''}`,
    dataCleanup: cleanup,
  };
}

function describe(a: ActionDef): string {
  switch (a.kind) {
    case 'open-dialog':
      return 'Open the New Contact dialog from the Account Contacts related list';
    case 'fill':
      return `Enter ${a.valueClass ?? 'a value'} in ${a.target ?? ''}`;
    case 'clear':
      return `Clear ${a.target ?? ''}`;
    case 'select':
      return `Select ${a.valueClass ?? ''} in ${a.target ?? ''}`;
    case 'tab-key':
      return 'Press Tab';
    case 'save-attempt':
      return 'Click Save';
    default:
      return a.kind;
  }
}

async function choose(
  cands: Candidate[],
  r: CharterRun,
  d: ExplorerDeps,
  ctx: { form: FormClasses; prediction: Prediction },
): Promise<{ cand: Candidate; reason: string; by: 'score' | 'model' }> {
  const top = cands.slice(0, 5);
  const best = top[0] as Candidate;
  const scoreReason = `score ${String(best.score)}: ${best.parts.join(', ')}`;
  if (!r.useModel || !d.router || top.length < 2) return { cand: best, reason: scoreReason, by: 'score' };
  try {
    const res = await runStructured({
      router: d.router,
      role: 'reasoning',
      agent: 'autonomous-explorer:step',
      schema: Choice,
      contract: '{"actionId": one of the candidate ids, "reason": "why this action gains the most evidence"}',
      system: `You are the Autonomous Explorer. Charter: ${r.charter.mission}. Pick the next action from CANDIDATES that gains the most evidence about the charter's risk. Never invent an action.`,
      user: [
        `FORM: ${JSON.stringify(ctx.form)}`,
        `ORG RULES PREDICT: ${ctx.prediction.verdict} (${ctx.prediction.reasons.map((x) => x.ref).join(', ')})`,
        'CANDIDATES',
        ...top.map(
          (c) =>
            `- ${c.action.id}: ${c.action.kind} ${c.action.target ?? ''} ${c.action.valueClass ?? ''} [${c.action.heuristic}] score ${String(c.score)}`,
        ),
      ].join('\n'),
      ...(d.redactor ? { redactor: d.redactor } : {}),
      ...(d.logger ? { logger: d.logger } : {}),
      check: (c) => (top.some((x) => x.action.id === c.actionId) ? [] : [`actionId ${c.actionId} is not a candidate`]),
    });
    const cand = top.find((x) => x.action.id === res.value.actionId) ?? best;
    return { cand, reason: res.value.reason, by: 'model' };
  } catch {
    return { cand: best, reason: `${scoreReason} (model unavailable)`, by: 'score' };
  }
}
