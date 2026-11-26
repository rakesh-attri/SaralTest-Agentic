// Test data engine on the offline fixture (FIXTURE): plan validation, create → verify → negatives → cleanup →
// re-query, and the failure paths (uncertain write, untagged cleanup, policy refusal, partial failure, resume).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgEntry, OrgsConfig, Persona, PolicyConfig } from '../../config/schemas.js';
import { HardStopError, QAError } from '../../core/errors.js';
import type { Recipe } from '../../core/schemas/data.js';
import { startFixtureServer, type FixtureServer } from '../../fixture/server.js';
import { loadSeed } from '../../fixture/store.js';
import { SnapshotStore, type StoredSnapshot } from '../../knowledge/snapshotStore.js';
import { ApprovalStore, checkpointRequired, NEW_RECIPE_CHECKPOINT, recipeSubject } from '../../security/approvals.js';
import { WriteLedger } from '../../security/idempotency.js';
import { REPO_ROOT } from '../../../tests/helpers/tempProject.js';
import { FixtureSessionProvider } from '../auth/fixture.js';
import { connectSalesforce, IdentityRegistry, type GuardedSalesforce } from '../client.js';
import { runDiscovery } from '../discovery/index.js';
import { DataEngine, sfErrorCodes } from './engine.js';
import { buildDataPlan, loadRecipe, recipeHash, SnapshotFacts, syntheticToken, type LoadedRecipe } from './plan.js';
import { renderDataReport, writeDataOutputs } from './report.js';
import { reconcileRun, subRunDirs } from '../../runner/reconcile.js';

const seed = loadSeed(join(REPO_ROOT, 'examples', 'fixture', 'seed.json'));
const admin: Persona = {
  id: 'system-admin',
  username: 'qa.admin@fixture.example.invalid',
  sfAlias: 'fixture',
  profile: 'System Administrator',
  permissionSets: [],
  use: ['data'],
};

/** Fixture variant of the approved recipe (fixture has no Contact.Email domain restrictions beyond example.invalid). */
const RECIPE: Recipe = {
  recipe: 'account-contact',
  approvedBy: 'Test Approver',
  objects: [
    {
      object: 'Account',
      recordType: null,
      fields: { Name: 'QA-{runId}-Acme {synthetic}', Industry: 'Technology', BillingCountry: 'India' },
    },
    {
      object: 'Contact',
      recordType: null,
      parent: { field: 'AccountId', ref: 'Account' },
      fields: {
        FirstName: '{synthetic}',
        LastName: 'QA-{runId}-{synthetic}',
        Email: 'qa+{runId}-{synthetic}@example.invalid',
      },
    },
  ],
  negativeVariants: [
    { name: 'missing-last-name', object: 'Contact', remove: ['LastName'], set: {}, expect: 'rejected' },
  ],
  cleanup: 'reverse-dependency',
};
const loaded = (r: Recipe = RECIPE): LoadedRecipe => ({ recipe: r, hash: recipeHash(r), file: 'x.yaml' });

describe('test data engine on the offline fixture (FIXTURE)', () => {
  let server: FixtureServer;
  let org: OrgEntry;
  let orgs: OrgsConfig;
  let sf: GuardedSalesforce;
  let snap: StoredSnapshot;
  let dir: string;

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
      allowedEmailDomains: ['example.invalid'],
    };
    orgs = { orgs: [org], profiles: { 'offline-fixture': { mutations: 'allowed' } } };
    sf = await connectSalesforce({
      provider: new FixtureSessionProvider(seed),
      org,
      orgs,
      persona: admin,
      runId: 'run-data-t',
      registry: new IdentityRegistry(),
    });
    dir = mkdtempSync(join(tmpdir(), 'qa data '));
    const discovery = await runDiscovery({
      sf,
      environment: 'FIXTURE',
      orgId: org.orgId,
      apiVersion: '62.0',
      objects: ['Account', 'Contact'],
    });
    const store = new SnapshotStore(join(dir, 'knowledge.db'));
    snap = store.save({ discovery, orgAlias: 'fixture', release: 'fixture' });
    store.close();
  });
  afterAll(async () => {
    await server.close();
  });

  const plan = (runId: string, r?: Recipe, o: Partial<OrgEntry> = {}): ReturnType<typeof buildDataPlan> =>
    buildDataPlan({ loaded: loaded(r), facts: new SnapshotFacts(snap), org: { ...org, ...o }, runId });

  it('loads and validates the approved Account → Contact recipe file from the repo', () => {
    const l = loadRecipe(REPO_ROOT, 'account-contact');
    expect(l.recipe.approvedBy).not.toMatch(/^</);
    const p = buildDataPlan({ loaded: l, facts: new SnapshotFacts(snap), org, runId: 'run-file-1' });
    expect(p.issues.filter((i) => i.severity === 'ERROR')).toEqual([]);
    expect(p.steps.map((s) => `${s.order}:${s.object}`)).toEqual(['0:Account', '1:Contact']);
    expect(p.steps[1]?.parent).toEqual({ field: 'AccountId', stepId: 'Account' });
    expect(p.steps[0]?.fields['QA_Run_Id__c']).toBe('run-file-1');
    expect(p.steps[1]?.uniqueKey.field).toBe('LastName');
    expect(p.negatives[0]?.expectedErrorCodes).toEqual(['REQUIRED_FIELD_MISSING']);
  });

  it('plan validation refuses invented, invalid or unsafe values (never invents business values)', () => {
    const bad: Recipe = {
      ...RECIPE,
      objects: [
        {
          object: 'Account',
          recordType: null,
          fields: { Name: 'QA-{runId}-X {synthetic}', Industry: 'Mining', Nope__c: 'x' },
        },
        {
          object: 'Contact',
          recordType: null,
          parent: { field: 'AccountId', ref: 'Account' },
          fields: { FirstName: '{synthetic}', Email: 'someone@gmail.com' },
        },
      ],
    };
    const p = plan('run-bad-1', bad);
    const codes = p.issues.filter((i) => i.severity === 'ERROR').map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'INVALID_PICKLIST_VALUE',
        'UNKNOWN_FIELD',
        'EMAIL_DOMAIN_NOT_ALLOWED',
        'REQUIRED_FIELD_MISSING', // Contact.LastName has no value
        'NO_UNIQUE_KEY',
      ]),
    );
    expect(p.valid).toBe(false);
    expect(plan('run-bad-2', RECIPE, { runTagField: 'Missing_Tag__c' }).issues.map((i) => i.code)).toContain(
      'RUN_TAG_FIELD_MISSING',
    );
    expect(plan('x'.repeat(81), RECIPE).issues.map((i) => i.code)).toContain('RUN_TAG_TOO_LONG');
    // An invalid plan is never executed.
    const engine = new DataEngine({ sf, plan: p, ledger: new WriteLedger(), org });
    return expect(engine.create()).rejects.toThrow(/plan has errors/);
  });

  it('synthetic values are deterministic per run (stable across resume) and differ between runs', () => {
    expect(syntheticToken('run-a', 'Contact', 'LastName')).toBe(syntheticToken('run-a', 'Contact', 'LastName'));
    expect(syntheticToken('run-a', 'Contact', 'LastName')).not.toBe(syntheticToken('run-b', 'Contact', 'LastName'));
    expect(plan('run-syn-1').steps[1]?.fields['LastName']).toMatch(/^QA-run-syn-1-[0-9a-z]{8}$/);
  });

  it('full cycle: create in order → verify (AccountId link) → negative rejected → reverse cleanup → re-query 0', async () => {
    const p = plan('run-cycle-1');
    const ledger = new WriteLedger(join(dir, 'cycle', 'writes.jsonl'));
    const engine = new DataEngine({ sf, plan: p, ledger, org });
    const created = await engine.create();
    expect(created.map((c) => c.object)).toEqual(['Account', 'Contact']);

    const verify = await engine.verify();
    expect(verify.every((v) => v.ok)).toBe(true);
    expect(verify[1]?.checks.find((c) => c.field === 'AccountId')).toMatchObject({
      ok: true,
      expected: engine.recordId('Account'),
    });

    const neg = await engine.negatives();
    expect(neg).toEqual([expect.objectContaining({ name: 'missing-last-name', outcome: 'REJECTED_AS_EXPECTED' })]);
    expect(neg[0]?.errorCodes).toContain('REQUIRED_FIELD_MISSING');

    const cleanup = await engine.cleanup();
    expect(cleanup.entries.map((e) => `${e.object}:${e.action}`)).toEqual(['Contact:DELETED', 'Account:DELETED']);
    expect(cleanup.verify.remaining).toEqual([]);
    expect(cleanup.verify.queries.join(' ')).toMatch(/QA_Run_Id__c = 'run-cycle-1'/);
    expect(cleanup.status).toBe('CLEAN');
    expect(ledger.all().filter((w) => w.state === 'CONFIRMED')).toEqual([]);

    const md = renderDataReport({ plan: p, created, verify, negatives: neg, cleanup });
    expect(md).toContain('FIXTURE');
    expect(md).not.toContain(engine.recordId('Account')); // ids masked in the Markdown report
  });

  it('uncertain write: reconciled by query, adopted (no second record), never blind-retried', async () => {
    const p = plan('run-uncertain-1');
    let calls = 0;
    const flaky = {
      query: sf.query.bind(sf),
      update: sf.update.bind(sf),
      destroy: sf.destroy.bind(sf),
      create: async (o: string, r: Record<string, unknown>, i?: Parameters<GuardedSalesforce['create']>[2]) => {
        const id = await sf.create(o, r, i);
        if (o === 'Account' && calls++ === 0) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        return id;
      },
    };
    const engine = new DataEngine({ sf: flaky, plan: p, ledger: new WriteLedger(), org });
    await engine.create();
    const accounts = await sf.query<{ Id: string }>("SELECT Id FROM Account WHERE QA_Run_Id__c = 'run-uncertain-1'");
    expect(accounts).toHaveLength(1);
    expect(engine.recordId('Account')).toBe(accounts[0]?.Id);
    expect((await engine.cleanup()).status).toBe('CLEAN');
  });

  it('uncertain write that did not happen: reconciled → PLANNED → sent once more', async () => {
    const p = plan('run-uncertain-2');
    let failed = false;
    const lossy = {
      query: sf.query.bind(sf),
      update: sf.update.bind(sf),
      destroy: sf.destroy.bind(sf),
      create: (o: string, r: Record<string, unknown>, i?: Parameters<GuardedSalesforce['create']>[2]) => {
        if (o === 'Account' && !failed) {
          failed = true;
          return Promise.reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
        }
        return sf.create(o, r, i);
      },
    };
    const engine = new DataEngine({ sf: lossy, plan: p, ledger: new WriteLedger(), org });
    await engine.create();
    expect(await sf.query("SELECT Id FROM Account WHERE QA_Run_Id__c = 'run-uncertain-2'")).toHaveLength(1);
    expect((await engine.cleanup()).status).toBe('CLEAN');
  });

  it('partial failure: a rejected child is FAILED, the created parent is still cleaned up', async () => {
    const p = plan('run-partial-1');
    const contact = p.steps[1];
    if (contact) contact.fields['LastName'] = 'x'.repeat(81) + 'run-partial-1'; // STRING_TOO_LONG in the org
    const ledger = new WriteLedger();
    const engine = new DataEngine({ sf, plan: p, ledger, org });
    await expect(engine.create()).rejects.toThrow(/STRING_TOO_LONG/);
    expect(ledger.all().find((w) => w.object === 'Contact')?.state).toBe('FAILED');
    const c = await engine.cleanup();
    expect(c.entries.map((e) => `${e.object}:${e.action}`)).toEqual(['Account:DELETED']);
    expect(c.status).toBe('CLEAN');
  });

  it('crash + resume: confirmed writes are reused from the ledger file, nothing is created twice', async () => {
    const p = plan('run-resume-1');
    const file = join(dir, 'resume', 'writes.jsonl');
    const first = new DataEngine({ sf, plan: p, ledger: new WriteLedger(file), org });
    await first.create();
    const resumed = new DataEngine({ sf, plan: p, ledger: new WriteLedger(file), org });
    await resumed.create();
    expect(await sf.query("SELECT Id FROM Contact WHERE QA_Run_Id__c = 'run-resume-1'")).toHaveLength(1);
    expect((await resumed.cleanup()).status).toBe('CLEAN');
  });

  it('cleanup refuses (HARD_STOP) a ledger record that no longer carries this run tag', async () => {
    const p = plan('run-untagged-1');
    const engine = new DataEngine({ sf, plan: p, ledger: new WriteLedger(), org });
    await engine.create();
    await sf.update('Contact', engine.recordId('Contact'), { QA_Run_Id__c: 'someone-else' });
    await expect(engine.cleanup()).rejects.toBeInstanceOf(HardStopError);
    // Tidy up the fixture through the guard as a normal (non-cleanup) owner of the test.
    await sf.update('Contact', engine.recordId('Contact'), { QA_Run_Id__c: 'run-untagged-1' });
    expect((await engine.cleanup()).status).toBe('CLEAN');
  });

  it('adopts a UI-created record only by a run-unique value, tags it, and cleans it up', async () => {
    const p = plan('run-adopt-1');
    const engine = new DataEngine({ sf, plan: p, ledger: new WriteLedger(), org });
    await engine.create();
    const uiName = 'QA-run-adopt-1-ui';
    await sf.create('Contact', { LastName: uiName, AccountId: engine.recordId('Account') }); // "created in the UI"
    await expect(engine.adopt('uiContact', 'Contact', 'LastName', 'Seed')).rejects.toBeInstanceOf(QAError);
    const id = await engine.adopt('uiContact', 'Contact', 'LastName', uiName);
    const tagged = await sf.query<{ QA_Run_Id__c: string }>(`SELECT QA_Run_Id__c FROM Contact WHERE Id = '${id}'`);
    expect(tagged[0]?.QA_Run_Id__c).toBe('run-adopt-1');
    const c = await engine.cleanup();
    expect(c.entries.map((e) => e.object)).toEqual(['Contact', 'Contact', 'Account']);
    expect(c.status).toBe('CLEAN');
  });

  it('adoptCreated (code-owned cleanup): only a record this user created during the test; tags and cleans it up', async () => {
    const p = plan('run-adopt-2');
    const engine = new DataEngine({ sf, plan: p, ledger: new WriteLedger(), org });
    await engine.create();
    const since = new Date(Date.now() - 60_000);
    const ui = await sf.create('Contact', { LastName: 'Saved in the UI', AccountId: engine.recordId('Account') });
    const me = sf.identity.userId;
    // someone else's record / a record from before the test / a malformed id are refused before any write
    await expect(engine.adoptCreated('c', 'Contact', ui, '005000000000999AAA', since)).rejects.toThrow(
      /not created by/,
    );
    await expect(engine.adoptCreated('c', 'Contact', ui, me, new Date(Date.now() + 60_000))).rejects.toThrow(
      /not created by/,
    );
    await expect(engine.adoptCreated('c', 'Contact', "x' OR Id != '", me, since)).rejects.toThrow(/invalid/);
    expect(await engine.adoptCreated('uiContact', 'Contact', ui, me, since)).toBe(ui);
    const tagged = await sf.query<{ QA_Run_Id__c: string }>(`SELECT QA_Run_Id__c FROM Contact WHERE Id = '${ui}'`);
    expect(tagged[0]?.QA_Run_Id__c).toBe('run-adopt-2');
    expect(engine.recordId('uiContact')).toBe(ui);
    const c = await engine.cleanup();
    expect(c.status).toBe('CLEAN');
    expect(await sf.query(`SELECT Id FROM Contact WHERE Id = '${ui}'`)).toHaveLength(0);
  });

  it('a profile without mutations refuses the write through the guard (no ledger record is confirmed)', async () => {
    const ro: OrgsConfig = { orgs: [org], profiles: { 'offline-fixture': { mutations: 'none' } } };
    const roSf = await connectSalesforce({
      provider: new FixtureSessionProvider(seed),
      org,
      orgs: ro,
      persona: admin,
      runId: 'run-ro',
      registry: new IdentityRegistry(),
    });
    const ledger = new WriteLedger();
    const engine = new DataEngine({ sf: roSf, plan: plan('run-ro-1'), ledger, org });
    await expect(engine.create()).rejects.toThrow();
    expect(ledger.all().some((w) => w.state === 'CONFIRMED')).toBe(false);
  });

  it('runner reconciliation: a crashed sub-run is cleaned from its ledger; a stray run-tagged record is reported', async () => {
    const runDir = join(dir, 'run-recon-1');
    const subDir = join(runDir, 'data', 'aaaaaa');
    // A test that died before its teardown: plan written up front (as the data fixture does), records created.
    const p = plan('run-recon-1-aaaaaa');
    writeDataOutputs(subDir, { plan: p });
    await new DataEngine({ sf, plan: p, ledger: new WriteLedger(join(subDir, 'writes.jsonl')), org }).create();
    const clean = await reconcileRun({ runId: 'run-recon-1', runDir, org, sf });
    expect(clean.subRuns.map((x) => x.status)).toEqual(['CLEAN']);
    expect(clean.queries.join(' ')).toMatch(/QA_Run_Id__c LIKE 'run-recon-1-%'/);
    expect(clean.status).toBe('CLEAN');

    // A run-tagged record no sub-run knows: reported (never deleted by the prefix query) → INCOMPLETE.
    const stray = await sf.create('Account', { Name: 'QA-stray', QA_Run_Id__c: 'run-recon-1-ffffff' });
    const dirty = await reconcileRun({ runId: 'run-recon-1', runDir, org, sf });
    expect(dirty.status).toBe('INCOMPLETE');
    expect(dirty.remaining).toEqual([{ object: 'Account', recordId: stray }]);
    await sf.destroy('Account', stray, { cleanup: true, untaggedCount: 0 });

    // A sub-run ledger without a plan is listed, not guessed at.
    const orphan = join(runDir, 'data', 'bbbbbb');
    const l = new WriteLedger(join(orphan, 'writes.jsonl'));
    l.plan({ runId: 'run-recon-1-bbbbbb', object: 'Account', step: 'Account', fields: {} });
    const noPlan = await reconcileRun({ runId: 'run-recon-1', runDir, org, sf });
    expect(noPlan.subRuns.find((x) => x.dir === orphan)?.status).toBe('CLEAN'); // only PLANNED: nothing to clean
    expect(subRunDirs(runDir)).toHaveLength(2);
  });

  it('reads Salesforce error codes from jsforce-style errors', () => {
    expect(
      sfErrorCodes(
        Object.assign(new Error('Required fields are missing: [LastName]'), { errorCode: 'REQUIRED_FIELD_MISSING' }),
      ),
    ).toEqual(['REQUIRED_FIELD_MISSING']);
    expect(sfErrorCodes(new Error('FIELD_CUSTOM_VALIDATION_EXCEPTION: Enter a 10-digit phone number.'))).toContain(
      'FIELD_CUSTOM_VALIDATION_EXCEPTION',
    );
  });
});

describe('human checkpoints for new recipes', () => {
  const policy = { approvals: { L1: 'all', L2: [NEW_RECIPE_CHECKPOINT], L3: [] } } as unknown as PolicyConfig;

  it('applies per autonomy level and records approvals per recipe version and org', () => {
    expect(checkpointRequired(policy, 'L1', NEW_RECIPE_CHECKPOINT)).toBe(true);
    expect(checkpointRequired(policy, 'L2', NEW_RECIPE_CHECKPOINT)).toBe(true);
    expect(checkpointRequired(policy, 'L3', NEW_RECIPE_CHECKPOINT)).toBe(false);
    const store = new ApprovalStore(join(mkdtempSync(join(tmpdir(), 'qa approvals ')), 'approvals.jsonl'));
    const subject = recipeSubject('account-contact', recipeHash(RECIPE));
    expect(store.find(NEW_RECIPE_CHECKPOINT, subject, '00DFIXTURE00000001')).toBeUndefined();
    const a = store.record({
      checkpoint: NEW_RECIPE_CHECKPOINT,
      subject,
      orgId: '00DFIXTURE00000001',
      approvedBy: 'Test Approver',
    });
    expect(store.find(NEW_RECIPE_CHECKPOINT, subject, '00DFIXTURE00000001')?.id).toBe(a.id);
    // A changed recipe is a new subject: needs a new approval. Another org too.
    const changed = recipeSubject('account-contact', recipeHash({ ...RECIPE, approvedBy: 'Someone Else' }));
    expect(store.find(NEW_RECIPE_CHECKPOINT, changed, '00DFIXTURE00000001')).toBeUndefined();
    expect(store.find(NEW_RECIPE_CHECKPOINT, subject, '00DdN00000uQ5dKUAS')).toBeUndefined();
  });
});
