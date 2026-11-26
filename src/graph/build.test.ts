import type { BaseMessage } from '@langchain/core/messages';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CASE, ENTRIES, GOOD_IR, generationContext, SNAPSHOT } from '../../tests/helpers/generationFixtures.js';
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
import { isGeneratedSpec } from './buildNodes.js';
import { refreshStaleMarks, registryLookup } from '../agents/test-generator/staleness.js';
import type { GeneratedArtifact } from '../core/schemas/generation.js';
import { executionPlan } from '../runner/gate.js';
import { SnapshotFacts } from '../sf/data/plan.js';

const policy = await requireConfig('policy', projectPaths(REPO_ROOT));
const roots: string[] = [];
let runs = 0;
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
  judge?: (m: BaseMessage[]) => string;
  cases?: (typeof CASE)[];
  root?: string;
  ctx?: ReturnType<typeof generationContext>;
  merge?: boolean;
}) {
  const root = o.root ?? mkdtempSync(join(tmpdir(), 'qa build graph '));
  if (!o.root) roots.push(root);
  const checkpointer = new SqliteCheckpointSaver(join(root, '.qa-memory', 'checkpoints.db'));
  savers.push(checkpointer);
  const ctx = o.ctx ?? generationContext();
  const deps: GraphDeps = {
    root,
    policy,
    logger: nullLogger(),
    ...(o.router
      ? {
          router: await mockRouter({
            coder: { responder: o.coder ?? (() => JSON.stringify(GOOD_IR)) },
            judge: {
              responder:
                o.judge ??
                ((m) =>
                  m.map(messageText).join(' ').includes('earlier findings')
                    ? JSON.stringify({ verdicts: [] })
                    : JSON.stringify({ findings: [] })),
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
      judgeBackoffMs: [0, 0],
      ...(o.merge ? { merge: true } : {}),
    },
  };
  const runId = `run-build-${String(roots.length)}-${String(++runs)}`;
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
    testCases: o.cases ?? [CASE, { ...CASE, id: 'TC-SF-219-050', reviewStatus: 'REVIEW_REQUIRED' as const }],
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

describe('stale spec cleanup (run-p4-build-decided-1: old skeletons TC-002/003 survived a design change)', () => {
  it('treats generated specs and mechanical skeletons as generated files, never hand-written ones', () => {
    expect(isGeneratedSpec('// Generated by sf-qa-agent from TC-1\nimport …')).toBe(true);
    expect(isGeneratedSpec('// MECHANICAL skeleton for TC-SF-219-002 — …')).toBe(true);
    expect(isGeneratedSpec("import { test } from '@playwright/test';")).toBe(false);
  });
});

describe('judge outage inside qa build (2026-11-25: NIM + Gemini 503)', () => {
  it('retries with backoff, then reviews deterministic-only: nothing APPROVED, manifest written, issue recorded', async () => {
    let calls = 0;
    const { v, root } = await run({
      router: true,
      judge: () => {
        calls++;
        throw Object.assign(new Error('503 This model is currently experiencing high demand'), { status: 503 });
      },
    });
    expect(v.status).not.toBe('FAILED');
    expect(calls).toBeGreaterThanOrEqual(3); // first try + 2 retries (the mock chain has no other provider)
    const spec = v.generated.find((g) => g.kind === 'spec');
    expect(spec?.reviewStatus).toBe('REVIEW_REQUIRED');
    expect(spec?.reviewReasons.join(' ')).toMatch(/judge unavailable/);
    const manifest = JSON.parse(readFileSync(join(root, 'tests', 'generated', 'SF-219', 'manifest.json'), 'utf8')) as {
      artifacts: { reviewStatus?: string }[];
    };
    expect(manifest.artifacts.some((a) => a.reviewStatus === 'REVIEW_REQUIRED')).toBe(true);
    expect(v.issues.some((i) => i.node === 'review2' && i.resolution === 'DEGRADED')).toBe(true);
  });
});

describe('manual-only cases (operator 2026-11-26: TC-051/052 are not automatable)', () => {
  it('get no spec, are listed in the manifest as manual, and pass 2 does not ask for a spec', async () => {
    const manual = { ...CASE, id: 'TC-SF-219-051', execution: 'manual' as const, executionReason: 'human check' };
    const { v, root } = await run({ router: true, cases: [CASE, manual] });
    expect(v.status).toBe('COMPLETE');
    const specs = v.generated.filter((g) => g.kind === 'spec');
    expect(specs.map((s) => s.testCaseIds[0])).toEqual([CASE.id]);
    expect(v.pass2Findings.some((f) => f.rule === 'spec-missing')).toBe(false);
    const manifest = JSON.parse(readFileSync(join(root, 'tests', 'generated', 'SF-219', 'manifest.json'), 'utf8')) as {
      manualOnly: { caseId: string; reason: string }[];
    };
    expect(manifest.manualOnly).toEqual([{ caseId: 'TC-SF-219-051', reason: 'human check' }]);
    // A partial rebuild of another case (qa build --stale / --cases) keeps the ruling.
    await run({ router: true, cases: [CASE], root, merge: true });
    const after = JSON.parse(readFileSync(join(root, 'tests', 'generated', 'SF-219', 'manifest.json'), 'utf8')) as {
      manualOnly: { caseId: string }[];
    };
    expect(after.manualOnly.map((m) => m.caseId)).toEqual(['TC-SF-219-051']);
  });
});

describe('stale specs (operator 2026-11-26: a changed Phone rule message went unnoticed)', () => {
  it('a changed rule makes the dependent spec STALE, the run gate blocks it, and a rebuild clears it', async () => {
    // A spec that types a Phone: it depends on Contact.Phone and on the rules reading Phone.
    const phoneIr = structuredClone(GOOD_IR);
    phoneIr.steps[0]!.actions.splice(1, 0, {
      do: 'fill',
      element: 'contact-new.phone',
      value: { kind: 'unique', label: 'bad-phone', format: 'phone' },
    });
    const coder = (): string => JSON.stringify(phoneIr);
    const first = await run({ router: true, coder });
    const manifestOf = (): { artifacts: GeneratedArtifact[]; manualOnly?: { caseId: string; reason: string }[] } =>
      JSON.parse(readFileSync(join(first.root, 'tests', 'generated', 'SF-219', 'manifest.json'), 'utf8')) as {
        artifacts: GeneratedArtifact[];
      };
    const built = manifestOf().artifacts.find((a) => a.kind === 'spec');
    expect(built?.snapshotId).toBe(SNAPSHOT.info.id);
    expect(built?.dependsOn?.map((d) => d.component)).toEqual(
      expect.arrayContaining([
        'Field:Contact.Phone',
        'ValidationRule:Contact.Phone_Must_Be_10_Digits',
        'Locator:contact-new/textbox:Phone',
      ]),
    );

    // The org changes the rule's message: a new snapshot with a new content hash for that rule.
    const changed = structuredClone(SNAPSHOT);
    changed.info.id = 'snap-test-2';
    const vr = changed.components.find((c) => c.apiName === 'Contact.Phone_Must_Be_10_Digits')!;
    vr.body = { ...vr.body, errorMessage: 'Phone must be exactly 10 digits.' };
    vr.hash = 'ValidationRule:Contact.Phone_Must_Be_10_Digits#2';
    const facts = new SnapshotFacts(changed);
    const r = refreshStaleMarks({ root: first.root, facts, locator: registryLookup(ENTRIES) });
    expect(r.stale.map((x) => x.caseId)).toEqual([CASE.id]);
    const stale = manifestOf().artifacts.find((a) => a.kind === 'spec');
    expect(stale?.stale?.components).toEqual(['ValidationRule:Contact.Phone_Must_Be_10_Digits changed']);
    expect(executionPlan(manifestOf()).find((i) => i.caseId === CASE.id)).toMatchObject({
      decision: 'BLOCKED',
      reason: 'stale: ValidationRule:Contact.Phone_Must_Be_10_Digits changed in snap-test-2',
    });

    // Rebuild from the new snapshot: fresh dependencies, no mark, nothing stale any more.
    await run({
      router: true,
      coder,
      root: first.root,
      ctx: { ...generationContext(), facts, snapshotId: 'snap-test-2' },
    });
    const rebuilt = manifestOf().artifacts.find((a) => a.kind === 'spec');
    expect(rebuilt?.stale).toBeUndefined();
    expect(rebuilt?.snapshotId).toBe('snap-test-2');
    expect(refreshStaleMarks({ root: first.root, facts, locator: registryLookup(ENTRIES) }).stale).toEqual([]);
    expect(executionPlan(manifestOf()).find((i) => i.caseId === CASE.id)?.decision).not.toBe('BLOCKED');
  });
});
