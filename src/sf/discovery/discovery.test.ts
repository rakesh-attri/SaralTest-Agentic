import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgEntry, OrgsConfig, Persona } from '../../config/schemas.js';
import { QAError } from '../../core/errors.js';
import { startFixtureServer, type FixtureServer } from '../../fixture/server.js';
import { loadSeed } from '../../fixture/store.js';
import { REPO_ROOT } from '../../../tests/helpers/tempProject.js';
import { FixtureSessionProvider } from '../auth/fixture.js';
import { connectSalesforce, IdentityRegistry, type GuardedSalesforce } from '../client.js';
import { decodeValidFor, flowRefs, formulaFieldRefs, runDiscovery, type SfReader } from './index.js';

const seed = loadSeed(join(REPO_ROOT, 'examples', 'fixture', 'seed.json'));
const admin: Persona = {
  id: 'system-admin',
  username: 'qa.admin@fixture.example.invalid',
  sfAlias: 'fixture',
  profile: 'System Administrator',
  permissionSets: [],
  use: ['default-execution'],
};

describe('formula and flow reference parsing', () => {
  it('finds fields, skips functions, literals and globals, resolves relationships', () => {
    const rels = new Map([['account', { field: 'AccountId', target: 'Account' }]]);
    const r = formulaFieldRefs(
      'AND(NOT(ISBLANK(Phone)), NOT(REGEX(Phone, "\\\\d{10} Email")), Account.Industry = "Tech", $User.Id <> OwnerId)',
      'Contact',
      rels,
    );
    expect(r.fields).toEqual(['Account.Industry', 'Contact.AccountId', 'Contact.OwnerId', 'Contact.Phone']);
    expect(r.globals).toEqual(['$User.Id']);
  });
  it('decodes dependent picklist validFor bitmaps', () => {
    // 0b10100000 → valid for controlling values #0 and #2
    expect(decodeValidFor(Buffer.from([0b10100000]).toString('base64'), ['A', 'B', 'C', 'D'])).toEqual(['A', 'C']);
  });
  it('extracts objects and fields a flow reads and writes', () => {
    const r = flowRefs({
      start: { object: 'Contact', filters: [{ field: 'AccountId' }] },
      recordUpdates: [{ object: 'Account', inputAssignments: [{ field: 'Number_of_Contacts__c' }] }],
    });
    expect(r.triggerObject).toBe('Contact');
    expect(r.fields).toEqual([
      { field: 'Contact.AccountId', kind: 'flow-reads-field' },
      { field: 'Account.Number_of_Contacts__c', kind: 'flow-writes-field' },
    ]);
  });
});

describe('runDiscovery on the offline fixture (FIXTURE)', () => {
  let server: FixtureServer;
  let sf: GuardedSalesforce;

  beforeAll(async () => {
    server = await startFixtureServer({ fixtureDir: join(REPO_ROOT, 'examples', 'fixture'), port: 0 });
    const org: OrgEntry = {
      orgId: seed.organization.Id,
      alias: 'fixture',
      profile: 'offline-fixture',
      instanceUrl: server.url,
      release: 'fixture',
      runTagField: 'QA_Run_Id__c',
      environment: 'FIXTURE',
    };
    const orgs: OrgsConfig = { orgs: [org], profiles: { 'offline-fixture': { mutations: 'allowed' } } };
    sf = await connectSalesforce({
      provider: new FixtureSessionProvider(seed),
      org,
      orgs,
      persona: admin,
      runId: 'run-t3',
      registry: new IdentityRegistry(),
    });
  });
  afterAll(async () => {
    await server.close();
  });

  it('harvests every area for Account + Contact with dependencies', async () => {
    const r = await runDiscovery({
      sf,
      environment: 'FIXTURE',
      orgId: seed.organization.Id,
      apiVersion: '62.0',
      objects: ['Account', 'Contact'],
    });
    expect(r.areas.filter((a) => !a.ok)).toEqual([]);
    const byType = (t: string): string[] => r.components.filter((c) => c.type === t).map((c) => c.apiName);
    expect(byType('SObject')).toEqual(['Account', 'Contact']);
    expect(byType('Field')).toContain('Contact.Phone');
    // Phone_Format is the fixture's own rule; the other three are FIXTURE copies of qa-prod rules (Phase 5 parity).
    expect(byType('ValidationRule')).toEqual([
      'Contact.Phone_Format',
      'Contact.Phone_Must_Be_10_Digits',
      'Contact.Phone_Required_For_Web',
      'Contact.Title_Must_Be_Approved',
    ]);
    expect(byType('ApexTrigger')).toEqual(['Contact.ContactTrigger']);
    expect(byType('Flow')).toEqual(['Account_Contact_Count']);
    expect(byType('Layout')).toEqual(['Account.Account Layout', 'Contact.Contact Layout']);
    expect(byType('ObjectPermissions')).toContain('Profile:Read Only.Contact');
    expect(byType('FieldPermissions')).toContain('PermissionSet:Contact_Editor.Contact');
    expect(byType('DuplicateRule')).toEqual(['Contact.Standard_Contact_Duplicate_Rule']);
    expect(byType('CustomSetting')).toEqual(['QA_Setting__c']);
    expect(byType('CustomMetadataType')).toEqual(['Contact_Rule__mdt']);

    const lastName = r.components.find((c) => c.apiName === 'Contact.LastName');
    expect(lastName?.body['required']).toBe(true);
    const contact = r.components.find((c) => c.type === 'SObject' && c.apiName === 'Contact');
    expect(contact?.body['sharing']).toEqual({ internal: 'ControlledByParent', external: 'ControlledByParent' });
    const vr = r.components.find((c) => c.type === 'ValidationRule');
    expect(vr?.body['errorConditionFormula']).toMatch(/REGEX\(Phone/);

    const has = (from: string, to: string, kind: string): boolean =>
      r.dependencies.some((d) => d.fromName === from && d.toName === to && d.kind === kind);
    expect(has('Contact.Phone_Format', 'Contact.Phone', 'references')).toBe(true);
    expect(has('Account_Contact_Count', 'Account.Number_of_Contacts__c', 'flow-writes-field')).toBe(true);
    expect(has('Contact.AccountId', 'Account', 'lookup')).toBe(true);
    expect(has('Contact.ContactTrigger', 'ContactService', 'depends-on')).toBe(true); // MCD resolved via sfId
    expect(has('Account_Contact_Count', 'Account.Number_of_Contacts__c', 'depends-on')).toBe(true); // MCD via CustomField id
    // No record data in discovery output
    expect(JSON.stringify(r.components)).not.toContain('seed.contact@fixture.example.invalid');
  });

  it('an unreadable area becomes UNKNOWN placeholders, never "missing", and discovery continues', async () => {
    const broken: SfReader = {
      describe: (o) => sf.describe(o),
      describeGlobal: () => sf.describeGlobal(),
      query: (q, opts) =>
        /FROM ValidationRule/.test(q)
          ? Promise.reject(Object.assign(new Error('insufficient access'), { errorCode: 'INSUFFICIENT_ACCESS' }))
          : sf.query(q, opts),
    };
    const r = await runDiscovery({
      sf: broken,
      environment: 'FIXTURE',
      orgId: seed.organization.Id,
      apiVersion: '62.0',
      objects: ['Contact'],
    });
    const vrArea = r.areas.find((a) => a.area === 'validationRules');
    expect(vrArea?.ok).toBe(false);
    const placeholder = r.components.find((c) => c.type === 'ValidationRule');
    expect(placeholder).toMatchObject({ apiName: 'Contact.*', evidenceStatus: 'UNKNOWN' });
    expect(r.components.some((c) => c.type === 'Flow')).toBe(true); // later areas still ran
  });

  it('transient failures are retried; describe failure stops discovery (critical area)', async () => {
    let calls = 0;
    const flaky: SfReader = {
      describe: (o) => sf.describe(o),
      describeGlobal: () => sf.describeGlobal(),
      query: (q, opts) => {
        if (/FROM ApexTrigger/.test(q) && calls++ === 0)
          return Promise.reject(new QAError('TRANSIENT', 'socket hang up'));
        return sf.query(q, opts);
      },
    };
    const r = await runDiscovery({
      sf: flaky,
      environment: 'FIXTURE',
      orgId: seed.organization.Id,
      apiVersion: '62.0',
      objects: ['Contact'],
      retry: { maxAttempts: 3, backoffSeconds: [0], sleep: () => Promise.resolve() },
    });
    expect(r.areas.find((a) => a.area === 'apex')?.ok).toBe(true);

    const noDescribe: SfReader = { ...flaky, describe: () => Promise.reject(new QAError('AUTH', 'expired')) };
    const r2 = await runDiscovery({
      sf: noDescribe,
      environment: 'FIXTURE',
      orgId: seed.organization.Id,
      apiVersion: '62.0',
      objects: ['Contact'],
    });
    expect(r2.areas).toHaveLength(1);
    expect(r2.components.every((c) => c.evidenceStatus === 'UNKNOWN')).toBe(true);
  });
});
