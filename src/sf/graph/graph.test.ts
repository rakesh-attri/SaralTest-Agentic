import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgEntry, OrgsConfig, Persona } from '../../config/schemas.js';
import { loadFixtureMetadata } from '../../fixture/metadata.js';
import { startFixtureServer, type FixtureServer } from '../../fixture/server.js';
import { loadSeed } from '../../fixture/store.js';
import { diffSnapshots } from '../../knowledge/diff.js';
import { SnapshotStore } from '../../knowledge/snapshotStore.js';
import { REPO_ROOT } from '../../../tests/helpers/tempProject.js';
import { FixtureSessionProvider } from '../auth/fixture.js';
import { connectSalesforce, IdentityRegistry, type GuardedSalesforce } from '../client.js';
import { runDiscovery } from '../discovery/index.js';
import { GraphStore, impactOfDiff, linkAssets, nodeId, rebuildGraph, type TestAsset } from './index.js';

const FIXTURE_DIR = join(REPO_ROOT, 'examples', 'fixture');
const seed = loadSeed(join(FIXTURE_DIR, 'seed.json'));
const admin: Persona = {
  id: 'system-admin',
  username: 'qa.admin@fixture.example.invalid',
  sfAlias: 'fixture',
  profile: 'System Administrator',
  permissionSets: [],
  use: ['default-execution'],
};

const assets: TestAsset[] = [
  {
    type: 'ManualTest',
    id: 'MTC-005',
    label: 'Phone must be 10 digits',
    text: 'New Contact\nEnter Phone 12345\nSave\nSave blocked; error on Phone',
  },
  {
    type: 'ManualTest',
    id: 'MTC-003',
    label: 'Invalid email rejected',
    text: "New Contact\nEnter Email 'john.example.com'\nSave",
  },
  {
    type: 'Requirement',
    id: 'SF-219-R05',
    label: 'Phone format',
    text: 'AC5 Phone format: when the Phone is not 10 digits the Contact is not saved',
  },
  {
    type: 'Requirement',
    id: 'SF-219-R09',
    label: 'Contact count',
    text: 'BR-09 Number_of_Contacts__c on the Account updates immediately',
  },
];

describe('asset linking (deterministic text match)', () => {
  it('links by field label/API name inside the objects the text names, with the matched term as evidence', () => {
    const components = [
      {
        snapshotId: 's',
        type: 'SObject',
        apiName: 'Contact',
        label: 'Contact',
        hash: 'h',
        dataScope: 'metadata',
        evidenceStatus: 'DECLARED' as const,
        reviewStatus: 'APPROVED' as const,
        body: {},
      },
      {
        snapshotId: 's',
        type: 'SObject',
        apiName: 'Account',
        label: 'Account',
        hash: 'h',
        dataScope: 'metadata',
        evidenceStatus: 'DECLARED' as const,
        reviewStatus: 'APPROVED' as const,
        body: {},
      },
      {
        snapshotId: 's',
        type: 'Field',
        apiName: 'Contact.Phone',
        label: 'Business Phone',
        parent: 'Contact',
        hash: 'h',
        dataScope: 'metadata',
        evidenceStatus: 'DECLARED' as const,
        reviewStatus: 'APPROVED' as const,
        body: {},
      },
      {
        snapshotId: 's',
        type: 'Field',
        apiName: 'Account.Phone',
        label: 'Account Phone',
        parent: 'Account',
        hash: 'h',
        dataScope: 'metadata',
        evidenceStatus: 'DECLARED' as const,
        reviewStatus: 'APPROVED' as const,
        body: {},
      },
      {
        snapshotId: 's',
        type: 'Field',
        apiName: 'Contact.LastName',
        label: 'Last Name',
        parent: 'Contact',
        hash: 'h',
        dataScope: 'metadata',
        evidenceStatus: 'DECLARED' as const,
        reviewStatus: 'APPROVED' as const,
        body: {},
      },
      {
        snapshotId: 's',
        type: 'Field',
        apiName: 'Account.Name',
        label: 'Account Name',
        parent: 'Account',
        hash: 'h',
        dataScope: 'metadata',
        evidenceStatus: 'DECLARED' as const,
        reviewStatus: 'APPROVED' as const,
        body: {},
      },
    ];
    const { edges } = linkAssets(
      [{ type: 'ManualTest', id: 'T1', label: 't', text: 'New Contact: enter Last Name and Phone' }],
      components,
    );
    const to = edges.map((e) => `${e.kind} ${e.to} [${e.evidence ?? ''}]`);
    expect(to).toEqual([
      'covers-object SObject:Contact [Contact]',
      'covers Field:Contact.Phone [Phone]',
      'covers Field:Contact.LastName [LastName]'.replace('[LastName]', '[Last Name]'),
    ]);
  });
});

describe('fixture end to end: changed validation rule → diff → impact → RE_VERIFY', () => {
  let server: FixtureServer;
  let sf: GuardedSalesforce;
  const org: OrgEntry = {
    orgId: seed.organization.Id,
    alias: 'fixture',
    profile: 'offline-fixture',
    instanceUrl: '',
    release: 'fixture',
    runTagField: 'QA_Run_Id__c',
    environment: 'FIXTURE',
  };

  beforeAll(async () => {
    server = await startFixtureServer({ fixtureDir: FIXTURE_DIR, port: 0 });
    org.instanceUrl = server.url;
    const orgs: OrgsConfig = { orgs: [org], profiles: { 'offline-fixture': { mutations: 'allowed' } } };
    sf = await connectSalesforce({
      provider: new FixtureSessionProvider(seed),
      org,
      orgs,
      persona: admin,
      runId: 'run-t5',
      registry: new IdentityRegistry(),
    });
  });
  afterAll(async () => {
    await server.close();
  });

  it('flags the manual test and requirement that depend on the changed rule, with the edge path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'graph test '));
    const snaps = new SnapshotStore(join(dir, 'knowledge.db'));
    const graph = new GraphStore(join(dir, 'graph.db'));
    const discover = () =>
      runDiscovery({
        sf,
        environment: 'FIXTURE',
        orgId: org.orgId,
        apiVersion: '62.0',
        objects: ['Account', 'Contact'],
      });

    const one = snaps.save({ discovery: await discover(), orgAlias: 'fixture', release: 'fixture' });
    const counts = rebuildGraph(graph, one, assets);
    expect(counts.edges).toBeGreaterThan(30);

    server.setMetadata(loadFixtureMetadata(join(FIXTURE_DIR, 'metadata.changed-vr.json')));
    const d2 = await discover();
    const two = snaps.save({
      discovery: { ...d2, finishedAt: new Date(Date.parse(d2.finishedAt) + 1000).toISOString() },
      orgAlias: 'fixture',
      release: 'fixture',
    });

    const diff = diffSnapshots(
      { id: one.info.id, orgId: org.orgId, objects: one.info.objects, components: one.components },
      { id: two.info.id, orgId: org.orgId, objects: two.info.objects, components: two.components },
    );
    expect(diff.entries).toEqual([
      expect.objectContaining({
        type: 'ValidationRule',
        apiName: 'Contact.Phone_Format',
        change: 'changed',
        changedKeys: ['errorConditionFormula', 'errorMessage'],
      }),
    ]);

    rebuildGraph(graph, two, assets);
    const impact = impactOfDiff(graph, diff);
    const flagged = impact.reverify.map((r) => `${r.assetType}:${r.assetId}`).sort();
    expect(flagged).toEqual(['manual-test:MTC-005', 'requirement:SF-219-R05']);
    const mtc = impact.reverify.find((r) => r.assetId === 'MTC-005');
    expect(mtc?.path.join(' | ')).toContain('ManualTest:MTC-005 -covers-> Field:Contact.Phone');
    expect(mtc?.path.join(' | ')).toMatch(
      /ValidationRule:Contact.Phone_Format -(references|error-on)-> Field:Contact.Phone/,
    );
    // The email test does not depend on the phone rule
    expect(flagged).not.toContain('manual-test:MTC-003');

    snaps.markReverify(impact.reverify);
    expect(snaps.openReverify('manual-test').map((m) => m.assetId)).toEqual(['MTC-005']);
    snaps.close();
    graph.close();
  });

  it('impact of a field change reaches rules, layouts, flows and assets within depth 3', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'graph test '));
    const snaps = new SnapshotStore(join(dir, 'knowledge.db'));
    const graph = new GraphStore(join(dir, 'graph.db'));
    const snap = snaps.save({
      discovery: await runDiscovery({
        sf,
        environment: 'FIXTURE',
        orgId: org.orgId,
        apiVersion: '62.0',
        objects: ['Account', 'Contact'],
      }),
      orgAlias: 'fixture',
      release: 'fixture',
    });
    rebuildGraph(graph, snap, assets);
    const ids = graph.impact(org.orgId, [nodeId('Field', 'Account.Number_of_Contacts__c')]).map((i) => i.node.id);
    expect(ids).toEqual(
      expect.arrayContaining(['Flow:Account_Contact_Count', 'Layout:Account.Account Layout', 'Requirement:SF-219-R09']),
    );
    expect(graph.impact(org.orgId, [])).toEqual([]);
    snaps.close();
    graph.close();
  });
});
