import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ExecutionSummary } from '../core/schemas/execution.js';
import type { TestResult } from '../core/schemas/result.js';
import type { TestCase } from '../core/schemas/testCase.js';
import {
  acsFromRtm,
  releaseConfidence,
  renderCleanup,
  renderExecutionReport,
  updateHistory,
  writeExecutionReports,
  type ReportData,
} from './execution.js';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const row = (caseId: string, state: TestResult['state'], env: TestResult['environment'] = 'LIVE'): TestResult => ({
  testId: caseId,
  caseId,
  state,
  evidenceIds: [],
  environment: env,
  snapshotId: 's',
  runId: 'r',
  attachments: [],
  persona: 'system-admin',
  browser: 'chromium',
});
const tc = (id: string, riskIds: string[] = []): TestCase =>
  ({
    id,
    title: `title ${id}`,
    type: 'functional',
    priority: 'P1',
    persona: 'system-admin',
    riskIds,
  }) as unknown as TestCase;

function data(o: {
  env?: TestResult['environment'];
  results: TestResult[];
  acs?: { ref: string; caseIds: string[] }[];
}): ReportData {
  const root = mkdtempSync(join(tmpdir(), 'qa report '));
  roots.push(root);
  const env = o.env ?? 'LIVE';
  const summary: ExecutionSummary = {
    runId: 'run-r1',
    storyKey: 'SF-9',
    orgAlias: env === 'LIVE' ? 'qa-prod' : 'fixture',
    environment: env,
    browser: 'chromium',
    startedAt: '2026-11-26T10:00:00.000Z',
    finishedAt: '2026-11-26T10:05:00.000Z',
    gate: { EXECUTE: o.results.length },
    executed: { PASS: 0, FAIL: 0, BLOCKED: 0, SKIPPED: 0, UNCERTAIN: 0 },
    all: { PASS: 0, FAIL: 0, BLOCKED: 0, SKIPPED: 0, UNCERTAIN: 0 },
    flaky: 0,
    cleanup: 'CLEAN',
    exitCode: 0,
    status: 'COMPLETE',
  };
  return {
    root,
    runId: 'run-r1',
    runDir: join(root, 'runs', 'run-r1'),
    status: 'COMPLETE',
    summary,
    results: o.results,
    gate: o.results.map((r) => ({ caseId: r.caseId ?? '', decision: 'EXECUTE' as const, reason: 'APPROVED' })),
    reconcile: {
      runId: 'run-r1',
      orgId: '00D',
      subRuns: [
        {
          dir: join(root, 'runs', 'run-r1', 'data', 'aaaaaa'),
          tag: 'run-r1-aaaaaa',
          status: 'CLEAN',
          created: [
            {
              idempotencyKey: 'k',
              object: 'Account',
              recordId: '001dN00000AbCdEFGH',
              createdAt: 'x',
              order: 0,
              via: 'api',
            },
          ],
          remaining: [],
        },
      ],
      queries: ["SELECT Id FROM Account WHERE QA_Run_Id__c LIKE 'run-r1-%'"],
      remaining: [],
      untagged: [],
      status: 'CLEAN',
    },
    design: {
      runId: 'design-1',
      cases: o.results.map((r) => tc(r.caseId ?? '', ['RISK-01'])),
      rtm: [],
      acs: o.acs ?? [{ ref: 'AC1', caseIds: o.results.map((r) => r.caseId ?? '') }],
      risks: [{ id: 'RISK-01', impact: 'H' } as never],
      personas: [{ id: 'system-admin', available: true }],
    },
    clarifications: [],
    failedAttempts: [],
  };
}

describe('release confidence (reporting skill template)', () => {
  it('FIXTURE evidence is never a release verdict', () => {
    const rc = releaseConfidence(data({ env: 'FIXTURE', results: [row('TC-1', 'PASS', 'FIXTURE')] }));
    expect(rc.verdict).toBe('Not ready');
    expect(rc.why).toMatch(/Only FIXTURE evidence/);
  });
  it('LIVE: all pass + every AC passing → Ready; an AC without a passing test → Ready with risks; a FAIL → Not ready', () => {
    expect(releaseConfidence(data({ results: [row('TC-1', 'PASS')] })).verdict).toBe('Ready');
    const risky = releaseConfidence(
      data({
        results: [row('TC-1', 'PASS')],
        acs: [
          { ref: 'AC1', caseIds: ['TC-1'] },
          { ref: 'AC2', caseIds: ['TC-9'] },
        ],
      }),
    );
    expect(risky.verdict).toBe('Ready with risks');
    expect(risky.reasons.join(' ')).toMatch(/1 of 2 acceptance criteria have no passing executed test/);
    expect(releaseConfidence(data({ results: [row('TC-1', 'PASS'), row('TC-2', 'FAIL')] })).verdict).toBe('Not ready');
    expect(releaseConfidence(data({ results: [row('TC-1', 'UNCERTAIN')] })).verdict).toBe('Ready with risks');
  });
});

describe('AC coverage comes from the RTM (all cases), not the one-case design summary', () => {
  it('unions the cases of every requirement that cites the AC', () => {
    const row = (id: string, refs: string[], cases: string[]) =>
      ({ requirementId: id, refs, testCaseIds: cases }) as unknown as Parameters<typeof acsFromRtm>[0][number];
    const acs = acsFromRtm(
      [row('R1', ['AC5', 'BR-04'], ['TC-7', 'TC-8']), row('R2', ['AC5'], ['TC-9']), row('R3', ['AC10'], ['TC-1'])],
      [
        { ref: 'AC5', caseIds: ['TC-7'] },
        { ref: 'AC6', caseIds: ['TC-11'] },
      ],
    );
    expect(acs).toEqual([
      { ref: 'AC5', caseIds: ['TC-7', 'TC-8', 'TC-9'] },
      { ref: 'AC6', caseIds: ['TC-11'] },
      { ref: 'AC10', caseIds: ['TC-1'] },
    ]);
  });
});

describe('execution reports', () => {
  it('label every row with its environment, mask record ids, and write all files', async () => {
    const d = data({ env: 'FIXTURE', results: [row('TC-1', 'PASS', 'FIXTURE'), row('TC-2', 'FAIL', 'FIXTURE')] });
    const md = renderExecutionReport(d);
    expect(md).toMatch(/> \*\*FIXTURE — offline fixture, NOT a Salesforce result\*\*/);
    expect(md).toMatch(/\| TC-2 \| title TC-2 \| functional \| P1 \| system-admin \| \*\*FAIL\*\* \| FIXTURE \|/);
    const cleanup = renderCleanup(d);
    expect(cleanup).toContain('001…FGH');
    expect(cleanup).not.toContain('001dN00000AbCdEFGH');
    const files = await writeExecutionReports(d);
    for (const f of ['index.md', 'release-confidence.md', 'rtm-results.xlsx', 'history.md', 'model-attempts.json'])
      expect(files.some((x) => x.endsWith(f))).toBe(true);
    expect(readFileSync(join(d.runDir, 'report', 'index.md'), 'utf8')).toMatch(/Not produced in Phase 5/);
  });

  it('history keeps one entry per run id and shows the story trend', () => {
    const d = data({ results: [row('TC-1', 'PASS')] });
    updateHistory(d);
    const again = updateHistory({ ...d, results: [row('TC-1', 'FAIL')] });
    expect(again.entries.filter((e) => e.runId === 'run-r1')).toHaveLength(1);
    expect(again.markdown).toMatch(/\| TC-1 \| FAIL \|/);
    expect(existsSync(join(d.root, '.qa-memory', 'history.jsonl'))).toBe(true);
  });
});
