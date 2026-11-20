import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteCheckpointSaver } from './checkpointer.js';

const S = Annotation.Root({
  asked: Annotation<string>(),
  answer: Annotation<string | undefined>(),
});

function build(saver: SqliteCheckpointSaver) {
  return new StateGraph(S)
    .addNode('ask', (s) => {
      const answer = interrupt<{ q: string }, string>({ q: s.asked });
      return { answer };
    })
    .addEdge(START, 'ask')
    .addEdge('ask', END)
    .compile({ checkpointer: saver });
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('SqliteCheckpointSaver', () => {
  it('survives a new process: interrupt, reopen the db, resume with the answer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp with spaces '));
    dirs.push(dir);
    const file = join(dir, 'checkpoints.db');
    const config = { configurable: { thread_id: 'run-1' } };

    const s1 = new SqliteCheckpointSaver(file);
    const g1 = build(s1);
    await g1.invoke({ asked: 'Is Email required?' }, config);
    const paused = await g1.getState(config);
    expect(paused.tasks[0]?.interrupts[0]?.value).toEqual({ q: 'Is Email required?' });
    s1.close();

    const s2 = new SqliteCheckpointSaver(file); // simulates `qa resume` in a fresh process
    expect(s2.threads()).toEqual(['run-1']);
    const g2 = build(s2);
    const snap = await g2.getState(config);
    expect(snap.next).toEqual(['ask']);
    const done = await g2.invoke(new Command({ resume: 'yes' }), config);
    expect(done.answer).toBe('yes');
    await s2.deleteThread('run-1');
    expect(s2.threads()).toEqual([]);
    s2.close();
  });
});
