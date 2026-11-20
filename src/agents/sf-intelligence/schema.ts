import { z } from 'zod';

/**
 * Org cross-check of requirements against a discovery snapshot (requirement-analysis skill, step 4). Every result is
 * produced deterministically from snapshot components; nothing here is model output. Results never become assertions
 * by themselves — they are evidence (DECLARED_CONFIG) or open questions (UNKNOWN_OR_CONTRADICTORY).
 */
export const OrgCheckKind = z.enum([
  'existence',
  'required',
  'format',
  'duplicate-rule',
  'persona',
  'permission',
  'picklist-value',
  'mechanism',
  'allowed-values',
]);
export type OrgCheckKind = z.infer<typeof OrgCheckKind>;

export const OrgCheckResult = z.enum([
  /** The component exists (and matches where a property was claimed). */
  'EXISTS',
  /** The org configuration agrees with the requirement. */
  'CONSISTENT',
  /** Not found although the scope it would live in was fully readable. */
  'NOT_FOUND',
  /** The org does not enforce / contradicts what the requirement states. */
  'CONFLICT',
  /** Could not decide (area unreadable, object outside the discovery scope, …). */
  'UNKNOWN',
]);
export type OrgCheckResult = z.infer<typeof OrgCheckResult>;

export const OrgCheckEvidence = z.object({
  componentType: z.string(),
  apiName: z.string(),
  detail: z.string(),
});

export const OrgCheck = z.object({
  id: z.string(),
  check: OrgCheckKind,
  /** What was checked, in plain words ("Account.Number_of_Contacts__c exists"). */
  subject: z.string(),
  result: OrgCheckResult,
  /** DECLARED_CONFIG when the org metadata settles it; UNKNOWN_OR_CONTRADICTORY otherwise (PLAN.md §7f). */
  evidenceLevel: z.enum(['DECLARED_CONFIG', 'UNKNOWN_OR_CONTRADICTORY']),
  /** What the org shows today (used verbatim in questions). */
  orgFact: z.string(),
  evidence: z.array(OrgCheckEvidence),
  requirementIds: z.array(z.string()),
  /** Section refs from the requirement sources (AC5, BR-09 …). */
  refs: z.array(z.string()),
  findingIds: z.array(z.string()).default([]),
  /** A clarification question when the result is not settled (≤ 1 per check). */
  question: z.string().optional(),
  snapshotId: z.string(),
  environment: z.enum(['LIVE', 'FIXTURE']),
});
export type OrgCheck = z.infer<typeof OrgCheck>;

export const OrgCrossCheck = z.object({
  snapshotId: z.string(),
  orgId: z.string(),
  environment: z.enum(['LIVE', 'FIXTURE']),
  objects: z.array(z.string()),
  checks: z.array(OrgCheck),
  counts: z.record(OrgCheckResult, z.number()),
});
export type OrgCrossCheck = z.infer<typeof OrgCrossCheck>;
