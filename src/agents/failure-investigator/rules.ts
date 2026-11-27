// Deterministic verdict rules (CLAUDE.md rule 15: deterministic checks before model judgement). Each rule reads the
// signals and the experiment outcomes and either decides (verdict + confidence + the evidence it rests on) or passes.
// First match wins. A PRODUCT_DEFECT verdict needs a reproduced failure of a stated, assertable expectation with
// environment and test data ruled out — never a single UI failure (defect-investigation SKILL, "Never").
import type { Experiment, ExperimentKind, FailureSignal, Hypothesis, Verdict } from '../../core/schemas/index.js';
import { hasSignal } from './signals.js';

export interface RuleDecision {
  rule: string;
  verdict: Verdict;
  confidence: number;
  rationale: string;
  evidenceIds: string[];
}

export type ExperimentMap = Partial<Record<ExperimentKind, Experiment>>;

const ASSERTABLE = new Set(['APPROVED_REQUIREMENT', 'DECLARED_CONFIG', 'VERIFIED']);

export function byKind(experiments: readonly Experiment[]): ExperimentMap {
  const m: ExperimentMap = {};
  for (const e of experiments) m[e.kind] = e;
  return m;
}

const is = (x: ExperimentMap, k: ExperimentKind, o: Experiment['outcome']): boolean => x[k]?.outcome === o;
const ev = (x: ExperimentMap, ...ks: ExperimentKind[]): string[] => ks.flatMap((k) => x[k]?.evidenceIds ?? []);

interface Rule {
  id: string;
  test: (s: readonly FailureSignal[], x: ExperimentMap) => RuleDecision | undefined;
}

const ENV_SIGNALS = ['HTTP_5XX', 'MAINTENANCE', 'LOGIN_PAGE', 'NETWORK_ERROR'] as const;

export const RULES: readonly Rule[] = [
  {
    id: 'R-ENV-1',
    test: (_s, x) =>
      is(x, 'identity-probe', 'SUPPORTS')
        ? {
            rule: 'R-ENV-1',
            verdict: 'ENVIRONMENT',
            confidence: 0.9,
            rationale: 'the identity check fails now (wrong or lost session)',
            evidenceIds: ev(x, 'identity-probe'),
          }
        : undefined,
  },
  {
    id: 'R-ENV-2',
    test: (_s, x) =>
      is(x, 'health-probe', 'SUPPORTS')
        ? {
            rule: 'R-ENV-2',
            verdict: 'ENVIRONMENT',
            confidence: 0.9,
            rationale: 'the org is unhealthy now (5xx / maintenance / unreachable)',
            evidenceIds: ev(x, 'health-probe'),
          }
        : undefined,
  },
  {
    id: 'R-ENV-3',
    test: (s, x) =>
      hasSignal(s, ...ENV_SIGNALS) && !hasSignal(s, 'DATA_SETUP_FAILED')
        ? {
            rule: 'R-ENV-3',
            verdict: 'ENVIRONMENT',
            confidence: is(x, 'rerun-fresh-data', 'REFUTES') ? 0.8 : 0.7,
            rationale: `the failure text shows an environment error (${s
              .filter((y) => (ENV_SIGNALS as readonly string[]).includes(y.kind))
              .map((y) => y.kind)
              .join(
                ', ',
              )}); the org answers normally now${is(x, 'rerun-fresh-data', 'REFUTES') ? ' and the rerun passed' : ''}`,
            evidenceIds: ev(x, 'health-probe', 'rerun-fresh-data'),
          }
        : undefined,
  },
  {
    id: 'R-PERM-1',
    test: (s, x) =>
      hasSignal(s, 'INSUFFICIENT_ACCESS') ||
      (is(x, 'permission-check', 'SUPPORTS') && hasSignal(s, 'LOCATOR_NOT_FOUND', 'DATA_SETUP_FAILED'))
        ? {
            rule: 'R-PERM-1',
            verdict: 'PERMISSION_CONFIG',
            confidence: is(x, 'permission-check', 'SUPPORTS') ? 0.9 : 0.75,
            rationale: `access denied for the persona${x['permission-check']?.outcome === 'SUPPORTS' ? `: ${x['permission-check'].result}` : ' (error text)'}`,
            evidenceIds: ev(x, 'permission-check'),
          }
        : undefined,
  },
  {
    id: 'R-DATA-1',
    test: (s, x) =>
      hasSignal(s, 'DATA_SETUP_FAILED', 'DUPLICATE_RULE') || is(x, 'soql-ledger', 'SUPPORTS')
        ? {
            rule: 'R-DATA-1',
            verdict: 'TEST_DATA',
            confidence: is(x, 'soql-ledger', 'SUPPORTS') && hasSignal(s, 'DATA_SETUP_FAILED') ? 0.9 : 0.8,
            rationale: `the test's own data setup failed before the step under test${
              x['validation-rule-check']?.outcome === 'SUPPORTS' ? ` (${x['validation-rule-check'].result})` : ''
            }${x['soql-ledger']?.outcome === 'SUPPORTS' ? `: ${x['soql-ledger'].result}` : ''}`,
            evidenceIds: ev(x, 'soql-ledger', 'validation-rule-check'),
          }
        : undefined,
  },
  {
    id: 'R-LOC-1',
    test: (s, x) =>
      hasSignal(s, 'LOCATOR_NOT_FOUND', 'LOCATOR_NOT_UNIQUE') && is(x, 'aria-locate', 'SUPPORTS')
        ? {
            rule: 'R-LOC-1',
            verdict: 'SCRIPT_LOCATOR',
            confidence: 0.85,
            rationale: `the element is not on the page under its old name, a similar one is: ${x['aria-locate']?.result ?? ''}`,
            evidenceIds: ev(x, 'aria-locate'),
          }
        : undefined,
  },
  {
    id: 'R-LOC-2',
    test: (s, x) =>
      hasSignal(s, 'LOCATOR_NOT_UNIQUE')
        ? {
            rule: 'R-LOC-2',
            verdict: 'SCRIPT_LOCATOR',
            confidence: 0.8,
            rationale: 'the locator matches more than one element (strict mode)',
            evidenceIds: ev(x, 'aria-locate'),
          }
        : undefined,
  },
  {
    id: 'R-TIME-1',
    test: (s, x) =>
      hasSignal(s, 'LOCATOR_NOT_FOUND', 'WAIT_TIMEOUT') && is(x, 'rerun-extended-waits', 'SUPPORTS')
        ? {
            rule: 'R-TIME-1',
            verdict: 'SCRIPT_TIMING',
            confidence: is(x, 'aria-locate', 'SUPPORTS') ? 0.7 : 0.85,
            rationale: `the test passes when only the waits are longer${is(x, 'aria-locate', 'REFUTES') ? '; the element was on the page, just late' : ''}`,
            evidenceIds: ev(x, 'rerun-extended-waits', 'aria-locate'),
          }
        : undefined,
  },
  {
    id: 'R-FLAKY-1',
    test: (_s, x) =>
      is(x, 'flaky-reruns', 'SUPPORTS')
        ? {
            rule: 'R-FLAKY-1',
            verdict: 'FLAKY',
            confidence: 0.8,
            rationale: `non-deterministic without changes: ${x['flaky-reruns']?.result ?? ''}`,
            evidenceIds: ev(x, 'flaky-reruns'),
          }
        : undefined,
  },
  {
    id: 'R-FLAKY-2',
    test: (s, x) =>
      hasSignal(s, 'PASSED_ON_RETRY') && is(x, 'rerun-fresh-data', 'REFUTES')
        ? {
            rule: 'R-FLAKY-2',
            verdict: 'FLAKY',
            confidence: 0.7,
            rationale: 'passed on Playwright retry and on the reruns',
            evidenceIds: ev(x, 'rerun-fresh-data'),
          }
        : undefined,
  },
  {
    id: 'R-STALE-1',
    test: (_s, x) =>
      is(x, 'snapshot-diff', 'SUPPORTS')
        ? {
            rule: 'R-STALE-1',
            verdict: 'STALE_KNOWLEDGE',
            confidence: 0.75,
            rationale: x['snapshot-diff']?.result ?? 'a dependency changed',
            evidenceIds: ev(x, 'snapshot-diff'),
          }
        : undefined,
  },
  {
    id: 'R-REQ-1',
    test: (s, x) =>
      hasSignal(s, 'ASSERTION_MISMATCH', 'URL_MISMATCH') &&
      is(x, 'requirement-trace', 'SUPPORTS') &&
      !is(x, 'rerun-fresh-data', 'REFUTES')
        ? {
            rule: 'R-REQ-1',
            verdict: 'INVALID_REQUIREMENT_ASSUMPTION',
            confidence: is(x, 'rerun-fresh-data', 'SUPPORTS') ? 0.85 : 0.75,
            rationale: `the failing expectation is not stated by its sources (${typeof x['requirement-trace']?.data['gap'] === 'string' ? x['requirement-trace'].data['gap'] : ''})${
              is(x, 'rerun-fresh-data', 'SUPPORTS') ? '; the org behaves the same on every rerun' : ''
            }`,
            evidenceIds: ev(x, 'requirement-trace', 'rerun-fresh-data'),
          }
        : undefined,
  },
  {
    id: 'R-DEF-1',
    test: (s, x) => {
      const trace = x['requirement-trace'];
      const stated = trace?.outcome === 'REFUTES' && ASSERTABLE.has(String(trace.data['evidenceLevel']));
      const envOk = !is(x, 'health-probe', 'SUPPORTS') && !hasSignal(s, ...ENV_SIGNALS);
      const dataOk = !is(x, 'soql-ledger', 'SUPPORTS') && !hasSignal(s, 'DATA_SETUP_FAILED');
      if (!(
        hasSignal(s, 'ASSERTION_MISMATCH', 'URL_MISMATCH') &&
        stated &&
        is(x, 'rerun-fresh-data', 'SUPPORTS') &&
        envOk &&
        dataOk
      ))
        return undefined;
      const api = is(x, 'api-reproduce', 'SUPPORTS');
      return {
        rule: 'R-DEF-1',
        verdict: 'PRODUCT_DEFECT',
        confidence: api ? 0.9 : 0.75,
        rationale: `a stated ${String(trace.data['evidenceLevel'])} expectation fails on every fresh-data rerun${api ? ' and through the API' : ''}; environment and test data ruled out`,
        evidenceIds: ev(x, 'requirement-trace', 'rerun-fresh-data', 'api-reproduce', 'health-probe', 'soql-ledger'),
      };
    },
  },
];

export function decide(
  signals: readonly FailureSignal[],
  experiments: readonly Experiment[],
): RuleDecision | undefined {
  const x = byKind(experiments);
  for (const r of RULES) {
    const d = r.test(signals, x);
    if (d) return d;
  }
  return undefined;
}

/** 3–5 competing hypotheses from the signals (defect-investigation SKILL: never only one). */
export function hypothesesFor(signals: readonly FailureSignal[]): Hypothesis[] {
  const hs: { verdict: Verdict; text: string; test: string }[] = [];
  const add = (verdict: Verdict, text: string, test: string): void => {
    if (!hs.some((h) => h.verdict === verdict)) hs.push({ verdict, text, test });
  };
  if (hasSignal(signals, ...ENV_SIGNALS))
    add('ENVIRONMENT', 'The org or network was unavailable', 'identity + health probe');
  if (hasSignal(signals, 'DATA_SETUP_FAILED', 'VALIDATION_ERROR', 'DUPLICATE_RULE'))
    add('TEST_DATA', 'The test data violates an org rule', 'data ledger + active validation rules');
  if (hasSignal(signals, 'INSUFFICIENT_ACCESS'))
    add('PERMISSION_CONFIG', 'The persona lacks access', 'object access as the persona');
  if (hasSignal(signals, 'LOCATOR_NOT_FOUND', 'LOCATOR_NOT_UNIQUE')) {
    add('SCRIPT_LOCATOR', 'The element was renamed or moved', 'ARIA snapshot at failure');
    add('SCRIPT_TIMING', 'The element appeared too late', 'rerun with longer waits');
  }
  if (hasSignal(signals, 'WAIT_TIMEOUT')) add('SCRIPT_TIMING', 'A wait was too short', 'rerun with longer waits');
  if (hasSignal(signals, 'ASSERTION_MISMATCH', 'URL_MISMATCH')) {
    add('PRODUCT_DEFECT', 'The org does not behave as the requirement states', 'fresh-data reruns + API reproduction');
    add(
      'INVALID_REQUIREMENT_ASSUMPTION',
      'The expectation is an assumption the org contradicts',
      'trace the expectation to its sources',
    );
  }
  if (hasSignal(signals, 'PASSED_ON_RETRY', 'DIFFERENT_FAILURE_ON_RETRY'))
    add('FLAKY', 'The result is non-deterministic', 'unchanged reruns');
  // Always keep competing explanations across the taxonomy.
  add('STALE_KNOWLEDGE', 'An org component changed after the spec was built', 'snapshot / locator diff');
  add('ENVIRONMENT', 'The org or network was unavailable', 'identity + health probe');
  add('TEST_DATA', 'The test data was wrong for this org', 'data ledger');
  return hs
    .slice(0, 5)
    .map((h, i) => ({
      id: `H${i + 1}`,
      text: h.text,
      test: h.test,
      evidenceIds: [],
      verdict: h.verdict,
      status: 'OPEN' as const,
    }));
}

/** Map experiment outcomes onto the hypotheses (SUPPORTED / REFUTED / INCONCLUSIVE). */
export function scoreHypotheses(
  hs: readonly Hypothesis[],
  experiments: readonly Experiment[],
  decided?: RuleDecision,
): Hypothesis[] {
  const x = byKind(experiments);
  const map: Partial<Record<Verdict, ExperimentKind[]>> = {
    ENVIRONMENT: ['health-probe', 'identity-probe'],
    TEST_DATA: ['soql-ledger'],
    PERMISSION_CONFIG: ['permission-check'],
    SCRIPT_LOCATOR: ['aria-locate'],
    SCRIPT_TIMING: ['rerun-extended-waits'],
    PRODUCT_DEFECT: ['rerun-fresh-data', 'api-reproduce'],
    INVALID_REQUIREMENT_ASSUMPTION: ['requirement-trace'],
    STALE_KNOWLEDGE: ['snapshot-diff'],
    FLAKY: ['flaky-reruns'],
  };
  return hs.map((h) => {
    if (!h.verdict) return h;
    const kinds = map[h.verdict] ?? [];
    const exps = kinds.map((k) => x[k]).filter((e): e is Experiment => Boolean(e) && e?.outcome !== 'SKIPPED');
    let status: Hypothesis['status'] = 'OPEN';
    if (decided?.verdict === h.verdict) status = 'SUPPORTED';
    else if (h.verdict === 'PRODUCT_DEFECT' && is(x, 'requirement-trace', 'SUPPORTS')) status = 'REFUTED';
    else if (h.verdict === 'INVALID_REQUIREMENT_ASSUMPTION' && is(x, 'requirement-trace', 'REFUTES'))
      status = 'REFUTED';
    else if (exps.some((e) => e.outcome === 'SUPPORTS') && h.verdict !== 'PRODUCT_DEFECT') status = 'SUPPORTED';
    else if (exps.length && exps.every((e) => e.outcome === 'REFUTES')) status = 'REFUTED';
    else if (exps.length) status = 'INCONCLUSIVE';
    if (decided && decided.verdict !== h.verdict && status === 'SUPPORTED') status = 'INCONCLUSIVE';
    return {
      ...h,
      status,
      evidenceIds: exps.flatMap((e) => e.evidenceIds),
      ...(exps.length ? { result: exps.map((e) => `${e.kind}: ${e.outcome} — ${e.result}`).join('; ') } : {}),
    };
  });
}
