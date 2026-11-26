import { attemptLog } from '../../models/attemptLog.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { ModelRole } from '../../config/schemas.js';
import { classifyError } from '../../core/classifyError.js';
import { QAError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import { isRateLimited } from '../../models/rateLimiter.js';
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
  /**
   * Compact description of the output type that replaces the JSON Schema text in the prompt (large schemas cost
   * thousands of tokens). The reply is still validated against `schema`.
   */
  contract?: string;
  /**
   * Deterministic, meaning-preserving clean-up applied after the schema parse and before `check` (e.g. mapping an
   * unambiguous alias to the canonical id). The returned value is what the caller gets.
   */
  normalize?: (value: T) => T;
  /** Deterministic checks beyond the schema; each returned string is reflected back to the model. */
  check?: (value: T) => string[];
  reflectRetries?: number;
  maxToolRounds?: number;
  redactor?: Redactor;
  logger?: Logger;
}

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface AttemptRecord {
  model: string;
  attempt: number;
  outcome: 'OK' | 'INVALID' | 'ERROR';
  problems?: string[];
  /** ERROR: HTTP status the provider sent (when any). */
  status?: number;
  /** ERROR: the provider's exact message (redacted), not a summary. */
  providerMessage?: string;
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
/** Escape raw control characters that appear inside JSON string literals (invalid JSON some models emit). */
export function escapeControlCharsInStrings(json: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      else if (ch < ' ') {
        out +=
          ch === '\n'
            ? '\\n'
            : ch === '\r'
              ? '\\r'
              : ch === '\t'
                ? '\\t'
                : `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
        continue;
      }
    } else if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

function parseLenient(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    const fixed = escapeControlCharsInStrings(text);
    if (fixed === text) throw err;
    return JSON.parse(fixed);
  }
}

export function extractJson(raw: string): unknown {
  // Reasoning models (e.g. some NVIDIA NIM / Groq models) may emit <think>…</think> before the answer.
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const candidate = (fenced ?? text).trim();
  try {
    return parseLenient(candidate);
  } catch {
    const start = candidate.search(/[[{]/);
    const open = candidate.charAt(start);
    const end = candidate.lastIndexOf(open === '[' ? ']' : '}');
    if (start < 0 || end <= start) throw new Error('no JSON object found in the reply');
    return parseLenient(candidate.slice(start, end + 1));
  }
}

export function zodProblems(err: z.ZodError, max = 25): string[] {
  const out = err.issues.slice(0, max).map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`);
  if (err.issues.length > max) out.push(`… and ${err.issues.length - max} more`);
  return out;
}

export function schemaText(schema: z.ZodType): string {
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
  normalize?: (v: T) => T,
): { value?: T; problems: string[] } {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (err) {
    return { problems: [`reply is not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { problems: zodProblems(parsed.error) };
  const value = normalize ? normalize(parsed.data) : parsed.data;
  const extra = check?.(value) ?? [];
  return extra.length ? { problems: extra } : { value, problems: [] };
}

/** The system prompt runStructured sends (instructions + skill descriptions + output contract). Exported for probes. */
export async function composeSystemPrompt<T>(
  opts: Pick<RunStructuredOptions<T>, 'system' | 'schema' | 'skills' | 'contract'>,
): Promise<string> {
  const skillBlock = opts.skills ? `\n\n${await opts.skills.loader.describe(opts.skills.names)}` : '';
  if (opts.contract) {
    return `${opts.system}${skillBlock}

## Output contract
Reply with ONE JSON value and nothing else (no prose, no markdown outside a single \`\`\`json block).
${opts.contract}`;
  }
  return `${opts.system}${skillBlock}

## Output contract
Reply with ONE JSON value and nothing else (no prose, no markdown outside a single \`\`\`json block). It must validate against this JSON Schema:
${schemaText(opts.schema)}`;
}

export async function runStructured<T>(opts: RunStructuredOptions<T>): Promise<StructuredResult<T>> {
  const reflectRetries = opts.reflectRetries ?? 2;
  const skillTool = opts.skills ? opts.skills.loader.loadSkillTool(opts.skills.names) : undefined;
  const system = await composeSystemPrompt(opts);
  const user = opts.redactor ? opts.redactor.redactText(opts.user) : opts.user;
  const skillsLoaded: string[] = [];
  const attempts: AttemptRecord[] = [];

  try {
    opts.router.get(opts.role);
  } catch (err) {
    // Primary unusable (placeholder, missing key): recorded, then the chain continues with the fallbacks.
    attempts.push({ model: opts.router.modelId(opts.role), attempt: 0, outcome: 'ERROR', problems: [String(err)] });
  }
  // The role's whole chain, primary first (e.g. NVIDIA NIM → Groq → Gemini).
  const models = opts.router.chain(opts.role).map((c) => ({
    model: c.model,
    id: c.id,
    fallback: c.index > 0,
    tools: c.model.supportsTools,
  }));
  if (!models.length) throw new QAError('TOOL_UNAVAILABLE', `no usable model for role ${opts.role}`);
  // Models that reject tool calls get the full skill bodies inline instead of the load_skill tool.
  let inlineSkills: string | undefined;
  const systemFor = async (tools: boolean): Promise<string> => {
    if (tools || !opts.skills) return system;
    if (inlineSkills === undefined) {
      const bodies = await Promise.all(
        opts.skills.names.map(async (n) => {
          try {
            const body = await opts.skills?.loader.load(n);
            if (body !== undefined && !skillsLoaded.includes(n)) skillsLoaded.push(n);
            return `### Skill: ${n}\n${body ?? ''}`;
          } catch (err) {
            return `### Skill: ${n}\n(could not load: ${err instanceof Error ? err.message : String(err)})`;
          }
        }),
      );
      inlineSkills = `\n\n## Skills (full text; this model has no load_skill tool)\n${bodies.join('\n\n')}`;
    }
    return `${system}${inlineSkills}`;
  };

  let lastError: unknown;
  let lastProblems: string[] = [];
  for (const [mi, m] of models.entries()) {
    const messages: BaseMessage[] = [new SystemMessage(await systemFor(m.tools)), new HumanMessage(user)];
    for (let attempt = 1; attempt <= reflectRetries + 1; attempt++) {
      let text: string;
      try {
        text = await converse(
          m.model,
          messages,
          m.tools ? skillTool : undefined,
          opts.maxToolRounds ?? 3,
          skillsLoaded,
        );
      } catch (err) {
        const c = classifyError(err);
        if (c.kind === 'HARD_STOP' || c.kind === 'BUDGET') throw err;
        const status = typeof c.detail['status'] === 'number' ? c.detail['status'] : undefined;
        const providerMessage = (opts.redactor?.redactText(errMessage(err)) ?? errMessage(err)).slice(0, 2000);
        attempts.push({
          model: m.id,
          attempt,
          outcome: 'ERROR',
          problems: [`${c.kind}: ${c.message}`],
          ...(status !== undefined ? { status } : {}),
          providerMessage,
        });
        const next = models[mi + 1];
        attemptLog.fail({
          agent: opts.agent,
          role: opts.role,
          model: m.id,
          attempt,
          outcome: 'ERROR',
          kind: c.kind,
          ...(status !== undefined ? { status } : {}),
          message: providerMessage,
          ...(next ? { next: next.id } : {}),
        });
        opts.logger?.warn(
          {
            agent: opts.agent,
            model: m.id,
            attempt,
            kind: c.kind,
            error: c.message,
            detail: c.detail,
            rateLimited: isRateLimited(err),
            providerMessage,
            next: next?.id,
          },
          next ? `model call failed; failing over to ${next.id}` : 'model call failed; no model left in the chain',
        );
        lastError = err;
        break; // next model
      }
      const v = validate(text, opts.schema, opts.check, opts.normalize);
      if (v.value !== undefined) {
        attempts.push({ model: m.id, attempt, outcome: 'OK' });
        if (m.fallback) attemptLog.fallback({ agent: opts.agent, model: m.id });
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
      attemptLog.fail({
        agent: opts.agent,
        role: opts.role,
        model: m.id,
        attempt,
        outcome: 'INVALID',
        kind: 'INVALID_LLM_OUTPUT',
        message: v.problems.slice(0, 3).join(' | '),
      });
      opts.logger?.warn(
        { agent: opts.agent, model: m.id, attempt, problems: v.problems.slice(0, 5), problemCount: v.problems.length },
        'invalid output; reflecting',
      );
      opts.logger?.debug(
        { agent: opts.agent, model: m.id, attempt, problems: v.problems, reply: text.slice(0, 4000) },
        'invalid output (full problems + reply excerpt)',
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
      attemptLog: attempts,
      handled: models.length > 1 ? ['fallback'] : [],
    });
  }
  throw new QAError('INVALID_LLM_OUTPUT', `${opts.agent}: output still invalid after reflect-retries and fallback`, {
    problems: lastProblems.slice(0, 10),
    attempts: attempts.length,
    attemptLog: attempts,
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
