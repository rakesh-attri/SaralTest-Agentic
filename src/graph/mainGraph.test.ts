import type { BaseMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mockRouter, TEST_SECRET } from '../../tests/helpers/mockRouter.js';
import { REPO_ROOT } from '../../tests/helpers/tempProject.js';
import { projectPaths, requireConfig } from '../config/loader.js';
import { nullLogger } from '../core/logger.js';
import { Requirement, Clarification } from '../core/schemas/index.js';
import { initialRunState, type InputRequest } from '../core/state.js';
import type { MockOptions } from '../models/mock.js';
import { messageText } from '../models/secretGuard.js';
import { Redactor } from '../security/redact.js';
import { SqliteCheckpointSaver } from './checkpointer.js';
import { buildMainGraph, type ClarifyRequest, type GraphDeps } from './mainGraph.js';
import type { QAGraphStateType } from './state.js';

const policy = await requireConfig('policy', projectPaths(REPO_ROOT));
const roots: string[] = [];
const savers: SqliteCheckpointSaver[] = [];
const saver = (file: string): SqliteCheckpointSaver => {
  const sv = new SqliteCheckpointSaver(file);
  savers.push(sv);
  return sv;
};
afterAll(() => {
  for (const sv of savers) {
    try {
      sv.close();
    } catch {
      // already closed
    }
  }
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const STORY = [
  '**Summary:** Clerks create Orders',
  '',
  'AC1 – Create',
  'Given I am a Clerk',
  'When I save an Order',
  'Then the Order is saved',
  '',
  'AC2 – Region',
  'Then the Region must be one of the approved regions',
].join('\n');

const extractJson = JSON.stringify({
  requirements: [
    {
      key: 'a',
      title: 'Create order',
      businessObjective: 'Clerk saves an Order',
      type: 'functional',
      personas: ['Clerk'],
      expectedOutcomes: ['the Order is saved'],
      expectedOutcomeClear: true,
      risk: 'HIGH',
      sources: ['AC1'],
    },
    {
      key: 'b',
      title: 'Region list',
      businessObjective: 'Region from approved list',
      type: 'validation',
      expectedOutcomes: ['approved regions accepted'],
      expectedOutcomeClear: true,
      risk: 'MEDIUM',
      sources: ['AC2'],
    },
  ],
});
const analyzeJson = (withQuestion: boolean): string =>
  JSON.stringify({
    findings: [],
    questions: withQuestion
      ? [
          {
            question: 'Which regions are on the approved list?',
            refs: ['AC2'],
            requirementIds: [],
            testImpact: 'valid/invalid region cases',
            proposedAssumption: 'do not assert region values',
            priority: 1,
          },
        ]
      : [],
  });

/** Mock Spec Analyst: questions only in round 1; records the prompts it saw. */
function analyst(prompts: string[] = []): MockOptions {
  let analyzeCalls = 0;
  return {
    responder: (msgs: BaseMessage[]) => {
      const all = msgs.map(messageText).join('\n');
      prompts.push(all);
      if (all.includes('Turn the source documents into canonical')) return extractJson;
      return analyzeJson(analyzeCalls++ === 0);
    },
  };
}

async function setup(
  opts: {
    inputs?: InputRequest[];
    mock?: Parameters<typeof mockRouter>[0];
    deps?: Partial<GraphDeps>;
    interactive?: boolean;
    autonomy?: 'L1' | 'L2' | 'L3';
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'qa graph with spaces '));
  roots.push(root);
  const router = await mockRouter(opts.mock ?? { reasoning: analyst() });
  const checkpointer = saver(join(root, '.qa-memory', 'checkpoints.db'));
  const deps: GraphDeps = {
    root,
    policy,
    logger: nullLogger(),
    router,
    redactor: new Redactor({ secrets: [TEST_SECRET] }),
    adapter: { root, cwd: root, env: {} },
    memoryDir: join(root, '.qa-memory'),
    checkpointer,
    sleep: vi.fn(() => Promise.resolve()),
    ...opts.deps,
  };
  const graph = buildMainGraph(deps);
  const runId = `run-test-${roots.length}`;
  const state = {
    ...initialRunState({
      runId,
      org: 'none',
      autonomy: opts.autonomy ?? 'L2',
      source: { type: 'chat', ref: 'test' },
      tokenLimit: 1_000_000,
      timeLimitMin: 30,
      inputs: opts.inputs ?? [{ kind: 'chat', value: STORY }],
    }),
    interactive: opts.interactive ?? false,
  };
  const config = { configurable: { thread_id: runId } };
  return { root, deps, graph, state, config, checkpointer, runId };
}

const run = async (s: Awaited<ReturnType<typeof setup>>): Promise<QAGraphStateType> => {
  await s.graph.invoke(s.state, s.config);
  return (await s.graph.getState(s.config)).values as QAGraphStateType;
};

describe('main graph (intake → understand ⇄ clarify → report, triage after every node)', () => {
  it('non-interactive: questions are assumed (flagged), report written, status COMPLETE', async () => {
    const s = await setup();
    const v = await run(s);
    expect(v.status).toBe('COMPLETE');
    expect(v.requirements.map((r) => Requirement.parse(r).id)).toEqual(['CHAT-R01', 'CHAT-R02']);
    const q = Clarification.parse(v.clarifications[0]);
    expect(q).toMatchObject({ id: 'Q1', status: 'ASSUMED', assumption: 'do not assert region values' });
    const r2 = v.requirements[1];
    expect(r2?.status).toBe('REVIEW_REQUIRED');
    expect(r2?.reviewReasons).toContain('relies on unconfirmed assumption Q1');
    expect(r2?.assumptions.known.join(' ')).toContain('ASSUMPTION (unconfirmed, Q1)');
    expect(v.triageLog.map((d) => `${d.node}:${d.kind}→${d.response}`)).toEqual(['understand:AMBIGUOUS_SPEC→ask']);
    const report = join(s.root, 'runs', s.runId, 'analysis', 'analysis-report.md');
    expect(readFileSync(report, 'utf8')).toMatch(/\*\*MOCK\*\*/);
    expect(existsSync(join(s.root, 'runs', s.runId, 'analysis', 'requirements.json'))).toBe(true);
  });

  it('interactive: interrupt → resume in a NEW graph instance with answers → re-analysis with answers as a source', async () => {
    const prompts: string[] = [];
    const s = await setup({ interactive: true, mock: { reasoning: analyst(prompts) } });
    await s.graph.invoke(s.state, s.config);
    const snap = await s.graph.getState(s.config);
    const req = snap.tasks[0]?.interrupts[0]?.value as ClarifyRequest;
    expect(req.kind).toBe('clarification');
    expect(req.questions.map((q) => q.id)).toEqual(['Q1']);

    s.checkpointer.close();
    const fresh = buildMainGraph({ ...s.deps, checkpointer: saver(join(s.root, '.qa-memory', 'checkpoints.db')) });
    await fresh.invoke(new Command({ resume: { answers: { Q1: 'North and South' } } }), s.config);
    const v = (await fresh.getState(s.config)).values as QAGraphStateType;
    expect(v.status).toBe('COMPLETE');
    expect(v.clarifyRound).toBe(1);
    expect(v.clarifications[0]).toMatchObject({ status: 'ANSWERED', answer: 'North and South' });
    const secondExtract = prompts.filter((p) => p.includes('Turn the source documents into canonical'))[1] ?? '';
    expect(secondExtract).toContain('[CLARIFICATIONS#Q1]');
    expect(secondExtract).toContain('Answer (human): North and South');
  });

  it('a second clarification round is asked too (bounded by maxClarifyRounds), then the run reports', async () => {
    let analyzeCalls = 0;
    const mock = {
      reasoning: {
        responder: (msgs: BaseMessage[]) => {
          const all = msgs.map(messageText).join('\n');
          if (all.includes('Turn the source documents into canonical')) return extractJson;
          analyzeCalls += 1;
          return JSON.stringify({
            findings: [],
            questions: [
              {
                question:
                  analyzeCalls === 1
                    ? 'Which regions are on the approved list?'
                    : 'Must a Clerk pick a Region before saving an Order?',
                refs: ['AC2'],
                requirementIds: [],
                testImpact: 'cases',
                proposedAssumption: 'no region asserts',
                priority: 1,
              },
            ],
          });
        },
      },
    };
    const s = await setup({ interactive: true, mock });
    await s.graph.invoke(s.state, s.config);
    await s.graph.invoke(new Command({ resume: { answers: { Q1: 'North' } } }), s.config);
    const round2 = (await s.graph.getState(s.config)).tasks[0]?.interrupts[0]?.value as ClarifyRequest | undefined;
    expect(round2?.round).toBe(2);
    expect(round2?.questions.map((q) => q.id)).toEqual(['Q2']);
    await s.graph.invoke(new Command({ resume: { answers: { Q2: 'South' } } }), s.config);
    const v = (await s.graph.getState(s.config)).values as QAGraphStateType;
    expect(v.clarifyRound).toBe(2);
    expect(v.clarifications.map((c) => `${c.id}:${c.status}`)).toEqual(['Q1:ANSWERED', 'Q2:ANSWERED']);
    expect(v.triageLog.map((d) => d.response)).toEqual(['ask', 'ask']);
    expect((await s.graph.getState(s.config)).next).toEqual([]);
  });

  it('interactive but timed out → ASSUMED; L3 never waits', async () => {
    const s = await setup({ interactive: true });
    await s.graph.invoke(s.state, s.config);
    await s.graph.invoke(new Command({ resume: { answers: {}, timedOut: true } }), s.config);
    const v = (await s.graph.getState(s.config)).values as QAGraphStateType;
    expect(v.clarifications[0]?.status).toBe('ASSUMED');

    const l3 = await setup({ interactive: true, autonomy: 'L3' });
    const v3 = await run(l3);
    expect((await l3.graph.getState(l3.config)).next).toEqual([]);
    expect(v3.clarifications[0]?.status).toBe('ASSUMED');
  });

  it('model output stays invalid → triage degrades to the mechanical analyst → PARTIAL', async () => {
    const s = await setup({
      mock: { reasoning: { responder: () => 'nonsense' }, 'reasoning:fallback': { responder: () => 'nonsense' } },
    });
    const v = await run(s);
    expect(v.triageLog.map((d) => `${d.kind}→${d.response}`)).toContain('INVALID_LLM_OUTPUT→degrade');
    expect(v.requirements.length).toBe(2);
    expect(v.requirements.every((r) => r.status === 'REVIEW_REQUIRED')).toBe(true);
    expect(v.analysisEnvironment).toBe('NONE'); // mechanical output: no model answered
    expect(v.status).toBe('PARTIAL');
  });

  it('a corrupt input is skipped (DATA → degrade), the others continue → PARTIAL with the reason', async () => {
    const s = await setup({ inputs: [] });
    writeFileSync(join(s.root, 'broken.pdf'), 'not a pdf');
    writeFileSync(join(s.root, 'story.md'), STORY);
    const v = await run({
      ...s,
      state: {
        ...s.state,
        inputs: [
          { kind: 'file', value: 'broken.pdf' },
          { kind: 'file', value: 'story.md' },
        ],
      },
    });
    expect(v.triageLog.map((d) => `${d.kind}→${d.response}`)).toEqual(['DATA→degrade', 'AMBIGUOUS_SPEC→ask']);
    expect(v.requirements.length).toBe(2);
    expect(v.status).toBe('PARTIAL');
  });

  it('JIRA keeps failing with 503 → retry ×3 with backoff → escalate (policy TRANSIENT) → nothing to analyse → report PARTIAL', async () => {
    const f = vi.fn(() => Promise.resolve(new Response('{}', { status: 503 })));
    const s = await setup({ inputs: [{ kind: 'jira', value: 'ORD-1' }] });
    const deps = {
      ...s.deps,
      adapter: {
        ...s.deps.adapter,
        env: { JIRA_BASE_URL: 'https://x.atlassian.net', JIRA_EMAIL: 'a@b.test', JIRA_API_TOKEN: 'tok-1234567890' },
        fetch: f as unknown as typeof fetch,
      },
    };
    const graph = buildMainGraph(deps);
    await graph.invoke(s.state, s.config);
    const v = (await graph.getState(s.config)).values as QAGraphStateType;
    expect(v.triageLog.map((d) => d.response)).toEqual(['retry', 'retry', 'retry', 'escalate']);
    expect(deps.sleep).toHaveBeenCalledWith(2000);
    expect(deps.sleep).toHaveBeenCalledWith(30000);
    expect(f).toHaveBeenCalledTimes(4);
    expect(v.status).toBe('PARTIAL');
    expect(existsSync(join(s.root, 'runs', s.runId, 'analysis', 'analysis-report.md'))).toBe(true);
  });

  it('a secret about to enter a prompt → HARD_STOP → BLOCKED, and the report is still written', async () => {
    const s = await setup({
      inputs: [{ kind: 'chat', value: `${STORY}\nkey ${TEST_SECRET}` }],
      deps: { redactor: undefined },
    });
    const v = await run(s);
    expect(v.status).toBe('BLOCKED');
    expect(v.issues.find((i) => i.kind === 'HARD_STOP')?.resolution).toBe('ESCALATED');
    expect(v.triageLog.at(-1)?.response).toBe('halt');
    const md = readFileSync(join(s.root, 'runs', s.runId, 'analysis', 'analysis-report.md'), 'utf8');
    expect(md).toContain('status **BLOCKED**');
    expect(md).not.toContain(TEST_SECRET);
  });
});
