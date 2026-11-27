import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgEntry, OrgsConfig, Persona } from '../../config/schemas.js';
import { AnalysisFinding, Requirement } from '../../core/schemas/index.js';
import { loadFixtureMetadata } from '../../fixture/metadata.js';
import { startFixtureServer, type FixtureServer } from '../../fixture/server.js';
import { loadSeed } from '../../fixture/store.js';
import { SnapshotStore } from '../../knowledge/snapshotStore.js';
import { REPO_ROOT } from '../../../tests/helpers/tempProject.js';
import { FixtureSessionProvider } from '../../sf/auth/fixture.js';
import { connectSalesforce, IdentityRegistry, type GuardedSalesforce } from '../../sf/client.js';
import { runDiscovery } from '../../sf/discovery/index.js';
import { assetsFrom, GraphStore } from '../../sf/graph/index.js';
import { crossCheckEvidence, crossCheckFindings, crossCheckRequirements } from './crossCheck.js';
import { discoverOrg } from './discover.js';
import { OrgCrossCheck } from './schema.js';

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

const req = (n: number, section: string, text: string, personas: string[] = []): Requirement =>
  Requirement.parse({
    id: `T-R${String(n).padStart(2, '0')}`,
    title: text.slice(0, 40),
    businessObjective: text,
    actors: personas,
    personas,
    preconditions: [],
    actions: [],
    businessRules: [],
    expectedOutcomes: [],
    dependencies: [],
    dataRequirements: [],
    risk: 'MEDIUM',
    assumptions: { known: [], unknown: [] },
    sources: [{ type: 'file', ref: 'story.md', hash: 'h', section }],
    type: 'functional',
    status: 'EXECUTABLE',
  });

const requirements: Requirement[] = [
  req(1, 'AC5', 'When the Contact Phone is not 10 digits the Contact is not saved'),
  req(2, 'AC2', 'Last Name is required on the Contact'),
  req(3, 'BR-03', 'Email is required for every Contact'),
  req(4, 'BR-09', 'Number_of_Contacts__c on the Account updates immediately when a Contact is added'),
  req(
    5,
    'AC4',
    'When a Contact with the same Email exists, the user is warned that a possible duplicate Contact exists',
  ),
  req(6, 'AC6', 'A Read Only user cannot create or edit Contacts', ['Read Only User']),
  req(7, 'BR-11', 'Region__c on the Contact must be set'),
  req(8, 'AC1', 'A Sales Rep creates a Contact', ['Sales Rep']),
  req(9, 'BR-06', 'Title must be chosen from an approved list on the Contact'),
];

describe('Salesforce Intelligence on the offline fixture (FIXTURE)', () => {
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
      runId: 'run-t6',
      registry: new IdentityRegistry(),
    });
  });
  afterAll(async () => {
    await server.close();
  });

  it('cross-checks requirements deterministically against the snapshot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xcheck '));
    const store = new SnapshotStore(join(dir, 'knowledge.db'));
    const snap = store.save({
      discovery: await runDiscovery({
        sf,
        environment: 'FIXTURE',
        orgId: org.orgId,
        apiVersion: '62.0',
        objects: ['Account', 'Contact'],
      }),
      orgAlias: 'fixture',
      release: 'fixture',
      persona: 'system-admin',
    });
    const finding = AnalysisFinding.parse({
      id: 'F-009',
      kind: 'ORG_CHECK_NEEDED',
      text: 'Custom component Number_of_Contacts__c is referenced: verify it exists in the org',
      refs: ['BR-09'],
      requirementIds: ['T-R04'],
      severity: 'LOW',
      origin: 'lint',
      rule: 'custom-component',
    });
    const cc = OrgCrossCheck.parse(
      crossCheckRequirements({
        snapshot: snap,
        requirements,
        findings: [finding],
        configuredPersonas: ['system-admin'],
      }),
    );
    const by = (subject: RegExp): string | undefined => cc.checks.find((c) => subject.test(c.subject))?.result;

    expect(by(/Phone must have 10 digits/)).toBe('CONSISTENT'); // fixture VR Contact.Phone_Format
    expect(by(/Last Name is required/)).toBe('CONSISTENT');
    expect(by(/Email is required/)).toBe('CONFLICT');
    expect(by(/Account\.Number_of_Contacts__c exists/)).toBe('EXISTS');
    expect(by(/what keeps Account\.Number_of_Contacts__c up to date/)).toBe('CONSISTENT'); // flow writes it
    expect(by(/duplicate rule exists on Contact/)).toBe('CONSISTENT');
    expect(by(/persona "Read Only User"/)).toBe('EXISTS');
    expect(by(/Read Only cannot create or edit Contact/)).toBe('CONSISTENT');
    expect(by(/Region__c exists/)).toBe('NOT_FOUND');
    expect(by(/persona "Sales Rep"/)).toBe('UNKNOWN');
    // Since Phase 5 the fixture copies qa-prod's Title field + Title_Must_Be_Approved rule: the check is grounded in it.
    expect(by(/Title/)).toBe('CONSISTENT');
    expect(cc.checks.find((c) => /Title/.test(c.subject))?.orgFact).toMatch(/Title/);

    const exists = cc.checks.find((c) => /Number_of_Contacts__c exists/.test(c.subject));
    expect(exists?.findingIds).toEqual(['F-009']);
    expect(exists?.evidenceLevel).toBe('DECLARED_CONFIG');
    const notFound = cc.checks.find((c) => c.result === 'NOT_FOUND');
    expect(notFound?.question).toMatch(/^\[BR-11\] .*Region__c.*Test impact:/);
    expect(cc.checks.every((c) => c.environment === 'FIXTURE')).toBe(true);

    const findings = crossCheckFindings(cc);
    expect(findings.map((f) => AnalysisFinding.parse(f).kind)).toEqual(
      expect.arrayContaining(['ORG_CONFLICT', 'ORG_NOT_FOUND', 'ORG_CHECK_NEEDED']),
    );
    expect(findings.every((f) => f.origin === 'org' && f.refs.length > 0)).toBe(true);
    const evidence = crossCheckEvidence(cc);
    expect(evidence.length).toBe(cc.checks.filter((c) => c.result === 'EXISTS' || c.result === 'CONSISTENT').length);
    expect(evidence.every((e) => e.environment === 'FIXTURE')).toBe(true);
    store.close();
  });

  it('pipeline: baseline → change → diff, impact, RE_VERIFY and a FIXTURE-labelled report', async () => {
    const root = mkdtempSync(join(tmpdir(), 'discover pipeline '));
    const snapshots = new SnapshotStore(join(root, '.qa-memory', 'knowledge.db'));
    const graph = new GraphStore(join(root, '.qa-memory', 'graph.db'));
    const assets = assetsFrom(requirements, [
      {
        id: 'MTC-005',
        title: 'Phone format',
        steps: ['New Contact', 'Enter Phone 12345', 'Save'],
        expected: 'error on Phone',
      },
    ]);
    const base = {
      sf,
      orgAlias: 'fixture',
      release: 'fixture',
      objects: ['Account', 'Contact'],
      root,
      snapshots,
      graph,
      assets,
    };

    const first = await discoverOrg({ ...base, runId: 'run-disc-1', requirements });
    expect(first.diff).toBeUndefined();
    expect(first.crossCheck?.counts.NOT_FOUND).toBe(1);

    server.setMetadata(loadFixtureMetadata(join(FIXTURE_DIR, 'metadata.changed-vr.json')));
    await new Promise((r) => setTimeout(r, 1100)); // distinct snapshot timestamp
    const second = await discoverOrg({ ...base, runId: 'run-disc-2' });
    expect(second.diff?.entries).toEqual([
      expect.objectContaining({ apiName: 'Contact.Phone_Format', change: 'changed' }),
    ]);
    expect([...new Set(second.reverify.map((m) => `${m.assetType}:${m.assetId}`))].sort()).toEqual([
      'manual-test:MTC-005',
      'requirement:T-R01',
    ]);

    const md = readFileSync(join(root, 'runs', 'run-disc-2', 'discovery', 'discovery-report.md'), 'utf8');
    expect(md).toContain('**FIXTURE**');
    expect(md).toMatch(
      /\| changed \| ValidationRule \| Contact\.Phone_Format \| errorConditionFormula, errorMessage \|/,
    );
    expect(md).toContain('manual-test MTC-005');
    for (const f of ['snapshot-summary.json', 'diff.json', 'impact.json']) {
      expect(existsSync(join(root, 'runs', 'run-disc-2', 'discovery', f))).toBe(true);
    }
    expect(existsSync(join(root, 'runs', 'run-disc-1', 'discovery', 'org-crosscheck.json'))).toBe(true);
    server.setMetadata(loadFixtureMetadata(join(FIXTURE_DIR, 'metadata.json')));
    snapshots.close();
    graph.close();
  });
});

describe('cross-check never claims NOT_FOUND for an unreadable scope', () => {
  it('fields area UNKNOWN → existence is UNKNOWN with a question, not NOT_FOUND', () => {
    const placeholder = (type: string, apiName: string, parent?: string) => ({
      snapshotId: 's',
      type,
      apiName,
      ...(parent ? { parent } : {}),
      hash: 'h',
      dataScope: 'metadata',
      evidenceStatus: 'UNKNOWN' as const,
      reviewStatus: 'REVIEW_REQUIRED' as const,
      body: { reason: 'UNKNOWN: unexpected response shape' },
    });
    const snapshot = {
      info: {
        id: 's',
        orgId: '00DFIXTURE00000001',
        orgAlias: 'fixture',
        capturedAt: new Date().toISOString(),
        sourceType: 'METADATA' as const,
        release: 'r',
        environment: 'FIXTURE' as const,
        apiVersion: '62.0',
        objects: ['Account', 'Contact'],
        componentCount: 4,
        unknownCount: 4,
      },
      components: [
        placeholder('SObject', 'Account.*', 'Account'),
        placeholder('Field', 'Account.*', 'Account'),
        placeholder('SObject', 'Contact.*', 'Contact'),
        placeholder('Field', 'Contact.*', 'Contact'),
      ],
      dependencies: [],
    };
    const cc = crossCheckRequirements({ snapshot, requirements: [requirements[3] as Requirement] });
    const c = cc.checks.find((x) => x.check === 'existence');
    expect(c?.result).toBe('UNKNOWN');
    expect(c?.question).toMatch(/could not be verified/);
  });
});

describe('blocksBlank (required vs format rules)', () => {
  it('counts only non-negated blank tests on the field', async () => {
    const { blocksBlank } = await import('./crossCheck.js');
    expect(blocksBlank('ISBLANK(Email)', 'Email')).toBe(true);
    expect(blocksBlank('AND(ISPICKVAL(LeadSource,"Web"), ISBLANK( Phone ))', 'Phone')).toBe(true);
    expect(blocksBlank('LEN(Phone) = 0', 'Phone')).toBe(true);
    // live qa-prod rule: fires only when Phone is filled in → a format rule, not "required"
    expect(blocksBlank('AND( NOT( ISBLANK( Phone ) ), NOT( REGEX( Phone, "[0-9]{10}" ) ) )', 'Phone')).toBe(false);
    expect(blocksBlank('ISBLANK(MobilePhone)', 'Phone')).toBe(false);
  });
});
