// Deterministic part of the Defect Judge standard (defect-investigation SKILL): every item must hold before a defect
// can be CONFIRMED; the judge model only checks that the bug text says nothing the evidence does not.
import type { Experiment, Investigation, JudgeGate } from '../../core/schemas/index.js';

const ASSERTABLE = new Set(['APPROVED_REQUIREMENT', 'DECLARED_CONFIG', 'VERIFIED']);
const ENV_SIGNALS = new Set(['HTTP_5XX', 'MAINTENANCE', 'LOGIN_PAGE', 'NETWORK_ERROR', 'LOCAL_ENVIRONMENT']);

const exp = (i: Investigation, k: Experiment['kind']): Experiment | undefined =>
  i.experiments.find((e) => e.kind === k);

export function judgeGate(
  i: Investigation,
  o: { reproductions: number; missingEvidence: readonly string[]; sanitized: boolean },
): JudgeGate {
  const fresh = exp(i, 'rerun-fresh-data');
  const same = typeof fresh?.data['sameFailure'] === 'number' ? fresh.data['sameFailure'] : 0;
  const api = exp(i, 'api-reproduce');
  const ledger = exp(i, 'soql-ledger');
  const identity = exp(i, 'identity-probe');
  const health = exp(i, 'health-probe');
  const trace = exp(i, 'requirement-trace');
  const gate = {
    reproducedTwiceFreshData: fresh?.outcome === 'SUPPORTS' && same >= o.reproductions,
    reproducedViaApi: api?.outcome === 'SUPPORTS',
    testDataRuledOut:
      !i.signals.some((s) => s.kind === 'DATA_SETUP_FAILED') &&
      (ledger?.outcome === 'REFUTES' || (ledger?.outcome === 'SKIPPED' && api?.data['caseOpenAndLinked'] === true)) &&
      (api === undefined || api.outcome === 'SKIPPED' || api.data['caseOpenAndLinked'] !== false),
    environmentRuledOut:
      identity?.outcome === 'REFUTES' &&
      health?.outcome === 'REFUTES' &&
      !i.signals.some((s) => ENV_SIGNALS.has(s.kind)),
    requirementTraced: trace?.outcome === 'REFUTES' && ASSERTABLE.has(String(trace.data['evidenceLevel'])),
    evidenceResolves: o.missingEvidence.length === 0,
    sanitized: o.sanitized,
  };
  const words: Record<keyof typeof gate, string> = {
    reproducedTwiceFreshData: `reproduced ${String(o.reproductions)}× with fresh data and the same persona`,
    reproducedViaApi: 'reproduced once through the API',
    testDataRuledOut: 'test data ruled out with evidence (setup confirmed, preconditions true)',
    environmentRuledOut: 'environment ruled out with evidence (identity + health probes, no environment signal)',
    requirementTraced: 'expected behaviour traced to an assertable requirement',
    evidenceResolves: `every evidence id resolves${o.missingEvidence.length ? ` (missing: ${o.missingEvidence.join(', ')})` : ''}`,
    sanitized: 'bug text unchanged by redaction (no secret / PII)',
  };
  return {
    ...gate,
    missing: (Object.keys(gate) as (keyof typeof gate)[]).filter((k) => !gate[k]).map((k) => words[k]),
  };
}

export const gatePassed = (g: JudgeGate): boolean => g.missing.length === 0;
