import { z } from 'zod';
import { ISSUE_KINDS } from '../core/schemas/issue.js';
import { OrgId18 } from '../core/schemas/common.js';

// ---------------------------------------------------------------- models.yaml
export const MODEL_ROLES = ['reasoning', 'coder', 'fast', 'judge'] as const;
export const ModelRole = z.enum(MODEL_ROLES);
export type ModelRole = z.infer<typeof ModelRole>;

export const ChatProvider = z.enum(['google', 'anthropic', 'openai', 'azure-openai', 'ollama', 'mock']);
export type ChatProvider = z.infer<typeof ChatProvider>;
export const EmbeddingProvider = z.enum(['google', 'openai', 'voyage', 'ollama', 'mock']);
export type EmbeddingProvider = z.infer<typeof EmbeddingProvider>;

const ModelRef = z.object({ provider: ChatProvider, model: z.string().min(1) });
export const RoleConfig = ModelRef.extend({
  temperature: z.number().min(0).max(2).default(0),
  timeoutMs: z.number().int().positive().default(120_000),
  maxOutputTokens: z.number().int().positive().optional(),
  fallback: ModelRef.optional(),
});
export type RoleConfig = z.infer<typeof RoleConfig>;

export const ModelsConfig = z
  .object({
    roles: z.object({ reasoning: RoleConfig, coder: RoleConfig, fast: RoleConfig, judge: RoleConfig }),
    embeddings: z.object({ provider: EmbeddingProvider, model: z.string().min(1) }),
    budgets: z.object({
      tokensPerRun: z.number().int().positive(),
      minutesPerRun: z.number().positive(),
    }),
    /** Optional per-provider quotas (requests per minute). Defaults are applied in the router. */
    quotas: z.partialRecord(ChatProvider, z.object({ requestsPerMinute: z.number().int().positive() })).optional(),
  })
  .superRefine((cfg, ctx) => {
    // CLAUDE.md rule 8: the judge role must use a different model than the coder role.
    const { judge, coder } = cfg.roles;
    if (judge.provider === coder.provider && judge.model === coder.model) {
      ctx.addIssue({
        code: 'custom',
        path: ['roles', 'judge', 'model'],
        message: `judge must use a different model than coder (both are ${coder.provider}/${coder.model})`,
      });
    }
  });
export type ModelsConfig = z.infer<typeof ModelsConfig>;

// ---------------------------------------------------------------- policy.yaml
export const PolicyResponse = z.enum([
  'retry',
  'fallback',
  'escalate',
  'degrade',
  'ask',
  'investigate',
  'heal',
  'judge',
  'file_bug',
  'halt',
]);
export type PolicyResponse = z.infer<typeof PolicyResponse>;

const Autonomy = z.enum(['L1', 'L2', 'L3']);

export const PolicyConfig = z
  .looseObject({
    autonomy: Autonomy,
    clarification: z.object({
      maxQuestionsPerRound: z.number().int().positive(),
      waitMinutes: z.object({ L1: z.number().min(0), L2: z.number().min(0), L3: z.number().min(0) }),
    }),
    issues: z.record(z.string(), z.array(PolicyResponse).min(1)),
    retry: z.object({
      maxAttempts: z.number().int().positive(),
      backoffSeconds: z.array(z.number().nonnegative()).min(1),
    }),
    healing: z.object({
      maxAttemptsPerTest: z.number().int().positive(),
      allowAssertionChanges: z.literal(false, { error: 'healing.allowAssertionChanges must stay false (rule 7)' }),
    }),
    hardStops: z.object({
      unlistedOrg: z.literal(true),
      identityMismatch: z.literal(true),
      profileForbiddenMutation: z.literal(true),
      metadataWrites: z.literal(true),
      secretsInPrompts: z.literal(true),
      untaggedDataCleanup: z.literal(true),
    }),
    security: z.looseObject({
      auditLog: z.boolean(),
      redactPii: z.boolean(),
      idempotencyKeys: z.boolean(),
      reconcileUncertainWrites: z.boolean(),
      defaultBlocked: z.array(z.string()),
      allowExternalUpload: z.boolean(),
    }),
    defectPublication: z.looseObject({ enabled: z.boolean() }),
    exploration: z.looseObject({ minutesPerRun: z.number().positive(), maxCharters: z.number().int().positive() }),
    checkpoints: z.array(z.string()),
    approvals: z.object({
      L1: z.union([z.literal('all'), z.array(z.string())]),
      L2: z.union([z.literal('all'), z.array(z.string())]),
      L3: z.union([z.literal('all'), z.array(z.string())]),
    }),
  })
  .superRefine((p, ctx) => {
    // "No new Issue type without a QA Lead policy entry" (CLAUDE.md, definition of done).
    for (const kind of ISSUE_KINDS) {
      if (!(kind in p.issues)) {
        ctx.addIssue({ code: 'custom', path: ['issues', kind], message: `missing policy entry for IssueKind ${kind}` });
      }
    }
    for (const key of Object.keys(p.issues)) {
      if (!(ISSUE_KINDS as readonly string[]).includes(key)) {
        ctx.addIssue({ code: 'custom', path: ['issues', key], message: `unknown IssueKind ${key}` });
      }
    }
    const hard = p.issues['HARD_STOP'];
    if (hard && (hard.length !== 1 || hard[0] !== 'halt')) {
      ctx.addIssue({ code: 'custom', path: ['issues', 'HARD_STOP'], message: 'HARD_STOP must be exactly [halt]' });
    }
    const known = new Set(p.checkpoints);
    for (const level of ['L1', 'L2', 'L3'] as const) {
      const list = p.approvals[level];
      if (Array.isArray(list)) {
        for (const c of list) {
          if (!known.has(c)) {
            ctx.addIssue({ code: 'custom', path: ['approvals', level], message: `unknown checkpoint ${c}` });
          }
        }
      }
    }
  });
export type PolicyConfig = z.infer<typeof PolicyConfig>;

// ---------------------------------------------------------------- personas.yaml
export const Persona = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'kebab-case id'),
  username: z.string().min(3),
  sfAlias: z.string().min(1),
  profile: z.string().min(1),
  permissionSets: z.array(z.string()).default([]),
  recordTypes: z.array(z.string()).optional(),
  use: z.array(z.string()).min(1),
});
export type Persona = z.infer<typeof Persona>;

export const PersonasConfig = z
  .object({
    defaultPersona: z.string(),
    personas: z.array(Persona).min(1),
    nonAdminCheckRequiredFor: z.array(z.string()),
    missingPersonaPolicy: z.enum(['ask', 'assign-permset-to-existing-test-user', 'skip-and-report']),
    sessionTtlMinutes: z.number().int().positive(),
  })
  .superRefine((c, ctx) => {
    const ids = c.personas.map((p) => p.id);
    if (!ids.includes(c.defaultPersona)) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaultPersona'],
        message: `defaultPersona ${c.defaultPersona} not found`,
      });
    }
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup) ctx.addIssue({ code: 'custom', path: ['personas'], message: `duplicate persona id ${dup}` });
  });
export type PersonasConfig = z.infer<typeof PersonasConfig>;

// ---------------------------------------------------------------- orgs.yaml
export const ORG_PROFILES = [
  'sandbox-qa',
  'dedicated-qa-prod',
  'prod-test-org',
  'prod-readonly',
  'offline-fixture',
] as const;
export const OrgProfileName = z.enum(ORG_PROFILES);
export type OrgProfileName = z.infer<typeof OrgProfileName>;

export const OrgEntry = z.object({
  orgId: OrgId18,
  alias: z.string().min(1),
  profile: OrgProfileName,
  instanceUrl: z.string().min(1),
  release: z.string().min(1),
  runTagField: z.string().nullable().default(null),
  /** LIVE = real Salesforce. FIXTURE = examples/fixture (never reported as a real pass). */
  environment: z.enum(['LIVE', 'FIXTURE']).default('LIVE'),
  keepDataOnFailure: z.boolean().optional(),
  allowedEmailDomains: z.array(z.string()).optional(),
  emailDeliverabilityConfirmedSafe: z.boolean().optional(),
  bulkLimit: z.number().int().positive().optional(),
});
export type OrgEntry = z.infer<typeof OrgEntry>;

export const OrgProfile = z.looseObject({
  mutations: z.enum(['allowed', 'all-record-data', 'run-tagged-records-only', 'none']),
  /** Mutation categories refused outright (metadata, permission-changes, payments, real-callouts, …). */
  blocked: z.array(z.string()).optional(),
  /** prod-test-org: every run needs one recorded approval before its first mutation. */
  approvalPerRun: z.boolean().optional(),
  /** dedicated-qa-prod: deleting more than N existing (non-run) records asks once. */
  confirmBulkDeleteOver: z.number().int().positive().optional(),
  authorization: z.string().optional(),
  bulk: z.string().optional(),
  cleanupDefault: z.enum(['run-owned', 'all']).optional(),
  approvals: z.string().optional(),
});
export type OrgProfile = z.infer<typeof OrgProfile>;

export const OrgsConfig = z
  .object({
    orgs: z.array(OrgEntry),
    profiles: z.record(z.string(), OrgProfile),
  })
  .superRefine((c, ctx) => {
    c.orgs.forEach((o, i) => {
      if (!(o.profile in c.profiles)) {
        ctx.addIssue({ code: 'custom', path: ['orgs', i, 'profile'], message: `profile ${o.profile} not defined` });
      }
      if (o.environment === 'FIXTURE' && o.profile !== 'offline-fixture') {
        ctx.addIssue({
          code: 'custom',
          path: ['orgs', i, 'profile'],
          message: 'FIXTURE orgs must use offline-fixture',
        });
      }
    });
    const ids = c.orgs.map((o) => o.orgId);
    const dupId = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dupId) ctx.addIssue({ code: 'custom', path: ['orgs'], message: `duplicate orgId ${dupId}` });
    const aliases = c.orgs.map((o) => o.alias);
    const dupAlias = aliases.find((a, i) => aliases.indexOf(a) !== i);
    if (dupAlias) ctx.addIssue({ code: 'custom', path: ['orgs'], message: `duplicate alias ${dupAlias}` });
  });
export type OrgsConfig = z.infer<typeof OrgsConfig>;

// ---------------------------------------------------------------- execution.yaml
export const BrowserName = z.enum(['chromium', 'chrome', 'msedge']);
export type BrowserName = z.infer<typeof BrowserName>;

export const ExecutionConfig = z.object({
  browser: BrowserName,
  fallbackBrowser: BrowserName.optional(),
  headless: z.boolean().default(true),
  viewports: z.array(z.object({ name: z.string(), width: z.number().int(), height: z.number().int() })).min(1),
  visual: z.object({
    maxDiffPixelRatio: z.number().min(0).max(1),
    mask: z.array(z.string()),
    allowExternalUpload: z.boolean(),
  }),
});
export type ExecutionConfig = z.infer<typeof ExecutionConfig>;

// ---------------------------------------------------------------- mcp-tools.yaml
export const ServerToolList = z
  .object({
    observe: z.array(z.string()).default([]),
    mutate: z.array(z.string()).default([]),
    blocked: z.array(z.string()).default([]),
  })
  .superRefine((s, ctx) => {
    const seen = new Map<string, string>();
    for (const cls of ['observe', 'mutate', 'blocked'] as const) {
      for (const t of s[cls]) {
        const prev = seen.get(t);
        if (prev) ctx.addIssue({ code: 'custom', path: [cls], message: `tool ${t} is in both ${prev} and ${cls}` });
        seen.set(t, cls);
      }
    }
  });
export type ServerToolList = z.infer<typeof ServerToolList>;
export const McpToolsConfig = z.record(z.string(), ServerToolList);
export type McpToolsConfig = z.infer<typeof McpToolsConfig>;

// ---------------------------------------------------------------- observability.yaml
export const ObservabilityConfig = z.object({
  exporters: z.object({
    langfuse: z.object({ enabled: z.boolean() }),
    phoenix: z.object({ enabled: z.boolean() }),
  }),
  redactBeforeExport: z.literal(true, { error: 'redactBeforeExport must be true (rule 17)' }),
  includeScreenshots: z.literal(false, { error: 'screenshots never go into traces (rule 17)' }),
  sendEvalScores: z.boolean().default(true),
  tags: z.array(z.string()),
  perOrgProfile: z.record(z.string(), z.object({ langfuse: z.boolean(), phoenix: z.boolean() })).default({}),
  onExporterError: z.literal('warn'),
});
export type ObservabilityConfig = z.infer<typeof ObservabilityConfig>;
