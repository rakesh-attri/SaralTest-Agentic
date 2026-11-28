// Defect Judge (PLAN.md §3, defect-investigation SKILL): turns a PRODUCT_DEFECT / PERMISSION_CONFIG investigation into
// a bug draft and decides CONFIRMED / SUSPECTED. Order: deterministic gate → bug text rendered by code from evidence →
// title proposed by a model (format-checked) → judge model (≠ coder) checks every claim against the evidence →
// CONFIRMED only when the gate passed, the judge confirmed and no claim is unsupported. DeepEval faithfulness is Phase 8
// (UNEVALUATED) → a human reviews before anything is published. Nothing here posts anything.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../../core/logger.js';
import {
  DefectDraft,
  type Environment,
  type Experiment,
  type Investigation,
  type JudgeReview,
  type TestResult,
} from '../../core/schemas/index.js';
import type { EvidenceLedger, LedgerEntry } from '../../knowledge/evidenceLedger.js';
import type { ModelRouter } from '../../models/router.js';
import type { Redactor } from '../../security/redact.js';
import type { SkillLoader } from '../../skills/skillLoader.js';
import { runStructured } from '../shared/structured.js';
import { loadCaseContext } from '../failure-investigator/context.js';
import { gatePassed, judgeGate } from './gate.js';
import { JUDGE_CONTRACT, JudgeVerdict, TITLE_CONTRACT, TITLE_FORMAT, TitleDraft } from './schema.js';

export const JUDGE_SKILLS = ['defect-investigation'] as const;

export interface JudgeDeps {
  router?: ModelRouter;
  skills?: SkillLoader;
  redactor?: Redactor;
  logger?: Logger;
  ledger: EvidenceLedger;
}

export interface JudgeOptions {
  root: string;
  /** Run the drafts are written under (runs/<runId>/defects). */
  runId: string;
  environment: Environment;
  org: { alias: string; orgId: string; profile: string };
  reproductions: number;
  /** The failed result (attachments: screenshot / trace). */
  result?: TestResult;
  sourceRun?: string;
  now?: () => Date;
}

function prompts(): Record<string, string> {
  const text = readFileSync(new URL('./prompt.md', import.meta.url), 'utf8');
  const out: Record<string, string> = {};
  for (const part of text.split(/^## /m).slice(1)) {
    const nl = part.indexOf('\n');
    out[part.slice(0, nl).trim()] = part.slice(nl + 1).trim();
  }
  return out;
}

const exp = (i: Investigation, k: Experiment['kind']): Experiment | undefined =>
  i.experiments.find((e) => e.kind === k);
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Facts the title model and the judge may use: the investigation's own evidence lines. */
function factLines(i: Investigation, ledger: readonly LedgerEntry[]): string[] {
  return [
    ...i.observations.map((o) => `observation: ${o}`),
    ...i.experiments.filter((e) => e.outcome !== 'SKIPPED').map((e) => `${e.id} ${e.kind} ${e.outcome}: ${e.result}`),
    ...ledger.map((e) => `${e.id}: ${e.claim}`),
  ];
}

/** Bug body rendered by code (everything the judge checks). */
export function renderBugBody(d: DefectDraft): string {
  const L: string[] = [];
  L.push(`# ${d.title}`, '');
  if (d.environment && d.environment !== 'LIVE') {
    L.push(
      `> **${d.environment}** — found on the ${d.environment === 'FIXTURE' ? 'offline fixture' : 'mock'}; not a Salesforce result. Do not file.`,
      '',
    );
  }
  L.push(
    `**Requirement:** ${d.requirementRefs.join(', ') || '—'} · **Test case:** ${d.caseId ?? '—'} · **Story:** ${d.storyKey ?? '—'}`,
  );
  L.push(
    `**Environment:** ${d.environment ?? '?'} · org ${d.org ?? '?'} (profile ${d.orgProfile ?? '?'}) · persona ${d.persona ?? '?'}`,
  );
  L.push(`**Severity:** ${d.severityLevel ?? d.severity} — ${d.severityRationale ?? ''}`, '');
  L.push(
    '## Preconditions and data',
    '',
    ...d.preconditions.map((p) => `- ${p}`),
    ...(d.dataScope ? [`- Data: ${d.dataScope}`] : []),
    '',
  );
  L.push('## Steps to reproduce', '', ...d.stepsToReproduce.map((s, n) => `${String(n + 1)}. ${s}`), '');
  L.push('## Expected', '', d.expected, '', '## Actual', '', d.actual, '');
  L.push('## Reproductions', '');
  for (const r of d.reproductions)
    L.push(
      `- ${r.via} · ${r.outcome} · ${r.freshData ? 'fresh data' : 'same data'} · persona ${r.persona} · run ${r.runId}: ${r.detail}`,
    );
  L.push(
    '',
    '## Evidence',
    '',
    ...d.apiEvidence.map((a) => `- API/SOQL: ${a}`),
    ...d.attachments.map((a) => `- ${a.name}: ${a.path}`),
    ...d.evidenceIds.map((e) => `- ledger ${e}`),
  );
  L.push(
    '',
    '## Affected components',
    '',
    ...(d.components.length ? d.components.map((c) => `- ${c}`) : ['- none recorded']),
  );
  L.push('', '## Root-cause hypotheses', '', ...d.hypotheses.map((h) => `- ${h}`));
  L.push(
    '',
    '## Possible duplicates',
    '',
    ...(d.duplicates.length
      ? d.duplicates.map((x) => `- ${x}`)
      : ['- not searched: no defect history is ingested for this story']),
  );
  L.push('', '## Suggested regression tests', '', ...d.suggestedRegressionTests.map((t) => `- ${t}`), '');
  return L.join('\n');
}

/** Full bug text = body + the judge's decision (what the operator approves; the sha binds to it). */
export function renderBugText(d: DefectDraft): string {
  const j = d.judge;
  const L = [renderBugBody(d), '## Defect Judge', ''];
  L.push(`**Status: ${d.status ?? 'SUSPECTED'}** — ${j ? `${j.decision} by ${j.model}: ${j.reason}` : 'not judged'}`);
  if (j) {
    const g = j.gate;
    L.push(
      '',
      `Gate: reproduced 2× fresh ${g.reproducedTwiceFreshData ? '✓' : '✗'} · API ${g.reproducedViaApi ? '✓' : '✗'} · test data ruled out ${g.testDataRuledOut ? '✓' : '✗'} · environment ruled out ${g.environmentRuledOut ? '✓' : '✗'} · requirement traced ${g.requirementTraced ? '✓' : '✗'} · evidence resolves ${g.evidenceResolves ? '✓' : '✗'} · sanitized ${g.sanitized ? '✓' : '✗'}`,
    );
    if (g.missing.length) L.push('', ...g.missing.map((m) => `- missing: ${m}`));
    if (j.unsupportedClaims.length) L.push('', ...j.unsupportedClaims.map((c) => `- unsupported claim: ${c}`));
  }
  if (d.faithfulness)
    L.push(
      '',
      `Faithfulness (DeepEval): ${d.faithfulness.status}${d.faithfulness.detail ? ` — ${d.faithfulness.detail}` : ''}`,
    );
  L.push(
    '',
    `_Drafted by sf-qa-agent · run ${d.runId ?? '?'} · nothing is posted without the operator's approval of this exact text (checkpoint publish-defect)._`,
    '',
  );
  return L.join('\n');
}

export interface JudgeOutcome {
  draft: DefectDraft;
  text: string;
  files: string[];
}

export async function judgeInvestigation(inv: Investigation, o: JudgeOptions, d: JudgeDeps): Promise<JudgeOutcome> {
  const now = o.now ?? (() => new Date());
  const caseId = inv.caseId ?? inv.failureId;
  const ctx = loadCaseContext(o.root, caseId);
  const tc = ctx.testCase;
  const trace = exp(inv, 'requirement-trace');
  const caseStep = typeof trace?.data['caseStep'] === 'number' ? trace.data['caseStep'] : undefined;
  const step = caseStep !== undefined ? tc?.steps[caseStep] : undefined;
  const fresh = exp(inv, 'rerun-fresh-data');
  const api = exp(inv, 'api-reproduce');
  const persona = inv.persona ?? tc?.persona ?? 'system-admin';
  const asserted = ctx.ir?.steps.flatMap((s) => s.assertions).find((a) => 'object' in a);
  const object: string = asserted && 'object' in asserted ? asserted.object : 'Record';
  const ledgerRows = d.ledger.forSubject(inv.failureId);

  // ---- reproductions + actual (facts only)
  const runIds = Array.isArray(fresh?.data['runIds']) ? (fresh.data['runIds'] as unknown[]).map(String) : [];
  const states = Array.isArray(fresh?.data['states']) ? (fresh.data['states'] as unknown[]).map(String) : [];
  const reproductions: DefectDraft['reproductions'] = runIds.map((r, n) => ({
    via: 'UI',
    runId: r,
    outcome: states[n] === 'FAIL' ? 'REPRODUCED' : states[n] === 'PASS' ? 'NOT_REPRODUCED' : 'ERROR',
    freshData: true,
    persona,
    detail: `rerun ${String(n + 1)}: ${states[n] ?? '?'}`,
    evidenceIds: fresh?.evidenceIds ?? [],
    at: fresh?.at ?? now().toISOString(),
  }));
  if (api && api.outcome !== 'SKIPPED') {
    reproductions.push({
      via: 'API',
      runId: `${o.runId}-api`,
      outcome: api.outcome === 'SUPPORTS' ? 'REPRODUCED' : api.outcome === 'REFUTES' ? 'NOT_REPRODUCED' : 'ERROR',
      freshData: true,
      persona,
      detail: api.result,
      evidenceIds: api.evidenceIds,
      at: api.at,
    });
  }
  const firstFailure =
    inv.observations.find((x) => !x.startsWith('state ') && !x.startsWith('failed at')) ?? inv.rationale ?? '';
  // Evidence-derived text is redacted before it enters the bug (record ids, emails stay in the local ledger only;
  // run-p7-fx-br08-1: a SOQL line carried a Contact id). The sanitize gate still checks the final text.
  const red = (t: string): string => (d.redactor ? d.redactor.redactText(t) : t);
  const actual = [
    `UI: ${fresh?.result ?? 'not rerun'} — ${firstFailure}`,
    ...(api && api.outcome !== 'SKIPPED' ? [`API: ${api.result}`] : []),
  ]
    .map(red)
    .join('\n\n');

  const attachments = [
    ...(o.result?.failure?.screenshot && o.sourceRun
      ? [{ name: 'screenshot', path: `runs/${o.sourceRun}/${o.result.failure.screenshot}` }]
      : []),
    ...(o.result?.failure?.trace && o.sourceRun
      ? [{ name: 'trace', path: `runs/${o.sourceRun}/${o.result.failure.trace}` }]
      : []),
  ];
  const apiEvidence = (api?.evidenceIds ?? []).flatMap(
    (id) => d.ledger.get(id)?.sources.map((s) => red(`${s.type} ${s.ref}`)) ?? [],
  );
  const evidenceIds = [
    ...new Set([
      ...inv.evidenceIds,
      ...(fresh?.evidenceIds ?? []),
      ...(api?.evidenceIds ?? []),
      ...(trace?.evidenceIds ?? []),
    ]),
  ];
  const recipe = tc?.dataRecipe;
  const defectId = `DEF-${caseId.replace(/^TC-/, '')}-${sha(`${inv.failureId}|${o.runId}`).slice(0, 6)}`;

  // ---- title (model, format-checked) or deterministic fallback
  const P = prompts();
  const facts = factLines(inv, ledgerRows);
  const fallbackTitle = `[${object}] ${tc?.title ?? caseId} — fails when the case is run for ${persona}`;
  let title = fallbackTitle;
  if (d.router) {
    try {
      const r = await runStructured({
        router: d.router,
        role: 'reasoning',
        agent: 'defect-judge:title',
        schema: TitleDraft,
        contract: TITLE_CONTRACT,
        system: P['title'] ?? '',
        user: [
          `OBJECT: ${object}`,
          `PERSONA: ${persona}`,
          `REQUIREMENT: ${step?.expected.text ?? ''}`,
          'FACTS',
          ...facts.map((f) => `- ${f}`),
        ].join('\n'),
        ...(d.redactor ? { redactor: d.redactor } : {}),
        ...(d.logger ? { logger: d.logger } : {}),
        check: (t) => [
          ...(TITLE_FORMAT.test(t.title) ? [] : ['title must match "[Object] <what> when <condition> for <persona>"']),
          ...(t.title.endsWith(` for ${persona}`) ? [] : [`title must end with " for ${persona}"`]),
          ...(t.title.startsWith(`[${object}] `) ? [] : [`title must start with "[${object}] "`]),
        ],
      });
      title = r.value.title;
    } catch {
      title = fallbackTitle;
    }
  }

  let draft = DefectDraft.parse({
    id: defectId,
    failureId: inv.failureId,
    title,
    stepsToReproduce: [
      ...(tc?.steps.map((s) => s.action) ?? []),
      ...(api?.outcome === 'SUPPORTS' ? [red(`Or through the API: ${api.result}`)] : []),
    ],
    expected: `${step?.expected.text ?? '(no expected text)'} (${step?.expected.evidenceLevel ?? '?'}: ${(step?.expected.evidenceIds ?? []).join(', ')})`,
    actual,
    evidenceIds: evidenceIds.length ? evidenceIds : [inv.failureId],
    severity: tc?.severity ?? 'MAJOR',
    published: false,
    verdict: inv.verdict,
    runId: o.runId,
    caseId,
    ...(ctx.storyKey ? { storyKey: ctx.storyKey } : {}),
    requirementRefs: [...new Set([...(tc?.requirementIds ?? []), ...(step?.expected.evidenceIds ?? [])])],
    environment: o.environment,
    org: o.org.alias,
    orgProfile: o.org.profile,
    persona,
    preconditions: tc?.preconditions ?? [],
    ...(recipe
      ? { dataScope: `approved recipe ${recipe}, run-tagged records created per reproduction and cleaned up` }
      : {}),
    reproductions,
    apiEvidence,
    attachments,
    components: ctx.artifact?.dependsOn?.map((x) => x.component) ?? [],
    duplicates: [],
    hypotheses: inv.hypotheses.map(
      (h) => red(`${h.verdict ?? ''} ${h.status ?? 'OPEN'}: ${h.text}${h.result ? ` (${h.result})` : ''}`),
    ),
    suggestedRegressionTests: [
      `${caseId} (keep: the failing case itself)`,
      ...(ctx.storyKey && tc
        ? [`the other cases of ${tc.requirementIds.join(', ')} (positive counterpart included)`]
        : []),
    ],
    ...(tc?.severity ? { severityLevel: tc.severity } : {}),
    severityRationale: `case ${caseId} is ${tc?.priority ?? '?'} / ${tc?.severity ?? '?'}${tc?.riskIds.length ? `; risk ${tc.riskIds.join(', ')}` : ''}`,
    createdAt: now().toISOString(),
  });

  // ---- gate + judge
  const body = renderBugBody(draft);
  const sanitized = !d.redactor || d.redactor.redactText(body) === body;
  const gate = judgeGate(inv, {
    reproductions: o.reproductions,
    missingEvidence: d.ledger.missing(draft.evidenceIds),
    sanitized,
  });
  let judge: JudgeReview;
  if (!sanitized) {
    judge = {
      gate,
      unsupportedClaims: [],
      model: 'none',
      decision: 'SUSPECTED',
      reason: 'bug text contains redactable data: not sent to a model, not fileable',
      at: now().toISOString(),
    };
  } else if (!d.router) {
    judge = {
      gate,
      unsupportedClaims: [],
      model: 'none',
      decision: 'SUSPECTED',
      reason: 'no judge model configured: a human must judge',
      at: now().toISOString(),
    };
  } else {
    try {
      const r = await runStructured({
        router: d.router,
        role: 'judge',
        agent: 'defect-judge:judge',
        schema: JudgeVerdict,
        contract: JUDGE_CONTRACT,
        system: P['judge'] ?? '',
        user: [
          'BUG TEXT',
          body,
          'GATE',
          ...Object.entries(gate)
            .filter(([k]) => k !== 'missing')
            .map(([k, v]) => `- ${k}: ${String(v)}`),
          'EVIDENCE',
          ...facts.map((f) => `- ${f}`),
        ].join('\n'),
        ...(d.skills ? { skills: { loader: d.skills, names: JUDGE_SKILLS } } : {}),
        ...(d.redactor ? { redactor: d.redactor } : {}),
        ...(d.logger ? { logger: d.logger } : {}),
      });
      judge = {
        gate,
        unsupportedClaims: r.value.unsupportedClaims,
        model: `${r.model}${r.usedFallback ? ' (fallback)' : ''}`,
        decision: r.value.decision,
        reason: r.value.reason,
        at: now().toISOString(),
      };
    } catch (e) {
      judge = {
        gate,
        unsupportedClaims: [],
        model: 'none',
        decision: 'SUSPECTED',
        reason: `judge model failed (${e instanceof Error ? e.message : String(e)}): a human must judge`,
        at: now().toISOString(),
      };
    }
  }
  const confirmed = gatePassed(gate) && judge.decision === 'CONFIRMED' && judge.unsupportedClaims.length === 0;
  draft = DefectDraft.parse({
    ...draft,
    status: confirmed ? 'CONFIRMED' : 'SUSPECTED',
    judge,
    faithfulness: {
      metric: 'faithfulness',
      score: null,
      threshold: 0.85,
      status: 'UNEVALUATED',
      detail: 'DeepEval sidecar arrives in Phase 8 — the operator reviews the bug text before it is published',
    },
  });
  const text = renderBugText(draft);
  draft = DefectDraft.parse({ ...draft, sha256: sha(text) });

  const dir = join(o.root, 'runs', o.runId, 'defects');
  mkdirSync(dir, { recursive: true });
  const md = join(dir, `${defectId}.md`);
  const json = join(dir, `${defectId}.json`);
  writeFileSync(md, text, 'utf8');
  writeFileSync(json, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
  d.ledger.add({
    id: `EV-${defectId}-judge`,
    runId: o.runId,
    kind: 'judge',
    claim: `${draft.status} (${judge.decision} by ${judge.model}); gate ${gatePassed(gate) ? 'passed' : `missing: ${gate.missing.join('; ')}`}`,
    sources: draft.evidenceIds.map((id) => ({ type: 'evidence' as const, ref: id })),
    agent: 'defect-judge',
    confidence: confirmed ? 0.9 : 0.5,
    environment: o.environment,
    createdAt: now().toISOString(),
    subject: inv.failureId,
  });
  return { draft, text, files: [md, json] };
}

export function readDefect(root: string, runId: string, id: string): { draft: DefectDraft; text: string } {
  const dir = join(root, 'runs', runId, 'defects');
  const draft = DefectDraft.parse(JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')));
  const text = readFileSync(join(dir, `${id}.md`), 'utf8');
  if (!draft.sha256 || sha(text) !== draft.sha256)
    throw new Error(`defect ${id}: the text was changed after drafting (sha256 mismatch)`);
  return { draft, text };
}
