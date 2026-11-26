// Observed messages on the offline fixture (real Chromium, FIXTURE): every Save is guarded + audited, a rejected save
// creates nothing (SOQL), anything a save did create is adopted and cleaned up, and the seed is removed (re-query 0).
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../tests/helpers/tempProject.js';
import type { OrgEntry, OrgsConfig, Persona } from '../../config/schemas.js';
import { startFixtureServer, type FixtureServer } from '../../fixture/server.js';
import { loadSeed } from '../../fixture/store.js';
import { ObservedMessageStore } from '../../knowledge/observedMessages.js';
import { SnapshotStore } from '../../knowledge/snapshotStore.js';
import { AuditLog } from '../../security/audit.js';
import { WriteLedger } from '../../security/idempotency.js';
import { Redactor } from '../../security/redact.js';
import { ensureStorageState } from '../../sf/auth/browserState.js';
import { FixtureSessionProvider } from '../../sf/auth/fixture.js';
import { connectSalesforce, IdentityRegistry, type GuardedSalesforce } from '../../sf/client.js';
import { DataEngine } from '../../sf/data/engine.js';
import { buildDataPlan, loadRecipe, SnapshotFacts } from '../../sf/data/plan.js';
import { runDiscovery } from '../../sf/discovery/index.js';
import { observeMessages } from './messages.js';

const seed = loadSeed(join(REPO_ROOT, 'examples', 'fixture', 'seed.json'));
const admin: Persona = {
  id: 'system-admin',
  username: 'qa.admin@fixture.example.invalid',
  sfAlias: 'fixture',
  profile: 'System Administrator',
  permissionSets: [],
  use: ['data'],
};

describe('Explorer: observed messages on the offline fixture (real Chromium, FIXTURE)', () => {
  let server: FixtureServer;
  let browser: Browser;
  let org: OrgEntry;
  let sf: GuardedSalesforce;
  let dir: string;
  let audit: AuditLog;

  beforeAll(async () => {
    server = await startFixtureServer({ fixtureDir: join(REPO_ROOT, 'examples', 'fixture'), port: 0 });
    browser = await chromium.launch({ headless: true });
    org = {
      orgId: seed.organization.Id,
      alias: 'fixture',
      profile: 'offline-fixture',
      instanceUrl: server.url,
      release: 'fixture',
      runTagField: 'QA_Run_Id__c',
      environment: 'FIXTURE',
      allowedEmailDomains: ['example.invalid'],
    };
    const orgs: OrgsConfig = { orgs: [org], profiles: { 'offline-fixture': { mutations: 'allowed' } } };
    dir = mkdtempSync(join(tmpdir(), 'qa observe '));
    audit = new AuditLog(join(dir, 'audit.jsonl'), new Redactor());
    sf = await connectSalesforce({
      provider: new FixtureSessionProvider(seed),
      org,
      orgs,
      persona: admin,
      runId: 'observe-t',
      registry: new IdentityRegistry(),
      audit,
    });
  });
  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  it('captures required + invalid-email texts, proves no record, adopts what a save created, cleans up', async () => {
    const discovery = await runDiscovery({
      sf,
      environment: 'FIXTURE',
      orgId: org.orgId,
      apiVersion: '62.0',
      objects: ['Account', 'Contact'],
    });
    const snapshots = new SnapshotStore(join(dir, 'knowledge.db'));
    const snap = snapshots.save({ discovery, orgAlias: 'fixture', release: 'fixture' });
    snapshots.close();
    const plan = buildDataPlan({
      loaded: loadRecipe(REPO_ROOT, 'account-contact'),
      facts: new SnapshotFacts(snap),
      org,
      runId: 'observe-t',
    });
    expect(plan.valid).toBe(true);
    const engine = new DataEngine({ sf, plan, ledger: new WriteLedger(join(dir, 'writes.jsonl')), org });
    const state = await ensureStorageState({
      provider: new FixtureSessionProvider(seed),
      request: { persona: admin, org },
      authDir: join(dir, '.auth'),
      ttlMinutes: 60,
      browser: 'chromium',
    });
    const r = await observeMessages({
      browser,
      storageStatePath: state.path,
      baseUrl: server.url,
      sf,
      engine,
      org: org.orgId,
      persona: 'system-admin',
      snapshotId: snap.info.id,
      runId: 'observe-t',
      environment: 'FIXTURE',
      evidenceDir: join(dir, 'observe'),
      root: dir,
      redactor: new Redactor(),
    });
    const by = (a: string) => r.attempts.find((x) => x.attempt === a);
    expect(by('required-last-name')).toMatchObject({ before: 1, after: 1, created: false });
    expect(by('required-last-name')?.messages.find((m) => m.placement === 'field')).toMatchObject({
      field: 'Contact.LastName',
      kind: 'required',
      text: 'Complete this field.', // the fixture's own text (FIXTURE) — live text comes from qa-prod
      environment: 'FIXTURE',
    });
    expect(by('invalid-email')?.messages.find((m) => m.placement === 'field')?.text).toMatch(/invalid email address/);
    expect(by('invalid-email')?.created).toBe(false);
    // The fixture input truncates to 80 and saves; it has no duplicate rule: both saves are adopted and cleaned.
    expect(by('last-name-81')?.notes.join(' ')).toMatch(/the input kept 80/);
    expect(by('last-name-81')?.created).toBe(true);
    expect(by('duplicate-email')?.created).toBe(true);
    expect(r.cleanup.status).toBe('CLEAN');
    expect(r.cleanup.verify.remaining).toEqual([]);
    // Every Save was a guarded, audited mutation (write-ahead ALLOWED → SUCCEEDED).
    const lines = readFileSync(join(dir, 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { tool: string; outcome: string });
    const ui = lines.filter((l) => l.tool === 'salesforce-api.ui-save-attempt');
    expect(ui.filter((l) => l.outcome === 'ALLOWED')).toHaveLength(4);
    expect(ui.filter((l) => l.outcome === 'SUCCEEDED')).toHaveLength(4);
    // The store keeps the latest per page/field/kind/placement.
    const store = new ObservedMessageStore(join(dir, 'knowledge.db'));
    for (const m of r.messages) store.add(m);
    expect(store.latest(org.orgId).map((m) => `${m.field ?? ''}:${m.kind}:${m.placement}`)).toEqual(
      expect.arrayContaining(['Contact.LastName:required:field', 'Contact.Email:validation:field']),
    );
    store.close();
  }, 180_000);
});
