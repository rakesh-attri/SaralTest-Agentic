// Main graph, Phase 5: a run seeded for execution (`qa run`) enters at execute and always ends at report.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../tests/helpers/tempProject.js';
import { projectPaths, requireConfig } from '../config/loader.js';
import { nullLogger } from '../core/logger.js';
import type { TestResult } from '../core/schemas/index.js';
import { initialRunState } from '../core/state.js';
import type { ExecutionOutcome } from '../runner/execute.js';
import { SqliteCheckpointSaver } from './checkpointer.js';
import { buildMainGraph, type ExecuteHook } from './mainGraph.js';
import type { QAGraphStateType } from './state.js';

const policy = await requireConfig('policy', projectPaths(REPO_ROOT));
const roots: string[] = [];
const savers: SqliteCheckpointSaver[] = [];
afterAll(() => {
  for (const s of savers) s.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const row = (caseId: string, state: TestResult['state']): TestResult => ({
  testId: caseId,
  caseId,
  state,
  evidenceIds: [],
  environment: 'FIXTURE',
  snapshotId: 's',
  runId: 'r',
  attachments: [],
});

const outcome = (
  status: ExecutionOutcome['status'],
  results: TestResult[],
  blockedReason?: string,
): ExecutionOutcome => ({
  status,
  ...(blockedReason ? { blockedReason } : {}),
  gate: [],
  results,
  summary: {
    runId: 'r',
    storyKey: 'SF-9',
    orgAlias: 'fixture',
    environment: 'FIXTURE',
    browser: 'chromium',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    gate: { EXECUTE: results.length },
    executed: { PASS: 1, FAIL: 0, BLOCKED: 0, SKIPPED: 0, UNCERTAIN: 0 },
    all: { PASS: 1, FAIL: 0, BLOCKED: 0, SKIPPED: 0, UNCERTAIN: 0 },
    flaky: 0,
    cleanup: 'CLEAN',
    exitCode: 0,
  },
  dataLedger: [],
  environment: 'FIXTURE',
  snapshotId: 's',
  files: [],
});

async function runGraph(hook: ExecuteHook): Promise<QAGraphStateType> {
  const root = mkdtempSync(join(tmpdir(), 'qa exec graph '));
  roots.push(root);
  const checkpointer = new SqliteCheckpointSaver(join(root, '.qa-memory', 'checkpoints.db'));
  savers.push(checkpointer);
  const graph = buildMainGraph({
    root,
    policy,
    logger: nullLogger(),
    adapter: { root, cwd: root, env: {} },
    memoryDir: join(root, '.qa-memory'),
    checkpointer,
    execute: hook,
  });
  const state = {
    ...initialRunState({
      runId: 'run-exec-g',
      org: 'fixture',
      autonomy: 'L2',
      source: { type: 'file' as const, ref: 'manifest' },
      storyKey: 'SF-9',
      tokenLimit: 1,
      timeLimitMin: 10,
      inputs: [],
    }),
    executeSeed: true,
    interactive: false,
  };
  const config = { configurable: { thread_id: 'run-exec-g' } };
  await graph.invoke(state, config);
  return (await graph.getState(config)).values as QAGraphStateType;
}

describe('main graph: execute node (Phase 5)', () => {
  it('a seeded run enters at execute, keeps results + evidence and ends at report COMPLETE', async () => {
    const v = await runGraph(() => Promise.resolve(outcome('COMPLETE', [row('TC-1', 'PASS'), row('TC-2', 'SKIPPED')])));
    expect(v.status).toBe('COMPLETE');
    expect(v.results.map((r) => r.state)).toEqual(['PASS', 'SKIPPED']);
    expect(v.execution?.environment).toBe('FIXTURE');
    expect(v.evidence.map((e) => e.id)).toContain('EV-RUN-TC-1');
    expect(v.evidence.find((e) => e.id === 'EV-RUN-TC-1')?.environment).toBe('FIXTURE');
    expect(v.lastNode).toBe('report');
  });

  it('a preflight block (missing data approval) ends the run BLOCKED with an escalated DATA issue', async () => {
    const v = await runGraph(() =>
      Promise.resolve(outcome('BLOCKED', [row('TC-1', 'BLOCKED')], 'data approval needed before execution: x')),
    );
    expect(v.status).toBe('BLOCKED');
    expect(v.issues).toEqual([expect.objectContaining({ kind: 'DATA', node: 'execute', resolution: 'ESCALATED' })]);
  });

  it('a runner crash becomes an issue and the run still ends at report (PARTIAL), never a throw', async () => {
    const v = await runGraph(() => Promise.reject(new Error('spawn npx ENOENT')));
    expect(v.status).toBe('PARTIAL');
    expect(v.issues.some((i) => i.node === 'execute' && /ENOENT/.test(i.message))).toBe(true);
    expect(v.lastNode).toBe('report');
  });
});
