import { describe, expect, it } from 'vitest';
import type { OrgsConfig } from '../config/schemas.js';
import type { MutationRequest } from '../mcp/client.js';
import { decide, type OrgPolicyOptions } from './orgPolicy.js';

const ORG = {
  dqp: '00DdN00000uQ5dKUAS',
  ptest: '00D000000000001AAA',
  ro: '00D000000000003AAA',
  sbx: '00D000000000000AAA',
};
const orgs: OrgsConfig = {
  orgs: [
    {
      orgId: ORG.dqp,
      alias: 'qa-prod',
      profile: 'dedicated-qa-prod',
      instanceUrl: 'https://a.my.salesforce.com',
      release: 'r',
      runTagField: null,
      environment: 'LIVE',
      allowedEmailDomains: ['example.invalid'],
    },
    {
      orgId: ORG.ptest,
      alias: 'prod-test',
      profile: 'prod-test-org',
      instanceUrl: 'https://b.my.salesforce.com',
      release: 'r',
      runTagField: 'QA_Run_Id__c',
      environment: 'LIVE',
    },
    {
      orgId: ORG.ro,
      alias: 'prod-ro',
      profile: 'prod-readonly',
      instanceUrl: 'https://c.my.salesforce.com',
      release: 'r',
      runTagField: null,
      environment: 'LIVE',
    },
    {
      orgId: ORG.sbx,
      alias: 'fc',
      profile: 'sandbox-qa',
      instanceUrl: 'https://d--fc.sandbox.my.salesforce.com',
      release: 'r',
      runTagField: 'QA_Run_Id__c',
      environment: 'LIVE',
    },
  ],
  profiles: {
    'dedicated-qa-prod': {
      mutations: 'all-record-data',
      confirmBulkDeleteOver: 200,
      blocked: ['metadata', 'permission-changes', 'payments', 'real-callouts', 'emails-outside-allowed-domains'],
    },
    'prod-test-org': {
      mutations: 'run-tagged-records-only',
      approvalPerRun: true,
      blocked: ['metadata', 'bulk-untagged', 'mass-delete', 'permission-changes', 'payments', 'real-callouts'],
    },
    'prod-readonly': { mutations: 'none' },
    'sandbox-qa': { mutations: 'allowed' },
  },
};

const opts = (verified: string[] = Object.values(ORG), approvals: string[] = []): OrgPolicyOptions => ({
  orgs,
  verifiedOrgIds: () => new Set(verified),
  hasApproval: (id) => id !== undefined && approvals.includes(id),
});
const rec = (orgId: string, args: Record<string, unknown>, approvalId?: string): MutationRequest => ({
  server: 'salesforce-api',
  tool: String(args['operation']),
  args,
  ctx: { runId: 'r1', orgId, user: 'u', persona: 'p', ...(approvalId ? { approvalId } : {}) },
});
const mcp = (orgId: string, tool: string): MutationRequest => ({
  server: 'salesforce',
  tool,
  args: {},
  ctx: { runId: 'r1', orgId, user: 'u', persona: 'p' },
});
const hardStop = (d: ReturnType<typeof decide>): string | undefined => (d.allowed ? undefined : d.hardStop);

describe('org-profile guard — hard stops', () => {
  it('unlisted org → UNLISTED_ORG', () => {
    expect(hardStop(decide(opts(), rec('00D999999999999AAA', { operation: 'create' })))).toBe('UNLISTED_ORG');
  });
  it('identity not verified in this run → IDENTITY_MISMATCH', () => {
    expect(hardStop(decide(opts([]), rec(ORG.dqp, { operation: 'create' })))).toBe('IDENTITY_MISMATCH');
  });
  it('metadata deploy via MCP → METADATA_WRITE on every profile', () => {
    for (const id of Object.values(ORG)) {
      expect(hardStop(decide(opts(), mcp(id, 'deploy_metadata')))).toBe('METADATA_WRITE');
    }
  });
  it('prod-readonly refuses any mutation', () => {
    expect(hardStop(decide(opts(), rec(ORG.ro, { operation: 'create' })))).toBe('PROFILE_FORBIDDEN_MUTATION');
  });
  it('permission changes are blocked on dedicated-qa-prod', () => {
    expect(hardStop(decide(opts(), mcp(ORG.dqp, 'assign_permission_set')))).toBe('PROFILE_FORBIDDEN_MUTATION');
  });
  it('prod-test-org: deleting untagged records → UNTAGGED_CLEANUP, editing them → forbidden', () => {
    expect(hardStop(decide(opts(), rec(ORG.ptest, { operation: 'delete', untaggedCount: 1, cleanup: true })))).toBe(
      'UNTAGGED_CLEANUP',
    );
    expect(hardStop(decide(opts(), rec(ORG.ptest, { operation: 'update', untaggedCount: 1 })))).toBe(
      'PROFILE_FORBIDDEN_MUTATION',
    );
  });
  it('sandbox-qa: cleanup of untagged records is a hard stop', () => {
    expect(hardStop(decide(opts(), rec(ORG.sbx, { operation: 'delete', untaggedCount: 3, cleanup: true })))).toBe(
      'UNTAGGED_CLEANUP',
    );
  });
  it('email outside allowed domains on dedicated-qa-prod is forbidden', () => {
    expect(
      hardStop(decide(opts(), rec(ORG.dqp, { operation: 'create', category: 'email', emailDomains: ['gmail.com'] }))),
    ).toBe('PROFILE_FORBIDDEN_MUTATION');
  });
});

describe('org-profile guard — allowed paths and approvals', () => {
  it('dedicated-qa-prod: any record data, incl. existing test data', () => {
    expect(decide(opts(), rec(ORG.dqp, { operation: 'create', object: 'Account' })).allowed).toBe(true);
    expect(decide(opts(), rec(ORG.dqp, { operation: 'update', untaggedCount: 5 })).allowed).toBe(true);
    expect(decide(opts(), rec(ORG.dqp, { operation: 'delete', untaggedCount: 200 })).allowed).toBe(true);
  });
  it('dedicated-qa-prod: bulk delete of > 200 existing records asks once', () => {
    const d = decide(opts(), rec(ORG.dqp, { operation: 'delete', untaggedCount: 201, recordCount: 201 }));
    expect(d.allowed).toBe(false);
    expect(hardStop(d)).toBeUndefined();
    const ok = decide(opts(undefined, ['A-1']), rec(ORG.dqp, { operation: 'delete', untaggedCount: 201 }, 'A-1'));
    expect(ok).toEqual({ allowed: true, approvalId: 'A-1' });
  });
  it('prod-test-org: run-tagged writes need the per-run approval', () => {
    expect(decide(opts(), rec(ORG.ptest, { operation: 'create' })).allowed).toBe(false);
    expect(
      decide(opts(undefined, ['RUN-APPROVAL']), rec(ORG.ptest, { operation: 'create' }, 'RUN-APPROVAL')).allowed,
    ).toBe(true);
  });
  it('unknown MCP mutate tool or malformed intent → refused (secure default), no hard stop', () => {
    const d1 = decide(opts(), mcp(ORG.dqp, 'some_new_tool'));
    expect(d1.allowed).toBe(false);
    expect(hardStop(d1)).toBeUndefined();
    expect(decide(opts(), rec(ORG.dqp, { operation: 'explode' })).allowed).toBe(false);
  });
});
