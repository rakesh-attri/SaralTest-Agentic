import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { ModelRole } from '../../config/schemas.js';
import { classifyError } from '../../core/classifyError.js';
import { QAError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import type { ModelRouter } from '../../models/router.js';
import { messageText } from '../../models/secretGuard.js';
import type { Redactor } from '../../security/redact.js';
import type { SkillLoader } from '../../skills/skillLoader.js';

/**
 * The one way agents get structured output from a model (CLAUDE.md rules 2, 8, 9):
 *   model (via ModelRouter role) → optional load_skill tool rounds → JSON → Zod parse + deterministic checks
 *   → on failure reflect the exact errors back (×reflectRetries) → fallback model → INVALID_LLM_OUTPUT.
 * Provider errors on the primary (TRANSIENT, TOOL_UNAVAILABLE …) also move to the fallback model; HARD_STOP and BUDGET
 * never do. User content is redacted (secrets + PII) before it leaves the machine.
 */
export interface RunStructuredOptions<T> {
  router: ModelRouter;
  role: ModelRole;
  agent: string;
  schema: z.ZodType<T>;
  /** Agent instructions (ours, not redacted). Skill descriptions + output contract are appended. */
  system: string;
  /** Task content (sources etc.) — redacted when a redactor is given. */
  user: string;
  skills?: { loader: SkillLoader; names: readonly string[] };
  /** Deterministic checks beyond the schema; each returned string is reflected back to the model. */
  check?: (value: T) => string[];
  reflectRetries?: number;
  maxToolRounds?: number;
  redactor?: Redactor;
  logger?: Logger;
}

export interface AttemptRecord {
  model: string;
  attempt: number;
  outcome: 'OK' | 'INVALID' | 'ERROR';
  problems?: string[];
}

export interface StructuredResult<T> {
  value: T;
  model: string;
  usedFallback: boolean;
  /** MOCK when the answering model is the mock provider (rule 13). */
  environment: 'LIVE' | 'MOCK';
  attempts: AttemptRecord[];
  skillsLoaded: string[];
}

/** Pull the JSON value out of a model reply (fenced block, or the outermost object/array). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const candidate = (fenced ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.search(/[[{]/);
    const open = candidate.charAt(start);
    const end = candidate.lastIndexOf(open === '[' ? ']' : '}');
    if (start < 0 || end <= start) throw new Error('no JSON object found in the reply');
    return JSON.parse(candidate.slice(start, end + 1));
  }
}

export function zodProblems(err: z.ZodError, max = 25): string[] {
  const out = err.issues.slice(0, max).map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`);
  if (err.issues.length > max) out.push(`… and ${err.issues.length - max} more`);
  return out;
}

function schemaText(schema: z.ZodType): string {
  try {
    return JSON.stringify(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }));
  } catch {
    return '(schema not representable; follow the field descriptions in the instructions)';
  }
}

function validate<T>(
  text: string,
  schema: z.ZodType<T>,
  check?: (v: T) => string[],
): { value?: T; problems: string[] } {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (err) {
    return { problems: [`reply is not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { problems: zodProblems(parsed.error) };
  const extra = check?.(parsed.data) ?? [];
  return extra.length ? { problems: extra } : { value: parsed.data, problems: [] };
}

export async function runStructured<T>(opts: RunStructuredOptions<T>): Promise<StructuredResult<T>> {
  const reflectRetries = opts.reflectRetries ?? 2;
  const skillTool = opts.skills ? opts.skills.loader.loadSkillTool(opts.skills.names) : undefined;
  const skillBlock = opts.skills ? `\n\n${await opts.skills.loader.describe(opts.skills.names)}` : '';
  const system = `${opts.system}${skillBlock}

## Output contract
Reply with ONE JSON value and nothing else (no prose, no markdown outside a single \`\`\`json block). It must validate against this JSON Schema:
${schemaText(opts.schema)}`;
  const user = opts.redactor ? opts.redactor.redactText(opts.user) : opts.user;
  const skillsLoaded: string[] = [];
  const attempts: AttemptRecord[] = [];

  const primary = (() => {
    try {
      return opts.router.get(opts.role);
    } catch (err) {
      attempts.push({ model: opts.router.modelId(opts.role), attempt: 0, outcome: 'ERROR', problems: [String(err)] });
      return undefined;
    }
  })();
  const models: { model: BaseChatModel; id: string; fallback: boolean }[] = [];
  if (primary) models.push({ model: primary, id: opts.router.modelId(opts.role), fallback: false });
  const fb = opts.router.getFallback(opts.role);
  if (fb) models.push({ model: fb, id: opts.router.modelId(opts.role, true), fallback: true });
  if (!models.length) throw new QAError('TOOL_UNAVAILABLE', `no usable model for role ${opts.role}`);

  let lastError: unknown;
  let lastProblems: string[] = [];
  for (const m of models) {
    const messages: BaseMessage[] = [new SystemMessage(system), new HumanMessage(user)];
    for (let attempt = 1; attempt <= reflectRetries + 1; attempt++) {
      let text: string;
      try {
        text = await converse(m.model, messages, skillTool, opts.maxToolRounds ?? 3, skillsLoaded);
      } catch (err) {
        const c = classifyError(err);
        if (c.kind === 'HARD_STOP' || c.kind === 'BUDGET') throw err;
        attempts.push({ model: m.id, attempt, outcome: 'ERROR', problems: [`${c.kind}: ${c.message}`] });
        opts.logger?.warn({ agent: opts.agent, model: m.id, kind: c.kind }, 'model call failed');
        lastError = err;
        break; // next model
      }
      const v = validate(text, opts.schema, opts.check);
      if (v.value !== undefined) {
        attempts.push({ model: m.id, attempt, outcome: 'OK' });
        return {
          value: v.value,
          model: m.id,
          usedFallback: m.fallback,
          environment: m.id.startsWith('mock/') ? 'MOCK' : 'LIVE',
          attempts,
          skillsLoaded,
        };
      }
      lastProblems = v.problems;
      lastError = undefined;
      attempts.push({ model: m.id, attempt, outcome: 'INVALID', problems: v.problems });
      opts.logger?.warn(
        { agent: opts.agent, model: m.id, attempt, problems: v.problems.slice(0, 5) },
        'invalid output; reflecting',
      );
      messages.push(new AIMessage(text.slice(0, 6000)));
      messages.push(
        new HumanMessage(
          `Your reply was rejected:\n${v.problems.map((p) => `- ${p}`).join('\n')}\nFix exactly these problems and reply with the corrected JSON only. Do not invent facts to satisfy the checks; omit or mark items as review-required instead.`,
        ),
      );
    }
  }
  if (lastError !== undefined && !lastProblems.length) {
    const c = classifyError(lastError);
    throw new QAError(c.kind, `${opts.agent}: every model failed (${c.message})`, {
      attempts: attempts.length,
      handled: models.length > 1 ? ['fallback'] : [],
    });
  }
  throw new QAError('INVALID_LLM_OUTPUT', `${opts.agent}: output still invalid after reflect-retries and fallback`, {
    problems: lastProblems.slice(0, 10),
    attempts: attempts.length,
    // Reflect-retries and the fallback model already ran here: QA Lead triage moves on to the next response.
    handled: models.length > 1 ? ['retry', 'fallback'] : ['retry'],
  });
}

/** One model turn, resolving up to `maxRounds` load_skill tool calls first. Returns the final reply text. */
async function converse(
  model: BaseChatModel,
  messages: BaseMessage[],
  skillTool: ReturnType<SkillLoader['loadSkillTool']> | undefined,
  maxRounds: number,
  skillsLoaded: string[],
): Promise<string> {
  if (!skillTool || !model.bindTools) return messageText(await model.invoke(messages));
  const bound = model.bindTools([skillTool]);
  const convo = [...messages];
  for (let round = 0; round < maxRounds; round++) {
    const res = await bound.invoke(convo);
    const calls = res.tool_calls ?? [];
    if (!calls.length) return messageText(res);
    convo.push(res);
    for (const call of calls) {
      const args: unknown = call.args;
      const name = args && typeof args === 'object' && 'name' in args && typeof args.name === 'string' ? args.name : '';
      let content: string;
      if (call.name === 'load_skill') {
        const out: unknown = await skillTool.invoke(args as Record<string, unknown>);
        content = typeof out === 'string' ? out : JSON.stringify(out);
        if (name && !skillsLoaded.includes(name)) skillsLoaded.push(name);
      } else {
        content = `Unknown tool ${call.name}. Only load_skill is available.`;
      }
      convo.push(new ToolMessage({ content, tool_call_id: call.id ?? `${call.name}-${round}` }));
    }
  }
  convo.push(new HumanMessage('Stop calling tools now and give the final JSON answer.'));
  return messageText(await model.invoke(convo));
}
