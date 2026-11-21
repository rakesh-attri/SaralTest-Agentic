import type { BaseMessage } from '@langchain/core/messages';
import ExcelJS from 'exceljs';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mockRouter } from '../../tests/helpers/mockRouter.js';
import { REPO_ROOT } from '../../tests/helpers/tempProject.js';
import {
  SNAP,
  clarifications,
  components,
  docs,
  findings,
  manualTests,
  orgChecks,
  requirements,
} from '../../tests/helpers/designFixtures.js';
import { projectPaths, requireConfig } from '../config/loader.js';
import { nullLogger } from '../core/logger.js';
import { ReviewFinding, RtmRow, TestCase } from '../core/schemas/index.js';
import { initialRunState, type InputRequest } from '../core/state.js';
import { messageText } from '../models/secretGuard.js';
import { SqliteCheckpointSaver } from './checkpointer.js';
import type { DesignHook, DesignInputs } from './designNodes.js';
import { buildMainGraph, type GraphDeps } from './mainGraph.js';
import type { QAGraphStateType } from './state.js';

const policy = await requireConfig('policy', projectPaths(REPO_ROOT));
const roots: string[] = [];
const savers: SqliteCheckpointSaver[] = [];
afterAll(() => {
  for (const sv of savers) sv.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const inputs: DesignInputs = {
  snapshotId: SNAP,
  snapshotEnvironment: 'FIXTURE',
  components,
  orgChecks,
  locators: [],
  personas: [{ id: 'system-admin', profile: 'System Administrator' }],
  defaultPersona: 'system-admin',
  recipes: ['account-contact'],
  notes: ['design inputs from the test fixture (FIXTURE)'],
};

/** Mock planner: one case per obligation citing its first allowed evidence (no invented values). */
function planner(): (m: BaseMessage[]) => string {
  return (messages) => {
    const all = messages.map(messageText).join('\n');
    if (all.includes('answering the Test Reviewer')) {
      const ids = [...all.matchAll(/(RF-\d{3}) \[/g)].map((m) => m[1]);
      return JSON.stringify({
        cases: [],
        justifications: ids.map((id) => ({
          findingId: id,
          reason: 'Accepted as recorded; the blocker is outside test design.',
        })),
      });
    }
    const cases = all
      .split(/\n(?= {2}OB-\d{3})/)
      .map((b) => {
        const ob = /^ {2}(OB-\d{3}) \[/.exec(b)?.[1];
        if (!ob) return undefined;
        const persona = /· persona ([a-z0-9-]+)/.exec(b)?.[1] ?? 'system-admin';
        const ev = /\n {4}- ([^\s(]+) \(/.exec(b)?.[1] ?? 'SF-219#AC1';
        const kind = /\[[^·]+· (\w+) ·/.exec(b)?.[1] ?? 'positive';
        const values = /· values ([\d, ]+)/.exec(b)?.[1] ?? '';
        return {
          key: ob,
          title: `Verify ${ob} (${kind})`,
          obligationIds: [ob],
          persona,
          type:
            kind === 'negative' || kind === 'boundary'
              ? 'negative'
              : kind === 'bulk'
                ? 'bulk'
                : kind === 'deny'
                  ? 'security'
                  : 'functional',
          technique: kind === 'boundary' ? 'boundary value analysis' : 'use case',
          steps: [
            {
              action: `Open the Account page, use the Contacts related list and save${values ? ` with ${values}` : ''}${kind === 'bulk' ? ' for 200 records' : ''}`,
              expected: 'The record page shows the outcome the cited evidence states',
              obligationId: ob,
              evidence: [ev],
            },
          ],
        };
      })
      .filter(Boolean);
    return JSON.stringify({ cases });
  };
}

const judge = (): ((m: BaseMessage[]) => string) => (messages) => {
  const all = messages.map(messageText).join('\n');
  if (all.includes('re-checking your own earlier findings')) {
    const ids = [...all.matchAll(/(RF-\d{3}) \[/g)].map((m) => m[1]);
    return JSON.stringify({
      verdicts: ids.map((id) => ({ findingId: id, resolved: false, reason: 'still not observable' })),
    });
  }
  const first = /\n(TC-[A-Z0-9-]+) \[/.exec(all)?.[1];
  return JSON.stringify({
    findings: first
      ? [
          {
            severity: 'L',
            caseIds: [first],
            topic: 'observability',
            text: 'Expected text should name the exact field or message shown',
          },
        ]
      : [],
  });
};

async function setup(o: { router?: boolean; hook?: DesignHook; inputs?: InputRequest[]; seeded?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'qa design graph '));
  roots.push(root);
  const checkpointer = new SqliteCheckpointSaver(join(root, '.qa-memory', 'checkpoints.db'));
  savers.push(checkpointer);
  const deps: GraphDeps = {
    root,
    policy,
    logger: nullLogger(),
    ...(o.router
      ? {
          router: await mockRouter({
            reasoning: { responder: planner() },
            'reasoning:fallback': { responder: planner() },
            judge: { responder: judge() },
          }),
        }
      : {}),
    adapter: { root, cwd: root, env: {} },
    memoryDir: join(root, '.qa-memory'),
    checkpointer,
    sleep: vi.fn(() => Promise.resolve()),
    design: o.hook ?? vi.fn(() => Promise.resolve(inputs)),
  };
  const runId = `run-design-${String(roots.length)}`;
  const base = initialRunState({
    runId,
    org: 'fixture',
    autonomy: 'L2',
    source: { type: 'file', ref: 'test' },
    storyKey: 'SF-219',
    tokenLimit: 1_000_000,
    timeLimitMin: 30,
    inputs: o.inputs ?? [],
  });
  const state = {
    ...base,
    interactive: false,
    ...(o.seeded === false
      ? {}
      : { sources: docs, requirements, findings, clarifications, existingTests: manualTests }),
  };
  const graph = buildMainGraph(deps);
  const config = { configurable: { thread_id: runId } };
  await graph.invoke(state, config);
  const v = (await graph.getState(config)).values as QAGraphStateType;
  return { v, root, runId, deps };
}

describe('main graph — plan ⇄ review (Phase 3)', () => {
  it('a seeded run (qa design) enters at plan, reviews, settles and writes the design outputs (mechanical)', async () => {
    const { v, root, runId } = await setup();
    expect(v.testCases.length).toBeGreaterThan(0);
    for (const c of v.testCases) expect(TestCase.safeParse(c).success).toBe(true);
    for (const r of v.rtm) expect(RtmRow.safeParse(r).success).toBe(true);
    for (const f of v.reviewFindings) {
      expect(ReviewFinding.safeParse(f).success).toBe(true);
      expect(f.status).not.toBe('OPEN');
    }
    expect(v.reviewRound).toBeGreaterThanOrEqual(1);
    expect(v.designEnvironment).toBe('NONE');
    expect(v.orgEnvironment).toBe('FIXTURE');
    expect(v.status).toBe('PARTIAL'); // no model → mechanical drafting is a degradation
    // every AC covered
    const acs = docs[0]?.sections.filter((s) => s.kind === 'ac').map((s) => s.ref) ?? [];
    for (const ac of acs) expect(v.testCases.some((c) => c.refs.includes(ac))).toBe(true);
    const dir = join(root, 'runs', runId, 'design');
    for (const f of [
      'test-plan.md',
      'test-cases.md',
      'charter.md',
      'rtm.json',
      'rtm.xlsx',
      'test-design-report.html',
      'review-pass1.json',
      'risks.json',
    ]) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
    const plan = readFileSync(join(dir, 'test-plan.md'), 'utf8');
    expect(plan).toContain('**Mechanical**');
    expect(plan).toContain('**FIXTURE**');
    expect(plan).toMatch(/AC coverage: \*\*5\/5\*\*/);
    expect(plan).toMatch(/\*\*0 open\*\*/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(join(dir, 'rtm.xlsx'));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['RTM', 'Test Cases', 'Risks', 'Review Findings']);
    expect(wb.getWorksheet('RTM')?.getRow(2).getCell(9).value).toBe('MECHANICAL · FIXTURE');
  });

  it('with a model: drafted cases, judge round + verification, MOCK labelled everywhere', async () => {
    const { v, root, runId } = await setup({ router: true });
    expect(v.designEnvironment).toBe('MOCK');
    expect(v.testCases.some((c) => c.origin === 'planned')).toBe(true);
    const judgeFindings = v.reviewFindings.filter((f) => f.origin === 'judge');
    expect(judgeFindings.length).toBe(1);
    expect(judgeFindings[0]?.status).toBe('JUSTIFIED'); // planner justified it in the revise step
    expect(v.reviewFindings.every((f) => f.status !== 'OPEN')).toBe(true);
    const html = readFileSync(join(root, 'runs', runId, 'design', 'test-design-report.html'), 'utf8');
    expect(html).toContain('MOCK');
    expect(html).toContain('AC coverage');
  });

  it('a failing design hook never throws out of the graph: the run still reports (PARTIAL)', async () => {
    const hook = vi.fn(() => Promise.reject(new Error('snapshot store unreadable')));
    const { v, root, runId } = await setup({ hook });
    expect(v.status).toBe('PARTIAL');
    expect(v.issues.some((i) => i.node === 'plan')).toBe(true);
    expect(existsSync(join(root, 'runs', runId, 'analysis', 'analysis-report.md'))).toBe(true);
  });

  it('an analysis run continues into plan when a design hook is set', async () => {
    const story = ['**Summary:** Clerks create Orders', '', 'AC1 – Create', 'Then the Order is saved'].join('\n');
    const { v } = await setup({ seeded: false, inputs: [{ kind: 'chat', value: story }] });
    expect(v.requirements.length).toBeGreaterThan(0);
    expect(v.testCases.length).toBeGreaterThan(0);
    expect(v.testCases.every((c) => c.origin === 'mechanical')).toBe(true);
  });
});
