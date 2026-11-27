import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Investigation } from '../../core/schemas/index.js';
import { EvidenceLedger } from '../../knowledge/evidenceLedger.js';
import { LocatorRegistry, type LocatorEntry } from '../../knowledge/locatorRegistry.js';
import { ApprovalStore } from '../../security/approvals.js';
import { readWaitOverrides } from '../../runner/waitOverrides.js';
import { buildCatalog, writePageObjects } from '../test-generator/pageObjects.js';
import { assertionFingerprint, assertionItems, fingerprintDiff, sameFingerprint } from './fingerprint.js';
import {
  catalogScopeCheck,
  healFailure,
  readCatalog,
  readRepairs,
  renameInExpression,
  revertRepair,
  type HealDeps,
} from './index.js';

const ORG = '00DdN00000uQ5dKUAS';
const SPEC = `import { test, expect } from '../../fixtures/index.js';
test('TC-SF-1-001 x', async ({ page }) => {
  const d = new NewContactDialog(page);
  await d.saveButton.click();
  await expectToast(page, name);
  await expect(d.root).toBeVisible();
  expect(await soqlValue(sf, 'Contact', id, 'Phone')).toBe('5551234567');
});`;

describe('assertion fingerprint', () => {
  it('collects expect chains, expect* helpers and oracle calls; ignores actions', () => {
    expect(assertionItems(SPEC)).toEqual([
      'expectToast(page,name)',
      'expect(d.root).toBeVisible()',
      "expect(awaitsoqlValue(sf,'Contact',id,'Phone')).toBe('5551234567')",
    ]);
  });

  it('a changed expected value or matcher changes the fingerprint; a locator / action change does not', () => {
    const a = assertionFingerprint(SPEC, [{ check: 'visible' }]);
    expect(
      sameFingerprint(
        a,
        assertionFingerprint(SPEC.replace('saveButton.click()', 'saveRecordButton.click()'), [{ check: 'visible' }]),
      ),
    ).toBe(true);
    const b = assertionFingerprint(SPEC.replace("toBe('5551234567')", "toBe('000')"), [{ check: 'visible' }]);
    expect(sameFingerprint(a, b)).toBe(false);
    expect(fingerprintDiff(a, b).added[0]).toContain("toBe('000')");
    expect(sameFingerprint(a, assertionFingerprint(SPEC, [{ check: 'hidden' }]))).toBe(false);
  });

  it('renames only the last quoted name of an expression', () => {
    expect(
      renameInExpression(
        "getByRole('dialog', { name: 'New Contact' }).getByRole('button', { name: 'Save', exact: true })",
        'Save',
        'Save Record',
      ),
    ).toBe("getByRole('dialog', { name: 'New Contact' }).getByRole('button', { name: 'Save Record', exact: true })");
  });
});

const row = (element: string, name: string, role: string, expr: string): LocatorEntry => ({
  org: ORG,
  page: 'contact-new',
  element,
  persona: 'system-admin',
  scope: "getByRole('dialog', { name: 'New Contact' })",
  role,
  accessibleName: name,
  expression: expr,
  strategy: 'role',
  strategyRank: 1,
  lastVerifiedAt: '2026-11-26T05:08:29.372Z',
  verifiedBy: 'explorer',
  observationId: 'obs-1',
  status: 'ACTIVE',
  environment: 'LIVE',
});

describe('healFailure', () => {
  let root: string;
  let ledger: EvidenceLedger;
  const regFile = (): string => join(root, '.qa-memory', 'locators.db');

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'qa heal '));
    ledger = new EvidenceLedger(join(root, '.qa-memory', 'evidence.db'));
    const reg = new LocatorRegistry(regFile());
    reg.upsert([
      row('dialog:New Contact', 'New Contact', 'dialog', "getByRole('dialog', { name: 'New Contact' })"),
      row(
        'button:New Contact/Save',
        'Save',
        'button',
        "getByRole('dialog', { name: 'New Contact' }).getByRole('button', { name: 'Save', exact: true })",
      ),
      row(
        'button:New Contact/Cancel',
        'Cancel',
        'button',
        "getByRole('dialog', { name: 'New Contact' }).getByRole('button', { name: 'Cancel', exact: true })",
      ),
    ]);
    const cat = buildCatalog({
      entries: reg.list({ org: ORG }),
      org: ORG,
      orgAlias: 'qa-prod',
      environment: 'LIVE',
      persona: 'system-admin',
    });
    reg.close();
    await writePageObjects(root, cat, (abs, text) => {
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, text);
    });
    mkdirSync(join(root, 'tests', 'generated', 'SF-1'), { recursive: true });
    writeFileSync(join(root, 'tests', 'generated', 'SF-1', 'TC-SF-1-001-x.spec.ts'), SPEC);
    writeFileSync(
      join(root, 'tests', 'generated', 'SF-1', 'manifest.json'),
      JSON.stringify({
        storyKey: 'SF-1',
        org: 'qa-prod',
        environment: 'LIVE',
        artifacts: [
          {
            kind: 'spec',
            path: 'tests/generated/SF-1/TC-SF-1-001-x.spec.ts',
            hash: 'h',
            testCaseIds: ['TC-SF-1-001'],
            locatorsUsed: ['contact-new.saveButton', 'contact-new.root'],
            dependsOn: [{ component: 'Locator:contact-new/button:New Contact/Save', hash: 'old' }],
          },
        ],
      }),
    );
  });
  afterEach(() => {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  });

  const locatorInv = (): Investigation => ({
    failureId: 'F-1',
    caseId: 'TC-SF-1-001',
    specPath: 'tests/generated/SF-1/TC-SF-1-001-x.spec.ts',
    persona: 'system-admin',
    observations: [],
    hypotheses: [],
    verdict: 'SCRIPT_LOCATOR',
    confidence: 0.85,
    status: 'SUSPECTED',
    signals: [],
    evidenceIds: [],
    experiments: [
      {
        id: 'X',
        kind: 'aria-locate',
        action: 'observe',
        question: 'q',
        hypothesisIds: [],
        outcome: 'SUPPORTS',
        result: 'similar',
        data: {
          locator: "getByRole('dialog', { name: 'New Contact' }).getByRole('button', { name: 'Save' })",
          candidates: [{ role: 'button', name: 'Save Record', similarity: 0.5, line: 3 }],
        },
        evidenceIds: [],
        at: '2026-11-27T10:00:00.000Z',
      },
    ],
  });

  const deps = (over: Partial<HealDeps> = {}): HealDeps => ({
    root,
    runId: 'heal-1',
    environment: 'LIVE',
    autonomy: 'L2',
    policy: {
      healing: { maxAttemptsPerTest: 3, allowAssertionChanges: false },
      approvals: { L1: 'all', L2: ['behaviour-changing-locator-repairs'], L3: [] },
    },
    registryFile: regFile(),
    approvals: new ApprovalStore(join(root, '.qa-memory', 'approvals.jsonl')),
    ledger,
    orgIdForApprovals: ORG,
    rerun: () =>
      Promise.resolve({
        runId: 'heal-1-heal1',
        result: {
          testId: 't',
          state: 'PASS',
          evidenceIds: [],
          environment: 'LIVE',
          snapshotId: 's',
          runId: 'r',
          attachments: [],
        },
      }),
    say: () => undefined,
    ...over,
  });

  it('LIVE locator repair: registry + page object change, member name pinned, spec + assertions untouched, verified, revertible', async () => {
    const specBefore = readFileSync(join(root, 'tests', 'generated', 'SF-1', 'TC-SF-1-001-x.spec.ts'), 'utf8');
    const poFile = join(root, 'tests', 'pages', 'NewContactDialog.ts');
    const poBefore = readFileSync(poFile, 'utf8');
    const catBefore = readCatalog(root);
    const out = await healFailure(locatorInv(), deps());
    expect(out.final).toMatchObject({
      status: 'VERIFIED',
      assertionsUnchanged: true,
      behaviourChanging: false,
      kind: 'locator',
    });
    expect(out.final?.fingerprintBefore.sha256).toBe(out.final?.fingerprintAfter.sha256);
    const po = readFileSync(poFile, 'utf8');
    expect(po).toMatch(/name: ["']Save Record["']/);
    expect(po).toContain('saveButton'); // pinned member name — specs keep compiling
    expect(readFileSync(join(root, 'tests', 'generated', 'SF-1', 'TC-SF-1-001-x.spec.ts'), 'utf8')).toBe(specBefore);
    expect(catalogScopeCheck(catBefore!, readCatalog(root)!, 'contact-new.saveButton')).toEqual([]);
    const reg = new LocatorRegistry(regFile());
    expect(reg.get(ORG, 'contact-new', 'button:New Contact/Save', 'system-admin')).toMatchObject({
      verifiedBy: 'healer',
      memberName: 'saveButton',
    });
    reg.close();
    expect(readFileSync(join(root, 'tests', 'generated', 'SF-1', 'manifest.json'), 'utf8')).not.toContain('"old"');

    const rev = revertRepair(root, out.final!.id, {
      registryFile: regFile(),
      runId: 'heal-2',
      orgIdForApprovals: ORG,
      say: () => undefined,
    });
    expect(rev).toMatchObject({ status: 'REVERTED', revertOf: out.final!.id });
    expect(readFileSync(poFile, 'utf8')).toBe(poBefore);
    expect(readFileSync(join(root, 'tests', 'generated', 'SF-1', 'manifest.json'), 'utf8')).toContain('"old"');
    const reg2 = new LocatorRegistry(regFile());
    expect(reg2.get(ORG, 'contact-new', 'button:New Contact/Save', 'system-admin')?.accessibleName).toBe('Save');
    reg2.close();
  });

  it('FIXTURE repair is verified and then reverted automatically (never changes live page objects)', async () => {
    const poFile = join(root, 'tests', 'pages', 'NewContactDialog.ts');
    const poBefore = readFileSync(poFile, 'utf8');
    const out = await healFailure(locatorInv(), deps({ environment: 'FIXTURE' }));
    expect(out.repairs.map((r) => r.status)).toEqual(['VERIFIED', 'REVERTED']);
    expect(readFileSync(poFile, 'utf8')).toBe(poBefore);
  });

  it('a failed verification reverts; a dissimilar name waits for approval at L2', async () => {
    const poFile = join(root, 'tests', 'pages', 'NewContactDialog.ts');
    const poBefore = readFileSync(poFile, 'utf8');
    const failed = await healFailure(
      locatorInv(),
      deps({ rerun: () => Promise.resolve({ runId: 'x', result: undefined }) }),
    );
    expect(failed.final?.status).toBe('FAILED');
    expect(readFileSync(poFile, 'utf8')).toBe(poBefore);

    const inv = locatorInv();
    (inv.experiments[0]!.data['candidates'] as { name: string }[])[0]!.name = 'Submit';
    const proposed = await healFailure(inv, deps());
    expect(proposed.final).toMatchObject({ status: 'PROPOSED', behaviourChanging: true });
    expect(readFileSync(poFile, 'utf8')).toBe(poBefore);
    const approved = await healFailure(inv, deps({ approvedBy: 'Operator' }));
    expect(approved.final).toMatchObject({ status: 'VERIFIED' });
    expect(approved.final?.approvalId).toMatch(/^AP-/);
  });

  it('wait repair writes a per-case factor only; defects are never healed', async () => {
    const inv: Investigation = {
      ...locatorInv(),
      verdict: 'SCRIPT_TIMING',
      experiments: [
        { ...locatorInv().experiments[0]!, kind: 'rerun-extended-waits', result: 'with 3× waits: PASS', data: {} },
      ],
    };
    const out = await healFailure(inv, deps());
    expect(out.final).toMatchObject({ kind: 'wait', status: 'VERIFIED', assertionsUnchanged: true });
    expect(readWaitOverrides(root)['TC-SF-1-001']?.factor).toBe(3);
    revertRepair(root, out.final!.id, {
      registryFile: regFile(),
      runId: 'h',
      orgIdForApprovals: ORG,
      say: () => undefined,
    });
    expect(existsSync(join(root, 'tests', 'support', 'wait-overrides.json'))).toBe(false);

    const defect = await healFailure({ ...locatorInv(), verdict: 'PRODUCT_DEFECT' }, deps());
    expect(defect.refused).toMatch(/never healed/);
    expect(readRepairs(root).every((r) => r.assertionsUnchanged)).toBe(true);
  });
});
