import { z } from 'zod';
import type { OrgEntry, OrgProfile, OrgsConfig } from '../config/schemas.js';
import type { MutationDecision, MutationGuard, MutationRequest } from '../mcp/client.js';

/**
 * What a mutation does, in policy terms. Record writes through `GuardedSalesforce` send this as the request args;
 * MCP tools are mapped to a category by name (TOOL_CATEGORIES). Unknown → refused (secure default).
 */
export const MutationIntent = z.object({
  operation: z.enum(['create', 'update', 'delete', 'other']),
  category: z.string().default('record-data'),
  object: z.string().optional(),
  /** Number of records the call touches (bulk awareness). */
  recordCount: z.number().int().nonnegative().default(1),
  /** How many of those records do NOT carry this run's tag (existing data). */
  untaggedCount: z.number().int().nonnegative().default(0),
  /** True for cleanup deletes (reverse-order teardown of run data). */
  cleanup: z.boolean().default(false),
  /** Recipient domains when the operation can send email. */
  emailDomains: z.array(z.string()).optional(),
});
export type MutationIntent = z.infer<typeof MutationIntent>;

/** MCP mutate tools → policy category. Metadata-type tools are always a METADATA_WRITE hard stop. */
export const TOOL_CATEGORIES: Record<string, string> = {
  'salesforce.assign_permission_set': 'permission-changes',
  'salesforce.run_apex_test': 'apex-test',
  'salesforce.run_agent_test': 'agent-test',
  'salesforce.deploy_metadata': 'metadata',
  'salesforce.retrieve_metadata': 'metadata',
};

const METADATA_TOOL = /(deploy|metadata|anonymous|execute_apex|create_scratch|delete_org)/i;

export interface OrgPolicyOptions {
  orgs: OrgsConfig;
  /** Org IDs whose identity check passed in this run (VerifiedIdentity.orgId). */
  verifiedOrgIds: () => ReadonlySet<string>;
  /** Approval ids granted in this run (per-run approval, bulk-delete confirmation). */
  hasApproval?: (approvalId: string | undefined) => boolean;
}

const deny = (
  reason: string,
  hardStop?: Extract<MutationDecision, { allowed: false }>['hardStop'],
): MutationDecision => (hardStop ? { allowed: false, reason, hardStop } : { allowed: false, reason });

function intentOf(req: MutationRequest): MutationIntent | { error: string } {
  if (req.server === 'salesforce-api') {
    const parsed = MutationIntent.safeParse(req.args);
    return parsed.success
      ? parsed.data
      : { error: `invalid mutation intent: ${parsed.error.issues[0]?.message ?? ''}` };
  }
  const key = `${req.server}.${req.tool}`;
  const category = TOOL_CATEGORIES[key] ?? (METADATA_TOOL.test(req.tool) ? 'metadata' : undefined);
  if (!category) return { error: `no policy category for mutate tool ${key}` };
  return MutationIntent.parse({ operation: 'other', category });
}

/**
 * Org-profile enforcement for every mutation (PLAN.md §7b/§7d, safety-and-approvals skill). Hard stops:
 * unlisted org, unverified identity, metadata writes, profile-forbidden mutations, untagged cleanup.
 * Plain refusals (no hard stop): missing approval, unknown tool category, malformed intent.
 */
export function createOrgPolicyGuard(o: OrgPolicyOptions): MutationGuard {
  return (req) => Promise.resolve(decide(o, req));
}

export function decide(o: OrgPolicyOptions, req: MutationRequest): MutationDecision {
  const org: OrgEntry | undefined = o.orgs.orgs.find((x) => x.orgId === req.ctx.orgId);
  if (!org) return deny(`org ${req.ctx.orgId} is not in config/orgs.yaml`, 'UNLISTED_ORG');
  if (!o.verifiedOrgIds().has(org.orgId)) {
    return deny(`identity of ${org.alias} not verified in this run`, 'IDENTITY_MISMATCH');
  }
  const profile: OrgProfile | undefined = o.orgs.profiles[org.profile];
  if (!profile) return deny(`profile ${org.profile} is not defined`, 'PROFILE_FORBIDDEN_MUTATION');

  const intent = intentOf(req);
  if ('error' in intent) return deny(intent.error);
  if (intent.category === 'metadata') return deny(`${req.server}.${req.tool} would change metadata`, 'METADATA_WRITE');

  if (profile.mutations === 'none') {
    return deny(`profile ${org.profile} allows no mutations`, 'PROFILE_FORBIDDEN_MUTATION');
  }
  const blocked = new Set(profile.blocked ?? []);
  if (blocked.has(intent.category)) {
    return deny(
      `category ${intent.category} is blocked on ${org.alias} (${org.profile})`,
      'PROFILE_FORBIDDEN_MUTATION',
    );
  }
  if (intent.emailDomains?.length) {
    const allowed = new Set((org.allowedEmailDomains ?? []).map((d) => d.toLowerCase()));
    const outside = intent.emailDomains.filter((d) => !allowed.has(d.toLowerCase()));
    if (outside.length && (blocked.has('emails-outside-allowed-domains') || org.profile === 'prod-test-org')) {
      return deny(`email to domains outside the allowed list: ${outside.join(', ')}`, 'PROFILE_FORBIDDEN_MUTATION');
    }
  }

  const approved = o.hasApproval?.(req.ctx.approvalId) ?? false;
  const approvalId = approved && req.ctx.approvalId ? { approvalId: req.ctx.approvalId } : {};
  const touchesExisting = intent.untaggedCount > 0;

  switch (profile.mutations) {
    case 'run-tagged-records-only': {
      if (touchesExisting) {
        return intent.cleanup || intent.operation === 'delete'
          ? deny(`${intent.untaggedCount} record(s) without this run's tag`, 'UNTAGGED_CLEANUP')
          : deny(`${org.profile} may only change this run's records`, 'PROFILE_FORBIDDEN_MUTATION');
      }
      if (profile.approvalPerRun && !approved) return deny(`${org.alias} needs the per-run approval first`);
      return { allowed: true, ...approvalId };
    }
    case 'all-record-data': {
      const limit = profile.confirmBulkDeleteOver;
      if (intent.operation === 'delete' && limit !== undefined && intent.untaggedCount > limit && !approved) {
        return deny(`deleting ${intent.untaggedCount} existing records (> ${limit}) needs one confirmation`);
      }
      return { allowed: true, ...approvalId };
    }
    case 'allowed': {
      if (touchesExisting && (intent.cleanup || intent.operation === 'delete')) {
        return deny(
          `cleanup would delete ${intent.untaggedCount} record(s) without this run's tag`,
          'UNTAGGED_CLEANUP',
        );
      }
      return { allowed: true, ...approvalId };
    }
  }
}
