import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgEntry, OrgsConfig, Persona } from '../config/schemas.js';
import { HardStopError, QAError } from '../core/errors.js';
import { startFixtureServer, type FixtureServer } from '../fixture/server.js';
import { loadSeed } from '../fixture/store.js';
import { AuditLog } from '../security/audit.js';
import { Redactor } from '../security/redact.js';
import { REPO_ROOT } from '../../tests/helpers/tempProject.js';
import type { SfApi } from './api.js';
import { FixtureSessionProvider } from './auth/fixture.js';
import type { SfSession } from './auth/types.js';
import { connectSalesforce, IdentityRegistry } from './client.js';
import { verifyIdentity } from './identity.js';

const seed = loadSeed(join(REPO_ROOT, 'examples', 'fixture', 'seed.json'));
const admin: Persona = {
  id: 'system-admin',
  username: 'qa.admin@fixture.example.invalid',
  sfAlias: 'fixture',
  profile: 'System Administrator',
  permissionSets: [],
  use: ['default-execution'],
};

describe('identity check + GuardedSalesforce on the offline fixture', () => {
  let server: FixtureServer;
  let org: OrgEntry;
  let orgs: OrgsConfig;

  beforeAll(async () => {
    server = await startFixtureServer({ fixtureDir: join(REPO_ROOT, 'examples', 'fixture'), port: 0 });
    org = {
      orgId: seed.organization.Id,
      alias: 'fixture',
      profile: 'offline-fixture',
      instanceUrl: server.url,
      release: 'fixture',
      runTagField: 'QA_Run_Id__c',
      environment: 'FIXTURE',
    };
    orgs = { orgs: [org], profiles: { 'offline-fixture': { mutations: 'allowed' } } };
  });
  afterAll(async () => {
    await server.close();
  });

  it('verifies org, user and instance, and records the identity', async () => {
    const registry = new IdentityRegistry();
    const sf = await connectSalesforce({
      provider: new FixtureSessionProvider(seed),
      org,
      orgs,
      persona: admin,
      runId: 'run-t2',
      registry,
    });
    expect(sf.identity).toMatchObject({
      orgId: seed.organization.Id,
      username: admin.username,
      environment: 'FIXTURE',
    });
    expect(registry.verifiedOrgIds().has(seed.organization.Id)).toBe(true);
    const accounts = await sf.query<{ Id: string }>('SELECT Id, Name FROM Account');
    expect(accounts.length).toBeGreaterThan(0);
    expect(Object.keys(accounts[0] ?? {})).not.toContain('attributes');
  });

  it('wrong persona user → IDENTITY_MISMATCH hard stop', async () => {
    const readOnlyUser = { ...admin, id: 'read-only' }; // fixture logs in the read-only user, persona expects admin
    const err = await connectSalesforce({
      provider: new FixtureSessionProvider(seed),
      org,
      orgs,
      persona: readOnlyUser,
      runId: 'run-t2',
      registry: new IdentityRegistry(),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HardStopError);
    expect((err as HardStopError).reason).toBe('IDENTITY_MISMATCH');
  });

  it('writes go through the guard and are audit-logged write-ahead; refused writes are logged too', async () => {
    const audit = new AuditLog(join(mkdtempSync(join(tmpdir(), 'audit ')), 'audit.jsonl'), new Redactor());
    const sf = await connectSalesforce({
      provider: new FixtureSessionProvider(seed),
      org,
      orgs,
      persona: admin,
      runId: 'run-t2',
      registry: new IdentityRegistry(),
      audit,
    });
    const id = await sf.create('Account', { Name: 'QA-run-t2 Account' });
    expect(id).toMatch(/^001/);
    expect(audit.read().map((e) => e.outcome)).toEqual(['ALLOWED', 'SUCCEEDED']);
    const err = await sf.destroy('Account', id, { untaggedCount: 1, cleanup: true }).catch((e: unknown) => e);
    expect((err as HardStopError).reason).toBe('UNTAGGED_CLEANUP');
    expect(audit.read().at(-1)?.outcome).toBe('REFUSED');
  });
});

describe('verifyIdentity edge cases (fake API)', () => {
  const live: OrgEntry = {
    orgId: '00DdN00000uQ5dKUAS',
    alias: 'qa-prod',
    profile: 'dedicated-qa-prod',
    instanceUrl: 'https://acme.my.salesforce.com',
    release: "Winter '27",
    runTagField: null,
    environment: 'LIVE',
  };
  const orgs: OrgsConfig = { orgs: [live], profiles: { 'dedicated-qa-prod': { mutations: 'all-record-data' } } };
  const persona: Persona = { ...admin, username: 'admin@acme.example', sfAlias: 'qa-prod' };
  const session: SfSession = {
    orgAlias: 'qa-prod',
    personaId: persona.id,
    username: persona.username,
    orgId: live.orgId,
    instanceUrl: live.instanceUrl,
    accessToken: 'x'.repeat(20),
    apiVersion: '68.0',
    source: 'sf-cli',
    obtainedAt: 0,
  };
  const api = (over: { isSandbox?: boolean; orgId?: string; user?: string; release?: string } = {}): SfApi =>
    ({
      environment: 'LIVE',
      instanceUrl: live.instanceUrl,
      apiVersion: '68.0',
      query: () =>
        Promise.resolve([
          { Id: over.orgId ?? live.orgId, IsSandbox: over.isSandbox ?? false, OrganizationType: 'Enterprise Edition' },
        ]),
      userinfo: () =>
        Promise.resolve({
          organization_id: over.orgId ?? live.orgId,
          preferred_username: over.user ?? persona.username,
          user_id: '005x',
        }),
      apiVersions: () => Promise.resolve([{ version: '68.0', label: over.release ?? "Winter '27" }]),
    }) as unknown as SfApi;

  it('passes for the configured production org and warns on a release drift', async () => {
    const ok = await verifyIdentity({ api: api(), session, org: live, orgs, persona });
    expect(ok.warnings).toEqual([]);
    const drift = await verifyIdentity({ api: api({ release: "Spring '27" }), session, org: live, orgs, persona });
    expect(drift.warnings[0]).toMatch(/release/);
  });
  it('a sandbox behind a dedicated-qa-prod profile is a hard stop', async () => {
    await expect(verifyIdentity({ api: api({ isSandbox: true }), session, org: live, orgs, persona })).rejects.toThrow(
      /IsSandbox/,
    );
  });
  it('session for an org that is not in orgs.yaml → UNLISTED_ORG', async () => {
    const err = await verifyIdentity({
      api: api(),
      session: { ...session, orgId: '00D999999999999AAA' },
      org: live,
      orgs,
      persona,
    }).catch((e: unknown) => e);
    expect((err as HardStopError).reason).toBe('UNLISTED_ORG');
  });
  it('instance URL different from orgs.yaml → hard stop', async () => {
    await expect(
      verifyIdentity({
        api: api(),
        session: { ...session, instanceUrl: 'https://evil.my.salesforce.com' },
        org: live,
        orgs,
        persona,
      }),
    ).rejects.toBeInstanceOf(HardStopError);
  });
  it('a non-identity failure (e.g. network) is not swallowed', async () => {
    const broken = {
      ...api(),
      query: () => Promise.reject(new QAError('TRANSIENT', 'socket hang up')),
    } as unknown as SfApi;
    await expect(verifyIdentity({ api: broken, session, org: live, orgs, persona })).rejects.toBeInstanceOf(QAError);
  });
});
