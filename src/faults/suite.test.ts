import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HealRepair, TestResult, Verdict } from '../core/schemas/index.js';
import { assertionChangesOf, loadFaultSuite, runFaultSuite } from './suite.js';

const repo = join(import.meta.dirname, '..', '..');
const fp = { sha256: 'a'.repeat(64), count: 1, items: ['x'] };

describe('fault suite', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qa faults '));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('the repo suite covers every failure class the PLAN names, on the fixture', () => {
    const s = loadFaultSuite(join(repo, 'examples', 'faults', 'fixture-suite.yaml'));
    expect(s.environment).toBe('FIXTURE');
    expect(new Set(s.faults.map((f) => f.expectedVerdict))).toEqual(
      new Set(['SCRIPT_LOCATOR', 'SCRIPT_TIMING', 'PRODUCT_DEFECT', 'TEST_DATA', 'ENVIRONMENT', 'PERMISSION_CONFIG']),
    );
  });

  it('scores verdicts, counts applied assertion changes only, writes the scorecard; fixture always stopped', async () => {
    const suite = loadFaultSuite(join(repo, 'examples', 'faults', 'fixture-suite.yaml'));
    let open = 0;
    const verdictFor: Record<string, Verdict> = {
      'flt-f1': 'SCRIPT_LOCATOR',
      'flt-f2': 'SCRIPT_TIMING',
      'flt-f3': 'PRODUCT_DEFECT',
      'flt-f4': 'TEST_DATA',
      'flt-f5': 'ENVIRONMENT',
      'flt-f6': 'UNKNOWN', // one miss
      'flt-f7': 'PRODUCT_DEFECT',
    };
    const fail = (runId: string): TestResult => ({
      testId: 't',
      caseId: 'c',
      state: 'FAIL',
      evidenceIds: [],
      environment: 'FIXTURE',
      snapshotId: 's',
      runId,
      attachments: [],
    });
    const repair = (status: HealRepair['status'], unchanged: boolean): HealRepair => ({
      id: 'HR',
      runId: 'h',
      caseId: 'c',
      specPath: 's',
      failureId: 'f',
      kind: 'locator',
      fingerprintBefore: fp,
      fingerprintAfter: fp,
      assertionsUnchanged: unchanged,
      behaviourChanging: false,
      reason: 'r',
      status,
      attempt: 1,
      environment: 'FIXTURE',
      createdAt: '2026-11-27T10:00:00.000Z',
    });
    const { scorecard, files } = await runFaultSuite(
      { root, suite, runId: 'flt' },
      {
        say: () => undefined,
        startFixture: () => {
          open++;
          return Promise.resolve({
            close: () => {
              open--;
              return Promise.resolve();
            },
          });
        },
        runCase: ({ runId }) => Promise.resolve(fail(runId)),
        investigate: ({ sourceRun }) =>
          Promise.resolve([
            {
              failureId: 'f',
              observations: [],
              hypotheses: [],
              verdict: verdictFor[sourceRun] ?? 'UNKNOWN',
              confidence: 0.8,
              status: 'SUSPECTED',
              signals: [],
              experiments: [],
              evidenceIds: [],
            },
          ]),
        heal: () => Promise.resolve([repair('VERIFIED', true), repair('REVERTED', true), repair('REFUSED', false)]),
      },
    );
    expect(open).toBe(0);
    expect(scorecard).toMatchObject({ total: 7, correct: 6, assertionChanges: 0, passed: true });
    expect(scorecard.outcomes.find((x) => x.faultId === 'F1-label-rename')).toMatchObject({ healed: true });
    expect(readFileSync(files[1]!, 'utf8')).toContain('6/7 classified correctly');
    expect(assertionChangesOf([repair('VERIFIED', false)])).toBe(1);
  });

  it('a passing test is a missed fault', async () => {
    const suite = loadFaultSuite(join(repo, 'examples', 'faults', 'fixture-suite.yaml'));
    const { scorecard } = await runFaultSuite(
      { root, suite, runId: 'flt', only: ['F1-label-rename'] },
      {
        say: () => undefined,
        startFixture: () => Promise.resolve({ close: () => Promise.resolve() }),
        runCase: ({ runId }) =>
          Promise.resolve({
            testId: 't',
            state: 'PASS',
            evidenceIds: [],
            environment: 'FIXTURE',
            snapshotId: 's',
            runId,
            attachments: [],
          }),
        investigate: () => Promise.resolve([]),
        heal: () => Promise.resolve([]),
      },
    );
    expect(scorecard).toMatchObject({ total: 1, correct: 0, passed: false });
  });
});
