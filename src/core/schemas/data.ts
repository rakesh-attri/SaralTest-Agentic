import { z } from 'zod';
import { Environment, IsoDate, OrgId18 } from './common.js';

// ------------------------------------------------------------------ write ledger (PLAN.md §4, §7e)

/**
 * PLANNED → SENT → CONFIRMED → CLEANED. SENT → UNCERTAIN after a timeout/crash (reconciled by query, never
 * blind-retried). SENT → FAILED when Salesforce rejected the write (nothing was created).
 */
export const DataWriteState = z.enum(['PLANNED', 'SENT', 'CONFIRMED', 'UNCERTAIN', 'FAILED', 'CLEANED']);
export type DataWriteState = z.infer<typeof DataWriteState>;

export const DataWrite = z.object({
  idempotencyKey: z.string().min(8),
  runId: z.string(),
  object: z.string(),
  plannedFields: z.record(z.string(), z.unknown()),
  recordId: z.string().optional(),
  state: DataWriteState,
  /** Data-plan step (recipe alias) this write belongs to. */
  step: z.string().optional(),
  /** Creation order; cleanup runs in reverse. */
  order: z.number().int().nonnegative().optional(),
  /** Step id of the parent record (lookup), when any. */
  parentRef: z.string().optional(),
  /** Salesforce error of a FAILED write (redacted). */
  error: z.string().optional(),
});
export type DataWrite = z.infer<typeof DataWrite>;

/** Ledger entry for a record this run created. */
export const CreatedRecord = z.object({
  idempotencyKey: z.string(),
  object: z.string(),
  recordId: z.string(),
  createdAt: IsoDate,
  order: z.number().int().nonnegative(),
  step: z.string().optional(),
  /** api = created by the data engine; ui = created by a test through the UI and adopted (tagged) afterwards. */
  via: z.enum(['api', 'ui']).default('api'),
});
export type CreatedRecord = z.infer<typeof CreatedRecord>;

export const AuditEntry = z.object({
  at: IsoDate,
  runId: z.string(),
  orgId: z.string(),
  user: z.string(),
  persona: z.string(),
  action: z.enum(['observe', 'mutate']),
  tool: z.string(),
  object: z.string().optional(),
  recordId: z.string().optional(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  approvalId: z.string().optional(),
  outcome: z.enum(['ALLOWED', 'REFUSED', 'SUCCEEDED', 'FAILED']).optional(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

// ------------------------------------------------------------------ recipes (examples/recipes/*.yaml)

const ApiName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'Salesforce API name');
export const RecipeValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type RecipeValue = z.infer<typeof RecipeValue>;

export const RecipeObject = z.object({
  object: ApiName,
  /** Step id; defaults to the object name. Parents are referenced by it. */
  alias: ApiName.optional(),
  recordType: z.string().nullable().default(null),
  parent: z.object({ field: ApiName, ref: ApiName }).optional(),
  /** Business-approved values; `{synthetic}` and `{runId}` are placeholders filled by the engine. */
  fields: z.record(ApiName, RecipeValue),
});
export type RecipeObject = z.infer<typeof RecipeObject>;

export const NegativeVariant = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/),
  /** Step id (alias) the variant is derived from. */
  object: ApiName,
  remove: z.array(ApiName).default([]),
  set: z.record(ApiName, RecipeValue).default({}),
  /** Negative data is only used to assert rejection (salesforce-test-data skill). */
  expect: z.literal('rejected'),
});
export type NegativeVariant = z.infer<typeof NegativeVariant>;

export const Recipe = z
  .object({
    recipe: z.string().regex(/^[a-z0-9-]+$/),
    approvedBy: z
      .string()
      .min(2)
      .refine((v) => !/^<.*>$/.test(v.trim()), 'approvedBy is still a placeholder: the recipe is not approved'),
    objects: z.array(RecipeObject).min(1),
    negativeVariants: z.array(NegativeVariant).default([]),
    cleanup: z.literal('reverse-dependency'),
  })
  .superRefine((r, ctx) => {
    const seen = new Set<string>();
    r.objects.forEach((o, i) => {
      const id = o.alias ?? o.object;
      if (seen.has(id)) ctx.addIssue({ code: 'custom', path: ['objects', i], message: `duplicate step id ${id}` });
      if (o.parent && !seen.has(o.parent.ref)) {
        ctx.addIssue({
          code: 'custom',
          path: ['objects', i, 'parent', 'ref'],
          message: `parent ${o.parent.ref} must be declared before ${id}`,
        });
      }
      seen.add(id);
    });
    r.negativeVariants.forEach((v, i) => {
      if (!seen.has(v.object)) {
        ctx.addIssue({ code: 'custom', path: ['negativeVariants', i, 'object'], message: `unknown step ${v.object}` });
      }
    });
  });
export type Recipe = z.infer<typeof Recipe>;

// ------------------------------------------------------------------ data plan

export const FieldSource = z.enum(['recipe', 'synthetic', 'run-tag', 'parent']);
export const PlanValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const DataPlanStep = z.object({
  stepId: z.string(),
  object: z.string(),
  order: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8),
  recordType: z.string().nullable().default(null),
  parent: z.object({ field: z.string(), stepId: z.string() }).optional(),
  /** Field values to send (the parent lookup is filled at create time from the parent's record id). */
  fields: z.record(z.string(), PlanValue),
  fieldSources: z.record(z.string(), FieldSource),
  /** A field whose value is unique to this write: used to reconcile UNCERTAIN writes and to adopt UI records. */
  uniqueKey: z.object({ field: z.string(), value: z.string() }),
});
export type DataPlanStep = z.infer<typeof DataPlanStep>;

export const DataPlanIssueCode = z.enum([
  'UNKNOWN_OBJECT',
  'OBJECT_NOT_CREATEABLE',
  'UNKNOWN_FIELD',
  'FIELD_NOT_CREATEABLE',
  'INVALID_PICKLIST_VALUE',
  'REQUIRED_FIELD_MISSING',
  'VALUE_TOO_LONG',
  'EMAIL_DOMAIN_NOT_ALLOWED',
  'RUN_TAG_FIELD_MISSING',
  'RUN_TAG_TOO_LONG',
  'NO_UNIQUE_KEY',
  'UNREADABLE_METADATA',
  'VALIDATION_RULE_REFERENCES_FIELD',
  'DUPLICATE_RULE_ACTIVE',
  'RECORD_TYPE_UNRESOLVED',
  'NEGATIVE_NOT_REJECTABLE',
]);
export type DataPlanIssueCode = z.infer<typeof DataPlanIssueCode>;

export const DataPlanIssue = z.object({
  severity: z.enum(['ERROR', 'WARNING']),
  code: DataPlanIssueCode,
  stepId: z.string().optional(),
  field: z.string().optional(),
  message: z.string(),
});
export type DataPlanIssue = z.infer<typeof DataPlanIssue>;

export const NegativePlan = z.object({
  name: z.string(),
  stepId: z.string(),
  object: z.string(),
  idempotencyKey: z.string().min(8),
  fields: z.record(z.string(), PlanValue),
  removed: z.array(z.string()),
  /** Error codes that count as the expected rejection (derived from metadata, e.g. REQUIRED_FIELD_MISSING). */
  expectedErrorCodes: z.array(z.string()).min(1),
});
export type NegativePlan = z.infer<typeof NegativePlan>;

export const DataPlan = z.object({
  recipe: z.string(),
  recipeHash: z.string(),
  approvedBy: z.string(),
  runId: z.string(),
  orgId: OrgId18,
  orgAlias: z.string(),
  environment: z.enum(['LIVE', 'FIXTURE']),
  snapshotId: z.string(),
  runTag: z.object({ field: z.string().nullable(), value: z.string() }),
  steps: z.array(DataPlanStep),
  negatives: z.array(NegativePlan).default([]),
  issues: z.array(DataPlanIssue).default([]),
  /** No ERROR issue. Only a valid plan may be executed. */
  valid: z.boolean(),
  createdAt: IsoDate,
});
export type DataPlan = z.infer<typeof DataPlan>;

// ------------------------------------------------------------------ verification + cleanup reports

export const FieldCheck = z.object({ field: z.string(), expected: z.unknown(), actual: z.unknown(), ok: z.boolean() });
export const RecordVerification = z.object({
  stepId: z.string(),
  object: z.string(),
  recordId: z.string(),
  checks: z.array(FieldCheck),
  ok: z.boolean(),
});
export type RecordVerification = z.infer<typeof RecordVerification>;

export const NegativeOutcome = z.object({
  name: z.string(),
  object: z.string(),
  outcome: z.enum(['REJECTED_AS_EXPECTED', 'REJECTED_OTHER_REASON', 'UNEXPECTEDLY_SAVED']),
  errorCodes: z.array(z.string()),
  message: z.string().optional(),
  /** Set when the record was saved anyway; it is adopted into the ledger and cleaned up. */
  recordId: z.string().optional(),
});
export type NegativeOutcome = z.infer<typeof NegativeOutcome>;

export const CleanupEntry = z.object({
  idempotencyKey: z.string(),
  stepId: z.string().optional(),
  object: z.string(),
  recordId: z.string(),
  action: z.enum(['DELETED', 'ALREADY_GONE', 'KEPT', 'REFUSED', 'FAILED']),
  reason: z.string().optional(),
});
export type CleanupEntry = z.infer<typeof CleanupEntry>;

export const CleanupReport = z.object({
  runId: z.string(),
  orgId: OrgId18,
  environment: Environment,
  startedAt: IsoDate,
  finishedAt: IsoDate,
  reconciled: z.array(
    z.object({
      idempotencyKey: z.string(),
      outcome: z.enum(['ADOPTED', 'NOT_CREATED']),
      recordId: z.string().optional(),
    }),
  ),
  entries: z.array(CleanupEntry),
  /** Independent re-query after cleanup: run-tagged records and ledger ids that still exist. */
  verify: z.object({
    queries: z.array(z.string()),
    remaining: z.array(z.object({ object: z.string(), recordId: z.string() })),
  }),
  /** CLEAN = nothing of this run remains; KEPT = kept on purpose (--keep / keepDataOnFailure); INCOMPLETE otherwise. */
  status: z.enum(['CLEAN', 'KEPT', 'INCOMPLETE']),
});
export type CleanupReport = z.infer<typeof CleanupReport>;

// ------------------------------------------------------------------ approvals (human checkpoints, PLAN.md §7d)

export const Approval = z.object({
  id: z.string().regex(/^AP-[0-9a-f]{12}$/),
  checkpoint: z.string(),
  /** What is approved, e.g. `recipe:account-contact@<hash>`. */
  subject: z.string(),
  orgId: OrgId18,
  approvedBy: z.string().min(2),
  approvedAt: IsoDate,
  runId: z.string().optional(),
  note: z.string().optional(),
});
export type Approval = z.infer<typeof Approval>;
