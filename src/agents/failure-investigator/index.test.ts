import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestResult } from '../../core/schemas/index.js';
import { EvidenceLedger } from '../../knowledge/evidenceLedger.js';
import {
  ariaLocateIn,
  locatorTarget,
  nameSimilarity,
  parseAriaSnapshot,
  type InvestigationProviders,
  type RerunOutcome,
} from './experiments.js';
import { investigateFailure } from './index.js';
import { decide, hypothesesFor } from './rules.js';
import { failuresOf, renderInvestigationReport } from './run.js';

const policy = { investigation: { reproductions: 2, flakyReruns: 3, minConfidence: 0.6, extendedWaitFactor: 3 } };
const at = new Date('2026-11-27T10:00:00.000Z');

const ARIA = `# Error details

\`\`\`yaml
- dialog "New Contact":
  - textbox "Last Name"
  - button "Cancel"
  - button "Save Record"
\`\`\`
`;

function fail(caseId: string, message: string, extra: Partial<TestResult> = {}): TestResult {
  return {
    testId: `t-${caseId}`,
    caseId,
    state: 'FAIL',
    evidenceIds: [],
    environment: 'FIXTURE',
    snapshotId: 's',
    runId: 'run-src',
    attempts: 1,
    attachments: [],
    failure: {
      attempts: [{ attempt: 0, status: 'failed', message, failedStep: '2. Save' }],
      steps: [
        { title: '1. Open', ok: true },
        { title: '2. Save', ok: false },
      ],
    },
    ...extra,
  };
}

const CLICK = `Error: locator.click: Timeout 20000ms exceeded.
Call log:
  - waiting for getByRole('dialog', { name: 'New Contact' }).getByRole('button', { name: 'Save' })`;
const SOQL_MISMATCH = `Error: expect(received).toBe(expected) // Object.is equality

Expected: 1
Received: 0`;

describe('ARIA helpers', () => {
  it('parses Playwright ARIA snapshots and finds a renamed element', () => {
    const nodes = parseAriaSnapshot(ARIA);
    expect(nodes.map((n) => `${n.role}:${n.name}`)).toEqual([
      'dialog:New Contact',
      'textbox:Last Name',
      'button:Cancel',
      'button:Save Record',
    ]);
    expect(locatorTarget("getByRole('dialog', { name: 'New Contact' }).getByRole('button', { name: 'Save' })")).toEqual(
      { role: 'button', name: 'Save' },
    );
    expect(locatorTarget("getByLabel('Phone')")).toEqual({ label: 'Phone' });
    const r = ariaLocateIn(nodes, "getByRole('button', { name: 'Save' })");
    expect(r?.originalPresent).toBe(false);
    expect(r?.candidates[0]).toMatchObject({ role: 'button', name: 'Save Record' });
    expect(ariaLocateIn(nodes, "getByRole('button', { name: 'Cancel' })")?.originalPresent).toBe(true);
    expect(nameSimilarity('Save', 'Save Record')).toBe(0.5);
  });
});

describe('rules', () => {
  it('always keeps 3–5 competing hypotheses', () => {
    for (const k of ['LOCATOR_NOT_FOUND', 'ASSERTION_MISMATCH', 'HTTP_5XX'] as const) {
      const hs = hypothesesFor([{ kind: k, detail: 'x', source: 't' }]);
      expect(hs.length).toBeGreaterThanOrEqual(3);
      expect(hs.length).toBeLessThanOrEqual(5);
    }
  });

  it('never decides PRODUCT_DEFECT from a single UI failure', () => {
    const s = [{ kind: 'ASSERTION_MISMATCH' as const, detail: 'x', source: 't' }];
    const trace = {
      id: 'X',
      kind: 'requirement-trace' as const,
      action: 'observe' as const,
      question: 'q',
      hypothesisIds: [],
      outcome: 'REFUTES' as const,
      result: 'stated',
      data: { evidenceLevel: 'APPROVED_REQUIREMENT' },
      evidenceIds: ['E1'],
      at: at.toISOString(),
    };
    expect(decide(s, [trace])).toBeUndefined();
    const rerun = {
      ...trace,
      id: 'Y',
      kind: 'rerun-fresh-data' as const,
      outcome: 'SUPPORTS' as const,
      data: {},
      evidenceIds: ['E2'],
    };
    expect(decide(s, [trace, rerun])).toMatchObject({ verdict: 'PRODUCT_DEFECT', confidence: 0.75 });
  });
});

describe('investigateFailure', () => {
  let root: string;
  let ledger: EvidenceLedger;
  const srcDir = (): string => join(root, 'runs', 'run-src');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qa inv '));
    ledger = new EvidenceLedger(join(root, '.qa-memory', 'evidence.db'));
    mkdirSync(join(srcDir(), 'test-results', 'x'), { recursive: true });
    writeFileSync(join(srcDir(), 'test-results', 'x', 'error-context.md'), ARIA);
    writeFileSync(join(srcDir(), 'results.json'), '[]');
    // A minimal built story: manifest → IR → test case → cited source text.
    mkdirSync(join(root, 'tests', 'generated', 'SF-1'), { recursive: true });
    writeFileSync(
      join(root, 'tests', 'generated', 'SF-1', 'manifest.json'),
      JSON.stringify({
        storyKey: 'SF-1',
        designRun: 'run-design',
        buildRun: 'run-build',
        org: 'fixture',
        environment: 'FIXTURE',
        artifacts: [
          { kind: 'spec', path: 'tests/generated/SF-1/TC-SF-1-001-x.spec.ts', hash: 'h', testCaseIds: ['TC-SF-1-001'] },
        ],
      }),
    );
    mkdirSync(join(root, 'runs', 'run-build', 'build', 'ir'), { recursive: true });
    writeFileSync(
      join(root, 'runs', 'run-build', 'build', 'ir', 'TC-SF-1-001.json'),
      JSON.stringify({
        caseId: 'TC-SF-1-001',
        steps: [
          { caseStep: 0, title: 'Open', assertions: [] },
          {
            caseStep: 1,
            title: 'Save',
            assertions: [
              {
                check: 'soqlField',
                ref: 'c',
                object: 'Contact',
                field: 'Count',
                equals: { kind: 'literal', value: '1' },
                expect: { caseStep: 1, evidenceIds: ['DOC#BR-08'] },
              },
            ],
          },
        ],
      }),
    );
    mkdirSync(join(root, 'runs', 'run-design', 'analysis', 'sources'), { recursive: true });
    writeFileSync(
      join(root, 'runs', 'run-design', 'analysis', 'sources', 'DOC.json'),
      JSON.stringify({
        docId: 'DOC',
        sections: [{ ref: 'BR-08', text: 'BR-08 A Contact that has open Cases cannot be deleted; 1 record remains.' }],
      }),
    );
    mkdirSync(join(root, 'runs', 'run-design', 'design'), { recursive: true });
    writeFileSync(
      join(root, 'runs', 'run-design', 'design', 'test-cases.json'),
      JSON.stringify([]), // the IR alone carries the evidence ids; the level falls back to UNKNOWN without a case
    );
  });
  afterEach(() => {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  });

  const run = (r: TestResult, providers: InvestigationProviders) =>
    investigateFailure(
      r,
      { root, runId: 'inv-1', sourceRunDir: srcDir(), environment: 'FIXTURE', policy, now: () => at },
      { ledger, providers },
    );

  const healthy = { probe: () => Promise.resolve({ identityOk: true, healthy: true, detail: 'ok' }) };

  it('renamed button → SCRIPT_LOCATOR from the ARIA snapshot, no rerun needed; evidence is ledgered', async () => {
    let reruns = 0;
    const r = fail('TC-SF-1-001', CLICK, {
      failure: {
        attempts: [{ attempt: 0, status: 'failed', message: CLICK }],
        steps: [],
        errorContext: 'test-results/x/error-context.md',
      },
    });
    const { investigation: i } = await run(r, {
      ...healthy,
      rerun: () => {
        reruns++;
        return Promise.resolve({ runId: 'x', result: undefined });
      },
    });
    expect(i).toMatchObject({ verdict: 'SCRIPT_LOCATOR', rule: 'R-LOC-1', route: 'self-healer', status: 'SUSPECTED' });
    expect(reruns).toBe(0);
    expect(ledger.missing(i.evidenceIds)).toEqual([]);
    expect(i.hypotheses.find((h) => h.verdict === 'SCRIPT_LOCATOR')?.status).toBe('SUPPORTED');
  });

  it('element present but late → extended-wait rerun passes → SCRIPT_TIMING', async () => {
    const msg = CLICK.replace(/'Save'/g, "'Cancel'");
    const r = fail('TC-SF-1-001', msg, {
      failure: {
        attempts: [{ attempt: 0, status: 'failed', message: msg }],
        steps: [],
        errorContext: 'test-results/x/error-context.md',
      },
    });
    const rerun = (o: { waitFactor?: number }): Promise<RerunOutcome> =>
      Promise.resolve({ runId: 'r', result: { ...r, state: o.waitFactor ? 'PASS' : 'FAIL' } });
    const { investigation: i } = await run(r, { ...healthy, rerun });
    expect(i).toMatchObject({ verdict: 'SCRIPT_TIMING', rule: 'R-TIME-1' });
  });

  it('503 and an unhealthy org → ENVIRONMENT', async () => {
    const r = fail('TC-SF-1-001', 'Error: page.goto: 503 Service Unavailable');
    const { investigation: i } = await run(r, {
      probe: () => Promise.resolve({ identityOk: true, healthy: false, status: 503, detail: '503' }),
    });
    expect(i).toMatchObject({ verdict: 'ENVIRONMENT', rule: 'R-ENV-2', route: 'qa-lead' });
  });

  it('data setup failed → TEST_DATA', async () => {
    const r = fail('TC-SF-1-001', 'QAError: create Account (Account) failed: FIELD_CUSTOM_VALIDATION_EXCEPTION');
    const { investigation: i } = await run(r, { ...healthy, validationRules: () => [{ name: 'Industry_Required' }] });
    expect(i.verdict).toBe('TEST_DATA');
    expect(i.experiments.find((e) => e.kind === 'validation-rule-check')?.result).toContain('Industry_Required');
  });

  it('stated expectation fails on fresh-data reruns and via API → PRODUCT_DEFECT (SUSPECTED, judge next)', async () => {
    writeFileSync(
      join(root, 'runs', 'run-design', 'design', 'test-cases.json'),
      JSON.stringify([
        {
          id: 'TC-SF-1-001',
          title: 't',
          requirementIds: ['R1'],
          riskIds: [],
          technique: 'negative',
          persona: 'system-admin',
          type: 'negative',
          priority: 'P1',
          severity: 'MAJOR',
          preconditions: [],
          tags: [],
          reviewStatus: 'APPROVED',
          snapshotId: 's',
          steps: [
            {
              action: 'open',
              expected: { text: 'opens', evidenceLevel: 'APPROVED_REQUIREMENT', evidenceIds: ['DOC#BR-08'] },
            },
            {
              action: 'delete',
              expected: { text: '1 record remains', evidenceLevel: 'APPROVED_REQUIREMENT', evidenceIds: ['DOC#BR-08'] },
            },
          ],
        },
      ]),
    );
    const r = fail('TC-SF-1-001', SOQL_MISMATCH);
    let api = 0;
    const { investigation: i, reruns } = await run(r, {
      ...healthy,
      rerun: () => Promise.resolve({ runId: 'rr', result: { ...r } }),
      apiReproduce: () => {
        api++;
        return Promise.resolve({ reproduced: true, detail: 'DELETE /sobjects/Contact succeeded with an open Case' });
      },
    });
    expect(i).toMatchObject({
      verdict: 'PRODUCT_DEFECT',
      rule: 'R-DEF-1',
      confidence: 0.9,
      route: 'defect-judge',
      status: 'SUSPECTED',
    });
    expect(reruns).toHaveLength(2);
    expect(api).toBe(1);
  });

  it('no rule and no model → UNKNOWN for a human', async () => {
    const r = fail('TC-SF-1-001', 'Error: something odd happened');
    const { investigation: i } = await run(r, healthy);
    expect(i.verdict).toBe('UNKNOWN');
    expect(i.model).toBe('none');
  });

  it('report and selection', () => {
    const r = fail('TC-SF-1-001', CLICK);
    expect(
      failuresOf([
        r,
        { ...r, caseId: 'TC-2', state: 'PASS' },
        { ...r, caseId: 'TC-3', state: 'UNCERTAIN', flaky: true },
      ]).map((x) => x.caseId),
    ).toEqual(['TC-SF-1-001', 'TC-3']);
    expect(renderInvestigationReport('run-src', 'inv-1', 'FIXTURE', [])).toContain('FIXTURE');
  });
});
