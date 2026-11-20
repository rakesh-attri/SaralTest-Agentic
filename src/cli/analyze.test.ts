import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { makeTempProject } from '../../tests/helpers/tempProject.js';
import { initialRunState } from '../core/state.js';
import { createRuntime, explain, resumeAnalysis } from './analyze.js';
import { chatLoop } from './chat.js';
import { Prompter } from './prompter.js';

const root = makeTempProject();
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const STORY = [
  '**Summary:** Agents log calls',
  '',
  'AC1 – Log',
  'Then a Task is created',
  '',
  'AC2 – Subject',
  'Then the Subject must be one of the approved subjects',
];

function prompterFor(lines: string[], end = true): { p: Prompter; input: PassThrough } {
  const input = new PassThrough();
  const p = new Prompter(createInterface({ input }), new PassThrough());
  input.write(lines.map((l) => `${l}\n`).join(''));
  if (end) input.end();
  return { p, input };
}

describe('Prompter (works with piped stdin)', () => {
  it('keeps lines that arrive before ask(), then reports end of input', async () => {
    const { p } = prompterFor(['one', 'two']);
    await new Promise((r) => setTimeout(r, 10));
    expect(await p.ask('> ')).toBe('one');
    expect(await p.ask('> ')).toBe('two');
    expect(await p.ask('> ')).toBeUndefined();
  });

  it('rejects when the wait time is over', async () => {
    const { p } = prompterFor([], false);
    await expect(p.ask('> ', AbortSignal.timeout(20))).rejects.toThrow(/no answer in time/);
    p.close();
  });
});

describe('chat REPL', () => {
  it('story → inline question answered → /why answers from evidence → /status', async () => {
    const rt = await createRuntime({ root, offline: true, say: () => undefined });
    const out: string[] = [];
    const { p } = prompterFor([
      ...STORY,
      '.',
      'Inbound and Outbound only',
      '/why Q1',
      '/why R02',
      '/why nothing',
      '/status',
      '/quit',
    ]);
    try {
      await chatLoop(rt, p, 'L2', root, (s) => out.push(s));
    } finally {
      await rt.close();
    }
    const text = out.join('\n');
    expect(text).toMatch(/Q1 \[ANSWERED\]/);
    expect(text).toMatch(/Status: ANSWERED; answer: Inbound and Outbound only/);
    expect(text).toMatch(/CHAT-R02 — REVIEW_REQUIRED/);
    expect(text).toMatch(/\[CHAT#AC2\] AC2 – Subject \/ Then the Subject must be one of the approved subjects/);
    expect(text).toMatch(/Nothing with id "nothing"/);
  });
});

describe('qa resume', () => {
  it('a run paused at a clarification resumes in a new runtime (new process) with answers', async () => {
    const rt1 = await createRuntime({ root, offline: true, say: () => undefined });
    const runId = 'run-resume-test';
    const state = {
      ...initialRunState({
        runId,
        org: 'none',
        autonomy: 'L2',
        source: { type: 'chat', ref: 'chat' },
        tokenLimit: 100_000,
        timeLimitMin: 30,
        inputs: [{ kind: 'chat', value: STORY.join('\n') }],
      }),
      interactive: true,
    };
    await rt1.graph.invoke(state, { configurable: { thread_id: runId } });
    expect((await rt1.graph.getState({ configurable: { thread_id: runId } })).next).toEqual(['clarify']);
    await rt1.close();

    const rt2 = await createRuntime({ root, offline: true, say: () => undefined });
    try {
      const v = await resumeAnalysis(rt2, runId, { answersFile: { Q1: 'Inbound only' } }, () => undefined);
      expect(v?.clarifications[0]).toMatchObject({ id: 'Q1', status: 'ANSWERED', answer: 'Inbound only' });
      expect(v && explain(v, 'Q1')).toMatch(/Inbound only/);
      expect(await resumeAnalysis(rt2, 'run-unknown', {}, () => undefined)).toBeUndefined();
    } finally {
      await rt2.close();
    }
  });
});
