import { isAssertable, type EvidenceLevel, type ExpectedResult } from '../core/schemas/index.js';
import type { EvidenceIndex, EvidenceRecord } from './evidenceIndex.js';

export interface LevelDecision {
  level: EvidenceLevel;
  evidenceIds: string[];
  /** Why (shown as review reason when not assertable). */
  reason: string;
  /** Raw citations that do not exist in the index (never silently dropped). */
  unknownIds: string[];
}

/**
 * Evidence level of an expectation from what it cites (PLAN.md §7f). Code decides; the model never sets a level.
 * - anything cited UNKNOWN_OR_CONTRADICTORY → UNKNOWN_OR_CONTRADICTORY (a contradiction is never outvoted)
 * - else DECLARED_CONFIG if any org fact/component is cited, else APPROVED_REQUIREMENT if an approved section is cited
 * - else OBSERVED_ONLY (UI observation / manual test only); nothing citable → UNKNOWN_OR_CONTRADICTORY
 * VERIFIED needs UI + SOQL agreement from an executed run and is not assigned before Phase 5.
 */
export function assignLevel(index: EvidenceIndex, cited: readonly string[]): LevelDecision {
  const unknownIds: string[] = [];
  const found: EvidenceRecord[] = [];
  for (const raw of cited) {
    const rec = index.get(raw);
    if (!rec) unknownIds.push(raw);
    else if (!found.some((f) => f.id === rec.id)) found.push(rec);
  }
  const evidenceIds = found.map((f) => f.id);
  if (!found.length) {
    return {
      level: 'UNKNOWN_OR_CONTRADICTORY',
      evidenceIds,
      reason: unknownIds.length ? `cited evidence not found: ${unknownIds.join(', ')}` : 'no evidence cited',
      unknownIds,
    };
  }
  const bad = found.filter((f) => f.level === 'UNKNOWN_OR_CONTRADICTORY');
  if (bad.length) {
    return {
      level: 'UNKNOWN_OR_CONTRADICTORY',
      evidenceIds,
      reason: bad.map((b) => `${b.id}: ${b.reason}`).join('; '),
      unknownIds,
    };
  }
  const pick = (lvl: EvidenceLevel): EvidenceRecord[] => found.filter((f) => f.level === lvl);
  for (const lvl of ['DECLARED_CONFIG', 'APPROVED_REQUIREMENT', 'OBSERVED_ONLY'] as const) {
    const hit = pick(lvl);
    if (hit.length) {
      return { level: lvl, evidenceIds, reason: hit.map((h) => `${h.id}: ${h.reason}`).join('; '), unknownIds };
    }
  }
  return { level: 'UNKNOWN_OR_CONTRADICTORY', evidenceIds, reason: 'no assertable evidence', unknownIds };
}

export function expectedFrom(
  index: EvidenceIndex,
  text: string,
  cited: readonly string[],
): { expected: ExpectedResult; decision: LevelDecision } {
  const decision = assignLevel(index, cited);
  return { expected: { text, evidenceLevel: decision.level, evidenceIds: decision.evidenceIds }, decision };
}

export interface CaseStatusInput {
  steps: readonly { expected: ExpectedResult }[];
  /** Per-step reasons from assignLevel (same order as steps). */
  stepReasons?: readonly string[];
  personaAvailable: boolean;
  persona: string;
  extraReasons?: readonly string[];
}

/**
 * Review status decided by code: a missing persona blocks the case; any non-assertable expectation makes it
 * REVIEW_REQUIRED; otherwise APPROVED (the Reviewer may still downgrade it).
 */
export function caseStatus(i: CaseStatusInput): {
  reviewStatus: 'APPROVED' | 'REVIEW_REQUIRED' | 'BLOCKED';
  reviewReasons: string[];
} {
  const reasons: string[] = [];
  if (!i.personaAvailable) reasons.push(`BLOCKED-NO-PERSONA: no test user for persona "${i.persona}"`);
  i.steps.forEach((s, n) => {
    if (!isAssertable(s.expected.evidenceLevel)) {
      reasons.push(
        `step ${String(n + 1)} ${s.expected.evidenceLevel}${i.stepReasons?.[n] ? `: ${i.stepReasons[n]}` : ''}`,
      );
    }
  });
  reasons.push(...(i.extraReasons ?? []));
  if (!i.personaAvailable) return { reviewStatus: 'BLOCKED', reviewReasons: reasons };
  return { reviewStatus: reasons.length ? 'REVIEW_REQUIRED' : 'APPROVED', reviewReasons: reasons };
}
