// Experiment catalog of the Failure Investigator (defect-investigation SKILL, "Experiment": cheapest discriminating
// check first; each result is evidence). Every experiment returns an `Experiment` plus the ledger entries it cites.
// Org access goes through injected providers (GuardedSalesforce in a real run, fakes in unit tests); a missing
// provider makes the experiment SKIPPED, never a guess.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Environment,
  Experiment,
  ExperimentKind,
  ExperimentOutcome,
  FailureSignal,
  TestResult,
} from '../../core/schemas/index.js';
import { fileSource, querySource, type LedgerEntry, type SourceRef } from '../../knowledge/evidenceLedger.js';
import { claimSupport, failedAssertion, type CaseContext } from './context.js';

export interface ProbeResult {
  identityOk: boolean;
  healthy: boolean;
  status?: number;
  detail: string;
}

export interface ObjectAccess {
  queryable: boolean;
  createable: boolean;
  updateable: boolean;
  deletable: boolean;
}

export interface RerunOutcome {
  result: TestResult | undefined;
  runId: string;
}

export interface ApiReproduction {
  reproduced: boolean;
  detail: string;
  data?: Record<string, unknown>;
  sources?: SourceRef[];
}

/** Org / runner access. Each is optional: no provider → the experiment is SKIPPED with the reason. */
export interface InvestigationProviders {
  probe?: () => Promise<ProbeResult>;
  query?: (soql: string) => Promise<Record<string, unknown>[]>;
  access?: (object: string) => Promise<ObjectAccess | undefined>;
  /** Active validation rules on an object (latest snapshot). */
  validationRules?: (object: string) => { name: string; errorMessage?: string }[];
  /** Components changed since the spec was built (spec dependencies vs latest snapshot / registry). */
  staleComponents?: (caseId: string) => string[];
  /** Run the case again (fresh data, same persona). `waitFactor` > 1 lengthens waits only. */
  rerun?: (o: { caseId: string; label: string; waitFactor?: number }) => Promise<RerunOutcome>;
  /** Registered API reproduction of the failing action for this case (Phase 7 T6). */
  apiReproduce?: (caseId: string) => Promise<ApiReproduction | undefined>;
}

export interface ExperimentEnv {
  root: string;
  /** Investigation run id (evidence rows are stored under it). */
  runId: string;
  /** Run folder of the failed result (attachments are relative to it). */
  sourceRunDir: string;
  environment: Environment;
  failureId: string;
  providers: InvestigationProviders;
  waitFactor: number;
  flakyReruns: number;
  reproductions: number;
  now?: () => Date;
}

export interface ExperimentRun {
  experiment: Experiment;
  evidence: LedgerEntry[];
}

const COST: Record<ExperimentKind, number> = {
  'requirement-trace': 1,
  'identity-probe': 2,
  'health-probe': 2,
  'soql-ledger': 3,
  'snapshot-diff': 3,
  'validation-rule-check': 4,
  'permission-check': 4,
  'aria-locate': 5,
  'rerun-fresh-data': 8,
  'rerun-extended-waits': 9,
  'flaky-reruns': 10,
  'api-reproduce': 7,
};
export const experimentCost = (k: ExperimentKind): number => COST[k];

let seq = 0;
function mk(
  env: ExperimentEnv,
  kind: ExperimentKind,
  question: string,
  outcome: ExperimentOutcome,
  result: string,
  sources: SourceRef[],
  data: Record<string, unknown> = {},
  hypothesisIds: string[] = [],
): ExperimentRun {
  const at = (env.now?.() ?? new Date()).toISOString();
  const id = `EV-${env.failureId}-${kind}-${(++seq).toString(36)}`;
  const action = kind.startsWith('rerun') || kind === 'flaky-reruns' || kind === 'api-reproduce' ? 'mutate' : 'observe';
  const evidence: LedgerEntry[] =
    sources.length && outcome !== 'SKIPPED'
      ? [
          {
            id,
            runId: env.runId,
            kind: 'experiment',
            claim: `${kind}: ${result}`,
            sources,
            agent: 'failure-investigator',
            confidence: outcome === 'INCONCLUSIVE' || outcome === 'ERROR' ? 0.3 : 0.9,
            environment: env.environment,
            createdAt: at,
            subject: env.failureId,
          },
        ]
      : [];
  return {
    experiment: {
      id: `X-${env.failureId}-${kind}`,
      kind,
      action,
      question,
      hypothesisIds,
      outcome,
      result,
      data,
      evidenceIds: evidence.map((e) => e.id),
      at,
    },
    evidence,
  };
}

const skipped = (env: ExperimentEnv, kind: ExperimentKind, question: string, why: string): ExperimentRun =>
  mk(env, kind, question, 'SKIPPED', why, []);

// ---------------------------------------------------------------- requirement-trace

/** Where the failing expectation came from: evidence level, and whether the cited text states it. */
export function requirementTrace(
  env: ExperimentEnv,
  ctx: CaseContext,
  r: TestResult,
  signals: readonly FailureSignal[],
): ExperimentRun {
  const q = 'Is the failing expectation stated by the requirement it cites?';
  const fa = failedAssertion(ctx, r, signals);
  if (!fa)
    return skipped(env, 'requirement-trace', q, 'no test IR for this case (cannot map the failure to an expectation)');
  const expected = ctx.testCase?.steps[fa.caseStep]?.expected;
  const level = expected?.evidenceLevel ?? 'UNKNOWN';
  const support = claimSupport(ctx, fa.assertion);
  const sources: SourceRef[] = [
    { type: 'requirement', ref: `${ctx.caseId} step ${fa.caseStep + 1} (${level})` },
    ...fa.assertion.expect.evidenceIds.map((id) => ({
      type: 'requirement' as const,
      ref: id,
      ...(ctx.evidenceText.get(id)
        ? {
            sha256: createHash('sha256')
              .update(ctx.evidenceText.get(id) ?? '')
              .digest('hex'),
          }
        : {}),
    })),
  ];
  const data = {
    check: fa.assertion.check,
    caseStep: fa.caseStep,
    evidenceLevel: level,
    evidenceIds: fa.assertion.expect.evidenceIds,
    support: support.status,
    ...(expected?.text ? { expectedText: expected.text } : {}),
  };
  if (support.status === 'unsupported') {
    return mk(env, 'requirement-trace', q, 'SUPPORTS', `not stated: ${support.detail}`, sources, {
      ...data,
      gap: support.detail,
    });
  }
  if (support.status === 'unknown')
    return mk(env, 'requirement-trace', q, 'INCONCLUSIVE', support.detail, sources, data);
  return mk(env, 'requirement-trace', q, 'REFUTES', `${support.detail} (${level})`, sources, data);
}

// ---------------------------------------------------------------- probes

export async function identityAndHealth(env: ExperimentEnv): Promise<ExperimentRun[]> {
  const p = env.providers.probe;
  const qi = 'Is the session still on the right org, user and instance?';
  const qh = 'Is the org reachable without 5xx / maintenance?';
  if (!p)
    return [
      skipped(env, 'identity-probe', qi, 'no org connection'),
      skipped(env, 'health-probe', qh, 'no org connection'),
    ];
  try {
    const r = await p();
    const src: SourceRef[] = [{ type: 'api', ref: 'identity check (Organization + userinfo)' }];
    return [
      mk(
        env,
        'identity-probe',
        qi,
        r.identityOk ? 'REFUTES' : 'SUPPORTS',
        r.identityOk ? 'identity verified' : `identity failed: ${r.detail}`,
        src,
        { identityOk: r.identityOk },
      ),
      mk(
        env,
        'health-probe',
        qh,
        r.healthy ? 'REFUTES' : 'SUPPORTS',
        r.healthy ? 'org healthy' : `org unhealthy: ${r.detail}`,
        [{ type: 'api', ref: 'GET /services/data (health)' }],
        { healthy: r.healthy, ...(r.status ? { status: r.status } : {}) },
      ),
    ];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return [
      mk(env, 'identity-probe', qi, 'INCONCLUSIVE', `probe error: ${msg}`, [{ type: 'api', ref: 'identity check' }]),
      mk(
        env,
        'health-probe',
        qh,
        'SUPPORTS',
        `org not reachable: ${msg}`,
        [{ type: 'api', ref: 'GET /services/data (health)' }],
        { healthy: false },
      ),
    ];
  }
}

// ---------------------------------------------------------------- data ledger

interface SubRunFacts {
  dir: string;
  writes: { state: string; object: string; reason?: string }[];
  cleanup?: string;
}

/** Data sub-run folders of a result: sha256(testId#retry)[:6] (tests/fixtures/index.ts). */
export function subRunDirs(runDir: string, r: TestResult): string[] {
  const n = Math.max(1, r.attempts ?? 1);
  return Array.from({ length: n }, (_, retry) =>
    join(runDir, 'data', createHash('sha256').update(`${r.testId}#${retry}`).digest('hex').slice(0, 6)),
  );
}

function readSubRun(dir: string): SubRunFacts | undefined {
  if (!existsSync(dir)) return undefined;
  const writes: SubRunFacts['writes'] = [];
  const wf = join(dir, 'writes.jsonl');
  if (existsSync(wf)) {
    const last = new Map<string, { state: string; object: string; reason?: string }>();
    for (const line of readFileSync(wf, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        // WriteLedger line: { key, state, recordId?, error?, write?: { object, … } } (src/security/idempotency.ts)
        const w = JSON.parse(line) as { key?: string; state?: string; error?: string; write?: { object?: string } };
        if (w.key)
          last.set(w.key, {
            state: w.state ?? '?',
            object: w.write?.object ?? last.get(w.key)?.object ?? '?',
            ...(w.error ? { reason: w.error } : {}),
          });
      } catch {
        /* torn line */
      }
    }
    writes.push(...last.values());
  }
  let cleanup: string | undefined;
  const cf = join(dir, 'cleanup-report.json');
  if (existsSync(cf)) cleanup = (JSON.parse(readFileSync(cf, 'utf8')) as { status?: string }).status;
  return { dir, writes, ...(cleanup ? { cleanup } : {}) };
}

/** Did the test's own data setup work? (writes.jsonl / cleanup-report of every attempt.) */
export function dataLedgerCheck(env: ExperimentEnv, r: TestResult): ExperimentRun {
  const q = 'Did the test data setup succeed and was it cleaned up?';
  const subs = subRunDirs(env.sourceRunDir, r)
    .map(readSubRun)
    .filter((s): s is SubRunFacts => Boolean(s));
  if (!subs.length) return skipped(env, 'soql-ledger', q, 'no data sub-run for this test (it created no data)');
  const failed = subs.flatMap((s) => s.writes.filter((w) => w.state === 'FAILED' || w.state === 'UNCERTAIN'));
  const confirmed = subs.reduce(
    (n, s) => n + s.writes.filter((w) => w.state === 'CONFIRMED' || w.state === 'CLEANED').length,
    0,
  );
  const notClean = subs.filter((s) => s.cleanup && s.cleanup !== 'CLEAN');
  const sources = subs.flatMap((s) => [fileSource(env.root, join(s.dir, 'writes.jsonl'))]);
  const data = {
    attempts: subs.length,
    confirmed,
    failed: failed.map((f) => `${f.object}: ${f.reason ?? f.state}`),
    notClean: notClean.length,
  };
  if (failed.length) {
    return mk(env, 'soql-ledger', q, 'SUPPORTS', `data setup failed: ${data.failed.join('; ')}`, sources, data);
  }
  return mk(
    env,
    'soql-ledger',
    q,
    'REFUTES',
    `${confirmed} write(s) confirmed in ${subs.length} attempt(s); cleanup ${notClean.length ? 'NOT clean' : 'clean'}`,
    sources,
    data,
  );
}

// ---------------------------------------------------------------- snapshot / rules / permissions

export function snapshotDiff(env: ExperimentEnv, caseId: string): ExperimentRun {
  const q = 'Did an org component the spec depends on change since it was built?';
  const f = env.providers.staleComponents;
  if (!f) return skipped(env, 'snapshot-diff', q, 'no snapshot store');
  const changed = f(caseId);
  return mk(
    env,
    'snapshot-diff',
    q,
    changed.length ? 'SUPPORTS' : 'REFUTES',
    changed.length ? `changed since build: ${changed.join(', ')}` : 'no dependency changed since the spec was built',
    [{ type: 'config', ref: `spec dependencies of ${caseId} vs latest snapshot / locator registry` }],
    { changed },
  );
}

export function validationRuleCheck(
  env: ExperimentEnv,
  objects: readonly string[],
  sfCode: string | undefined,
): ExperimentRun {
  const q = 'Which active validation rules could reject the data?';
  const f = env.providers.validationRules;
  if (!f) return skipped(env, 'validation-rule-check', q, 'no snapshot store');
  const rules = objects.flatMap((o) => f(o).map((r) => `${o}.${r.name}`));
  return mk(
    env,
    'validation-rule-check',
    q,
    rules.length && sfCode === 'FIELD_CUSTOM_VALIDATION_EXCEPTION' ? 'SUPPORTS' : 'INCONCLUSIVE',
    rules.length ? `active rules: ${rules.join(', ')}` : 'no active validation rule on these objects',
    [{ type: 'config', ref: `active ValidationRule on ${objects.join(', ')} (latest snapshot)` }],
    { rules },
  );
}

export async function permissionCheck(env: ExperimentEnv, objects: readonly string[]): Promise<ExperimentRun> {
  const q = 'Does the persona have the object access the test needs?';
  const f = env.providers.access;
  if (!f) return skipped(env, 'permission-check', q, 'no org connection');
  const missing: string[] = [];
  const facts: Record<string, unknown> = {};
  for (const o of objects) {
    try {
      const a = await f(o);
      facts[o] = a ?? 'not accessible';
      if (!a) missing.push(`${o}: not accessible`);
      else if (!a.createable || !a.queryable) missing.push(`${o}: ${!a.queryable ? 'read' : 'create'} denied`);
    } catch (e) {
      missing.push(`${o}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return mk(
    env,
    'permission-check',
    q,
    missing.length ? 'SUPPORTS' : 'REFUTES',
    missing.length ? `missing access: ${missing.join('; ')}` : `persona can read/create ${objects.join(', ')}`,
    [{ type: 'api', ref: `describe ${objects.join(', ')} as the persona` }],
    { missing, access: facts },
  );
}

// ---------------------------------------------------------------- ARIA locate (offline: Playwright error-context)

export interface AriaNode {
  role: string;
  name: string;
  line: number;
}

/** Parse the ARIA YAML block of Playwright's error-context.md into (role, name) nodes. */
export function parseAriaSnapshot(md: string): AriaNode[] {
  const out: AriaNode[] = [];
  const lines = md.split('\n');
  let inYaml = false;
  lines.forEach((l, i) => {
    if (/^```yaml/.test(l)) inYaml = true;
    else if (/^```/.test(l)) inYaml = false;
    else if (inYaml) {
      const m = /^\s*-\s+([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?/.exec(l);
      if (m?.[1] && m[1] !== 'text') out.push({ role: m[1], name: (m[2] ?? '').replace(/\\"/g, '"'), line: i + 1 });
    }
  });
  return out;
}

/** Target of the innermost locator segment: role + name, or label / text. */
export function locatorTarget(
  expr: string,
): { role?: string; name?: string; label?: string; text?: string } | undefined {
  const segs = [
    ...expr.matchAll(/getBy(Role|Label|Text|Placeholder|Title)\(\s*'([^']*)'(?:\s*,\s*\{([^}]*)\})?\s*\)/g),
  ];
  const last = segs[segs.length - 1];
  if (!last) return undefined;
  const [, kind, first, opts] = last;
  if (kind === 'Role') {
    const name = /name:\s*'([^']*)'/.exec(opts ?? '')?.[1] ?? /name:\s*\/(.*?)\/\w*/.exec(opts ?? '')?.[1];
    return { role: first ?? '', ...(name !== undefined ? { name } : {}) };
  }
  if (kind === 'Label' || kind === 'Placeholder' || kind === 'Title') return { label: first ?? '' };
  return { text: first ?? '' };
}

const tokens = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
/** Token Jaccard similarity of two accessible names (0–1). */
export function nameSimilarity(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size && !y.size) return 1;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

const FIELD_ROLES = new Set(['textbox', 'combobox', 'spinbutton', 'checkbox', 'searchbox']);

export interface AriaLocateResult {
  originalPresent: boolean;
  candidates: { role: string; name: string; similarity: number; line: number }[];
}

export function ariaLocateIn(nodes: readonly AriaNode[], expr: string): AriaLocateResult | undefined {
  const t = locatorTarget(expr);
  if (!t) return undefined;
  const wantName = t.name ?? t.label ?? t.text ?? '';
  // A locator without a name (getByRole('status')) cannot be matched by name: no candidates.
  if (!wantName) return { originalPresent: false, candidates: [] };
  const roleOk = (role: string): boolean => (t.role ? role === t.role : t.label ? FIELD_ROLES.has(role) : true);
  const originalPresent = nodes.some((n) => roleOk(n.role) && n.name === wantName);
  const candidates = nodes
    .filter((n) => roleOk(n.role) && n.name !== wantName && n.name)
    .map((n) => ({ role: n.role, name: n.name, similarity: nameSimilarity(wantName, n.name), line: n.line }))
    .filter((c) => c.similarity >= 0.34 || c.name.toLowerCase().includes(wantName.toLowerCase()))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5);
  return { originalPresent, candidates };
}

/**
 * A candidate strong enough to call the element renamed: the new name contains the old one ("Save" → "Save Record")
 * or the names are very similar. "Edit Title" → "Edit" is NOT strong: a shorter name may be another element
 * (run-p7-fx-base-2, TC-036: the record-level Edit button).
 */
export function isStrongCandidate(oldName: string, c: { name: string; similarity: number }): boolean {
  return c.name.toLowerCase().includes(oldName.toLowerCase()) || c.similarity >= 0.67;
}

export function ariaLocate(env: ExperimentEnv, r: TestResult, signals: readonly FailureSignal[]): ExperimentRun {
  const q = 'Is the element the test looked for on the page (same or similar name) at the moment of failure?';
  const locator = signals.find((s) => s.locator)?.locator;
  if (!locator) return skipped(env, 'aria-locate', q, 'no locator in the error');
  const rel = r.failure?.errorContext;
  if (!rel) return skipped(env, 'aria-locate', q, 'no error-context (ARIA snapshot) attached to the failure');
  const file = join(env.sourceRunDir, rel);
  if (!existsSync(file)) return skipped(env, 'aria-locate', q, `error-context not found: ${rel}`);
  const nodes = parseAriaSnapshot(readFileSync(file, 'utf8'));
  const found = ariaLocateIn(nodes, locator);
  if (!found) return skipped(env, 'aria-locate', q, `locator not parseable: ${locator}`);
  const src = [fileSource(env.root, file, 'aria')];
  const data = { locator, originalPresent: found.originalPresent, candidates: found.candidates };
  if (found.originalPresent) {
    return mk(
      env,
      'aria-locate',
      q,
      'REFUTES',
      `element with the expected name is on the page (late or covered, not renamed)`,
      src,
      data,
    );
  }
  const t = locatorTarget(locator);
  const oldName = t?.name ?? t?.label ?? t?.text ?? '';
  const strong = found.candidates.filter((c) => isStrongCandidate(oldName, c));
  if (!strong.length && found.candidates.length) {
    const c = found.candidates[0];
    return mk(
      env,
      'aria-locate',
      q,
      'INCONCLUSIVE',
      `not on the page; only weak matches (best: ${c?.role} "${c?.name}", similarity ${c?.similarity.toFixed(2)})`,
      src,
      data,
    );
  }
  if (strong.length) {
    const c = strong[0];
    return mk(
      env,
      'aria-locate',
      q,
      'SUPPORTS',
      `not on the page; similar: ${c?.role} "${c?.name}" (similarity ${c?.similarity.toFixed(2)})`,
      src,
      data,
    );
  }
  return mk(env, 'aria-locate', q, 'INCONCLUSIVE', 'not on the page and no similar element', src, data);
}

// ---------------------------------------------------------------- reruns

const firstLine = (r: TestResult | undefined): string =>
  (r?.failure?.attempts[r.failure.attempts.length - 1]?.message ?? r?.errorSummary ?? r?.reason ?? '')
    .split('\n')[0]
    ?.trim() ?? '';

export async function rerunFreshData(
  env: ExperimentEnv,
  r: TestResult,
): Promise<{ run: ExperimentRun; reruns: RerunOutcome[] }> {
  const q = `Does the failure reproduce with fresh data (${env.reproductions}×, same persona)?`;
  const f = env.providers.rerun;
  if (!f || !r.caseId) return { run: skipped(env, 'rerun-fresh-data', q, 'no runner available'), reruns: [] };
  const reruns: RerunOutcome[] = [];
  for (let i = 1; i <= env.reproductions; i++) reruns.push(await f({ caseId: r.caseId, label: `repro${i}` }));
  const states = reruns.map((x) => x.result?.state ?? 'NO_RESULT');
  const same = reruns.filter((x) => x.result?.state === 'FAIL' && firstLine(x.result) === firstLine(r)).length;
  const sources: SourceRef[] = reruns.map((x) => ({
    type: 'result',
    ref: `${x.runId}/${r.caseId}: ${x.result?.state ?? 'no result'}`,
  }));
  const data = { states, sameFailure: same, runIds: reruns.map((x) => x.runId) };
  if (same === reruns.length)
    return {
      run: mk(
        env,
        'rerun-fresh-data',
        q,
        'SUPPORTS',
        `reproduced ${same}/${reruns.length} with the same error`,
        sources,
        data,
      ),
      reruns,
    };
  if (states.every((s) => s === 'PASS'))
    return {
      run: mk(
        env,
        'rerun-fresh-data',
        q,
        'REFUTES',
        `passed ${reruns.length}/${reruns.length} on rerun`,
        sources,
        data,
      ),
      reruns,
    };
  return { run: mk(env, 'rerun-fresh-data', q, 'INCONCLUSIVE', `mixed: ${states.join(', ')}`, sources, data), reruns };
}

export async function rerunExtendedWaits(env: ExperimentEnv, r: TestResult): Promise<ExperimentRun> {
  const q = `Does the test pass when only the waits are ${env.waitFactor}× longer (assertions unchanged)?`;
  const f = env.providers.rerun;
  if (!f || !r.caseId) return skipped(env, 'rerun-extended-waits', q, 'no runner available');
  const x = await f({ caseId: r.caseId, label: 'waits', waitFactor: env.waitFactor });
  const state = x.result?.state ?? 'NO_RESULT';
  return mk(
    env,
    'rerun-extended-waits',
    q,
    state === 'PASS' ? 'SUPPORTS' : state === 'FAIL' ? 'REFUTES' : 'INCONCLUSIVE',
    `with ${env.waitFactor}× waits: ${state}${state === 'FAIL' ? ` (${firstLine(x.result)})` : ''}`,
    [{ type: 'result', ref: `${x.runId}/${r.caseId}: ${state}` }],
    { state, runId: x.runId },
  );
}

export async function flakyReruns(env: ExperimentEnv, r: TestResult): Promise<ExperimentRun> {
  const q = `Is the result non-deterministic across ${env.flakyReruns} unchanged reruns?`;
  const f = env.providers.rerun;
  if (!f || !r.caseId) return skipped(env, 'flaky-reruns', q, 'no runner available');
  const xs: RerunOutcome[] = [];
  for (let i = 1; i <= env.flakyReruns; i++) xs.push(await f({ caseId: r.caseId, label: `flaky${i}` }));
  const states = xs.map((x) => x.result?.state ?? 'NO_RESULT');
  const mixed = states.includes('PASS') && states.includes('FAIL');
  return mk(
    env,
    'flaky-reruns',
    q,
    mixed ? 'SUPPORTS' : 'REFUTES',
    `states: ${states.join(', ')}`,
    xs.map((x) => ({ type: 'result' as const, ref: `${x.runId}/${r.caseId}: ${x.result?.state ?? 'no result'}` })),
    { states },
  );
}

export async function apiReproduce(env: ExperimentEnv, caseId: string | undefined): Promise<ExperimentRun> {
  const q = 'Does the failing behaviour reproduce through the REST API (excluding UI causes)?';
  const f = env.providers.apiReproduce;
  if (!f || !caseId) return skipped(env, 'api-reproduce', q, 'no API reproduction for this case');
  try {
    const x = await f(caseId);
    if (!x) return skipped(env, 'api-reproduce', q, 'no API reproduction registered for this case');
    return mk(
      env,
      'api-reproduce',
      q,
      x.reproduced ? 'SUPPORTS' : 'REFUTES',
      x.detail,
      x.sources?.length ? x.sources : [querySource('api', `api reproduction of ${caseId}`, x.data ?? {})],
      { reproduced: x.reproduced, ...(x.data ?? {}) },
    );
  } catch (e) {
    return mk(env, 'api-reproduce', q, 'ERROR', e instanceof Error ? e.message : String(e), [
      { type: 'api', ref: `api reproduction of ${caseId}` },
    ]);
  }
}
