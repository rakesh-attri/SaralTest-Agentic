import type { BaseMessage } from '@langchain/core/messages';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CASE, GOOD_IR, generationContext } from '../../tests/helpers/generationFixtures.js';
import { mockRouter } from '../../tests/helpers/mockRouter.js';
import { REPO_ROOT } from '../../tests/helpers/tempProject.js';
import type { ToolchainResult } from '../agents/test-generator/toolchain.js';
import { projectPaths, requireConfig } from '../config/loader.js';
import { nullLogger } from '../core/logger.js';
import type { DryRunReport } from '../core/schemas/generation.js';
import { initialRunState } from '../core/state.js';
import { messageText } from '../models/secretGuard.js';
import { SqliteCheckpointSaver } from './checkpointer.js';
import { buildMainGraph, type GraphDeps } from './mainGraph.js';
import type { QAGraphStateType } from './state.js';

const policy = await requireConfig('policy', projectPaths(REPO_ROOT));
const roots: string[] = [];
const savers: SqliteCheckpointSaver[] = [];
afterAll(() => {
  for (const s of savers) s.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const okToolchain = (files: string[]): Promise<ToolchainResult> =>
  Promise.resolve({
    typecheck: Object.fromEntries(files.map((f) => [f, []])),
    lint: Object.fromEntries(files.map((f) => [f, []])),
    listed: Object.fromEntries(files.map((f) => [f, [`${CASE.id} ${CASE.title}`]])),
    toolErrors: [],
  });
const okDryRun = (refs: string[]): Promise<DryRunReport> =>
  Promise.resolve({
    orgAlias: 'qa-prod',
    environment: 'LIVE',
    persona: 'system-admin',
    at: new Date().toISOString(),
    pageErrors: [],
    checks: refs.map((e) => ({
      element: e,
      page: e.split('.')[0] ?? '',
      persona: 'system-admin',
      expression: 'x',
      count: 1,
      visible: true,
      enabled: true,
      ok: true,
    })),
    ok: true,
  });

async function run(o: {
  router?: boolean;
  coder?: (m: BaseMessage[]) => string;
  dryRun?: boolean;
  toolchain?: (files: string[]) => Promise<ToolchainResult>;
}) {
  const root = mkdtempSync(join(tmpdir(), 'qa build graph '));
  roots.push(root);
  const checkpointer = new SqliteCheckpointSaver(join(root, '.qa-memory', 'checkpoints.db'));
  savers.push(checkpointer);
  const ctx = generationContext();
  const deps: GraphDeps = {
    root,
    policy,
    logger: nullLogger(),
    ...(o.router
      ? {
          router: await mockRouter({
            coder: { responder: o.coder ?? (() => JSON.stringify(GOOD_IR)) },
            judge: {
              responder: (m) =>
                m.map(messageText).join(' ').includes('earlier findings')
                  ? JSON.stringify({ verdicts: [] })
                  : JSON.stringify({ findings: [] }),
            },
          }),
        }
      : {}),
    adapter: { root, cwd: root, env: {} },
    memoryDir: join(root, '.qa-memory'),
    checkpointer,
    sleep: vi.fn(() => Promise.resolve()),
    build: {
      build: vi.fn(() => Promise.resolve({ ctx, notes: ['test build inputs'] })),
      toolchain: o.toolchain ?? okToolchain,
      ...(o.dryRun === false ? {} : { dryRun: okDryRun }),
    },
  };
  const runId = `run-build-${String(roots.length)}`;
  const state = {
    ...initialRunState({
      runId,
      org: 'qa-prod',
      autonomy: 'L2',
      source: { type: 'file', ref: 'run:design' },
      storyKey: 'SF-219',
      tokenLimit: 1_000_000,
      timeLimitMin: 30,
      inputs: [],
    }),
    testCases: [CASE, { ...CASE, id: 'TC-SF-219-050', reviewStatus: 'REVIEW_REQUIRED' as const }],
    designRunId: 'run-p3-test',
    interactive: false,
  };
  const graph = buildMainGraph(deps);
  const config = { configurable: { thread_id: runId } };
  await graph.invoke(state, config);
  const v = (await graph.getState(config)).values as QAGraphStateType;
  return { v, root, runId };
}

describe('main graph — build ⇄ review2 (Phase 4)', () => {
  it('a run seeded with reviewed cases enters at build, generates only APPROVED cases, reviews, settles, reports (MOCK)', async () => {
    const { v, root, runId } = await run({ router: true });
    expect(v.status).toBe('COMPLETE');
    expect(v.buildEnvironment).toBe('MOCK');
    const specs = v.generated.filter((g) => g.kind === 'spec');
    expect(specs.map((s) => s.testCaseIds[0])).toEqual([CASE.id]);
    expect(specs[0]?.reviewReasons, JSON.stringify(v.pass2Findings.map((f) => [f.rule, f.text]))).toEqual([]);
    expect(specs[0]?.reviewStatus).toBe('APPROVED');
    expect(v.pass2Findings.every((f) => f.status !== 'OPEN')).toBe(true);
    expect(v.generated.some((g) => g.kind === 'page-object' && g.path === 'tests/pages/NewContactDialog.ts')).toBe(
      true,
    );
    // Files: page objects + spec + manifest in the project; build outputs in the run folder.
    expect(existsSync(join(root, 'tests', 'pages', 'NewContactDialog.ts'))).toBe(true);
    expect(readFileSync(join(root, specs[0]!.path.split('/').join('/')), 'utf8')).toContain('Generated by sf-qa-agent');
    expect(existsSync(join(root, 'tests', 'generated', 'SF-219', 'manifest.json'))).toBe(true);
    const report = readFileSync(join(root, 'runs', runId, 'build', 'build-report.md'), 'utf8');
    expect(report).toContain('**MOCK**');
    expect(report).toContain('not executed');
    expect(existsSync(join(root, 'runs', runId, 'build', 'ir', `${CASE.id}.json`))).toBe(true);
    expect(existsSync(join(root, 'runs', runId, 'analysis'))).toBe(false); // build-only run: no empty analysis
  });

  it('a regenerable pass-2 finding loops back to the generator once; the recheck resolves it', async () => {
    let coderCalls = 0;
    let toolRuns = 0;
    const { v } = await run({
      router: true,
      coder: () => {
        coderCalls++;
        return JSON.stringify(GOOD_IR);
      },
      toolchain: (files) => {
        toolRuns++;
        return okToolchain(files).then((r) =>
          toolRuns === 1
            ? { ...r, lint: Object.fromEntries(files.map((f) => [f, ['3:1 sf-locators/no-fragile-locators: x']])) }
            : r,
        );
      },
    });
    expect(coderCalls).toBe(2); // generated, then regenerated with the lint finding as feedback
    expect(v.pass2Round).toBe(2);
    const lint = v.pass2Findings.find((f) => f.rule === 'lint');
    expect(lint).toMatchObject({ status: 'RESOLVED', resolvedBy: 'recheck' });
    expect(v.generated.find((g) => g.kind === 'spec')?.reviewStatus).toBe('APPROVED');
  });

  it('offline (no router, no dry-run): mechanical skeletons, REVIEW_REQUIRED, labelled MECHANICAL', async () => {
    const { v, root, runId } = await run({ dryRun: false });
    const spec = v.generated.find((g) => g.kind === 'spec');
    expect(spec).toMatchObject({ origin: 'mechanical', reviewStatus: 'REVIEW_REQUIRED' });
    expect(readFileSync(join(root, 'runs', runId, 'build', 'build-report.md'), 'utf8')).toContain('**MECHANICAL**');
  });
});
