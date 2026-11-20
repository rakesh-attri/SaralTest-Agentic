import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mockRouter, TEST_SECRET } from '../../../tests/helpers/mockRouter.js';
import { REPO_ROOT } from '../../../tests/helpers/tempProject.js';
import { HardStopError, QAError } from '../../core/errors.js';
import { messageText } from '../../models/secretGuard.js';
import { Redactor } from '../../security/redact.js';
import { SkillLoader } from '../../skills/skillLoader.js';
import { escapeControlCharsInStrings, extractJson, runStructured } from './structured.js';

const Out = z.object({ items: z.array(z.object({ id: z.string(), n: z.number().int() })).min(1) });
const base = {
  role: 'reasoning' as const,
  agent: 'test-agent',
  schema: Out,
  system: 'You list items.',
  user: 'List one item.',
};

describe('extractJson', () => {
  it('reads fenced, bare and embedded JSON', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('{"a":2}')).toEqual({ a: 2 });
    expect(extractJson('Sure! here: {"a":3} done')).toEqual({ a: 3 });
    expect(() => extractJson('no json')).toThrow();
  });
});

describe('runStructured', () => {
  it('returns validated output and labels mock output MOCK', async () => {
    const router = await mockRouter({ reasoning: { responder: () => '{"items":[{"id":"x","n":1}]}' } });
    const r = await runStructured({ ...base, router });
    expect(r.value.items[0]?.id).toBe('x');
    expect(r.environment).toBe('MOCK');
    expect(r.usedFallback).toBe(false);
  });

  it('reflects the Zod error back and succeeds on retry (rule 2)', async () => {
    const seen: BaseMessage[][] = [];
    const router = await mockRouter({
      reasoning: {
        responder: (msgs, i) => {
          seen.push(msgs);
          return i === 0 ? '{"items":[{"id":"x","n":"one"}]}' : '{"items":[{"id":"x","n":1}]}';
        },
      },
    });
    const r = await runStructured({ ...base, router });
    expect(r.attempts.map((a) => a.outcome)).toEqual(['INVALID', 'OK']);
    const reflection = messageText(seen[1]?.at(-1) as BaseMessage);
    expect(reflection).toContain('items.0.n');
    expect(reflection).toMatch(/Do not invent facts/);
  });

  it('deterministic check failures are reflected like schema errors', async () => {
    const router = await mockRouter({
      reasoning: {
        responder: (_m, i) => (i === 0 ? '{"items":[{"id":"BAD","n":1}]}' : '{"items":[{"id":"ok","n":1}]}'),
      },
    });
    const r = await runStructured({
      ...base,
      router,
      check: (v) => v.items.filter((x) => x.id === 'BAD').map(() => 'id BAD does not exist in the sources'),
    });
    expect(r.value.items[0]?.id).toBe('ok');
  });

  it('exhausted reflect-retries → fallback model → success marked usedFallback', async () => {
    const router = await mockRouter({
      reasoning: { responder: () => 'not json at all' },
      'reasoning:fallback': { responder: () => '{"items":[{"id":"fb","n":2}]}' },
    });
    const r = await runStructured({ ...base, router });
    expect(r.usedFallback).toBe(true);
    expect(r.model).toBe('mock/mock-flash');
    expect(r.attempts.filter((a) => a.outcome === 'INVALID')).toHaveLength(3);
  });

  it('everything invalid → INVALID_LLM_OUTPUT QAError', async () => {
    const router = await mockRouter({
      reasoning: { responder: () => '{}' },
      'reasoning:fallback': { responder: () => '{}' },
    });
    const err = await runStructured({ ...base, router }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QAError);
    expect((err as QAError).kind).toBe('INVALID_LLM_OUTPUT');
  });

  it('primary provider error → fallback; both erroring → classified error', async () => {
    const boom = (): Error => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const r1 = await mockRouter({
      reasoning: { failFirst: { times: 9, error: boom } },
      'reasoning:fallback': { responder: () => '{"items":[{"id":"fb","n":3}]}' },
    });
    expect((await runStructured({ ...base, router: r1 })).usedFallback).toBe(true);
    const r2 = await mockRouter({
      reasoning: { failFirst: { times: 9, error: boom } },
      'reasoning:fallback': { failFirst: { times: 9, error: boom } },
    });
    const err = await runStructured({ ...base, router: r2 }).catch((e: unknown) => e);
    expect((err as QAError).kind).toBe('TRANSIENT');
  });

  it('a secret in the user content is redacted before the prompt; without redaction the guard hard-stops', async () => {
    let prompt = '';
    const router = await mockRouter({
      reasoning: {
        responder: (msgs) => {
          prompt = msgs.map(messageText).join('\n');
          return '{"items":[{"id":"x","n":1}]}';
        },
      },
    });
    await runStructured({
      ...base,
      router,
      user: `key is ${TEST_SECRET}`,
      redactor: new Redactor({ secrets: [TEST_SECRET] }),
    });
    expect(prompt).not.toContain(TEST_SECRET);
    const err = await runStructured({ ...base, router, user: `key is ${TEST_SECRET}` }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HardStopError);
  });

  it('agents see skill descriptions and pull bodies through load_skill (rule 9)', async () => {
    let system = '';
    let toolResult = '';
    const router = await mockRouter({
      reasoning: {
        responder: (msgs, i) => {
          if (i === 0) {
            system = messageText(msgs[0] as BaseMessage);
            return new AIMessage({
              content: '',
              tool_calls: [{ id: 't1', name: 'load_skill', args: { name: 'requirement-analysis' } }],
            });
          }
          toolResult = messageText(msgs.at(-1) as BaseMessage);
          return '{"items":[{"id":"x","n":1}]}';
        },
      },
    });
    const r = await runStructured({
      ...base,
      router,
      skills: { loader: SkillLoader.forProject(REPO_ROOT), names: ['requirement-analysis'] },
    });
    expect(system).toContain('- requirement-analysis:');
    expect(system).not.toContain('Ambiguity & gap checklist'); // body is not in the system prompt…
    expect(toolResult).toContain('Ambiguity & gap checklist'); // …it is pulled on demand
    expect(r.skillsLoaded).toEqual(['requirement-analysis']);
  });
});

describe('extractJson leniency (live demo)', () => {
  it('accepts raw newlines and tabs inside string literals', () => {
    const nl = String.fromCharCode(10);
    const tab = String.fromCharCode(9);
    const raw = `{"cases":[{"title":"line one${nl}line two${tab}end"}]}`;
    expect(extractJson(raw)).toEqual({ cases: [{ title: `line one${nl}line two${tab}end` }] });
    const escaped = escapeControlCharsInStrings(`{"a":"x${nl}y"}`);
    expect(escaped.includes(nl)).toBe(false);
    expect(JSON.parse(escaped)).toEqual({ a: `x${nl}y` });
    // newlines between tokens (outside strings) are left alone
    expect(escapeControlCharsInStrings(`{${nl}"a": 1}`)).toBe(`{${nl}"a": 1}`);
  });
});
