// Execution gate (Phase 5 runner contract): which generated specs may run. Only APPROVED, non-stale specs with a
// dependency record execute; a stale spec is BLOCKED with "stale: <component> changed in <snapshot>" and never runs.
import type { GeneratedArtifact } from '../core/schemas/generation.js';
import { staleReason } from '../agents/test-generator/staleness.js';

/** NOT_SELECTED = APPROVED and current, but left out of this run by `--cases`. */
export type GateDecision = 'EXECUTE' | 'BLOCKED' | 'NOT_APPROVED' | 'MANUAL' | 'NOT_SELECTED';

export interface GateItem {
  caseId: string;
  path?: string;
  decision: GateDecision;
  reason: string;
}

export function executionPlan(manifest: {
  artifacts: readonly GeneratedArtifact[];
  manualOnly?: readonly { caseId: string; reason: string }[];
}): GateItem[] {
  const items: GateItem[] = [];
  for (const a of manifest.artifacts.filter((x) => x.kind === 'spec')) {
    const caseId = a.testCaseIds[0] ?? '';
    const base = { caseId, path: a.path };
    if (a.stale) items.push({ ...base, decision: 'BLOCKED', reason: staleReason(a.stale) });
    else if (!a.dependsOn)
      items.push({
        ...base,
        decision: 'BLOCKED',
        reason: 'staleness unknown: no dependency record (built before tracking) — rebuild the spec',
      });
    else if (a.reviewStatus !== 'APPROVED')
      items.push({ ...base, decision: 'NOT_APPROVED', reason: `review status ${a.reviewStatus ?? 'none'}` });
    else items.push({ ...base, decision: 'EXECUTE', reason: 'APPROVED, dependencies current' });
  }
  for (const m of manifest.manualOnly ?? []) items.push({ caseId: m.caseId, decision: 'MANUAL', reason: m.reason });
  return items.sort((x, y) => x.caseId.localeCompare(y.caseId));
}
