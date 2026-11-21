// Coder-model probe (diagnostics for the Test Generator). For each OpenAI-compatible model it checks:
//   model id listed by the provider (+ context window when the provider reports it) · plain JSON reply ·
//   response_format json_object · response_format json_schema (strict, tiny schema) · tool calling ·
//   the REAL generator prompt for one case (prompt tokens, latency, finish reason, rate-limit headers, and whether
//   the reply is a valid TestIR that passes the deterministic checks).
// Keys come from env / Credential Manager and are never printed; the case text is redacted as the router does.
//
//   pnpm tsx scripts/probe-coder.ts --from-run run-p3-live-5 --org qa-prod --case TC-SF-219-004 \
//     --models nvidia-nim/poolside/laguna-xs-2.1,groq/openai/gpt-oss-120b [--no-tools] [--max-tokens 4000]
import { resolve } from 'node:path';
import { bindRecipe, irProblems, normalizeIr } from '../src/agents/test-generator/context.js';
import { generatorPrompt, TEST_GENERATOR_SKILLS } from '../src/agents/test-generator/graph.js';
import { IR_CONTRACT } from '../src/agents/test-generator/promptParts.js';
import { composeSystemPrompt, extractJson } from '../src/agents/shared/structured.js';
import { createBuild, loadDesignRun } from '../src/cli/build.js';
import { parseModelChain } from '../src/cli/analyze.js';
import { loadEnv, secretValues } from '../src/config/env.js';
import { loadConfigFile, projectPaths } from '../src/config/loader.js';
import { isOpenAICompatible } from '../src/config/schemas.js';
import { TestIR } from '../src/core/schemas/generation.js';
import { resolveEndpoint } from '../src/models/endpoints.js';
import { listAvailableModels } from '../src/models/listModels.js';
import { Redactor } from '../src/security/redact.js';
import { SecretStore } from '../src/security/secretStore.js';
import { SkillLoader } from '../src/skills/skillLoader.js';

const args = process.argv.slice(2);
const arg = (k: string, d?: string): string | undefined => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const root = resolve(arg('root', resolve(import.meta.dirname, '..')) ?? '.');
const fromRun = arg('from-run', 'run-p3-live-5') ?? '';
const org = arg('org', 'qa-prod') ?? '';
const caseId = arg('case', 'TC-SF-219-004') ?? '';
const maxTokens = Number(arg('max-tokens', '4000'));
const noTools = args.includes('--no-tools');
const models = parseModelChain(arg('models', 'nvidia-nim/poolside/laguna-xs-2.1,groq/openai/gpt-oss-120b') ?? '');

const env = await loadEnv(root);
const store = new SecretStore(env);
const secrets = {
  get: async (k: Parameters<SecretStore['get']>[0]) => (await store.get(k)).value,
  setting: (k: string) => (env as Record<string, string | undefined>)[k],
};
const redactor = new Redactor({ secrets: secretValues(env) });
const cfg = await loadConfigFile('models', projectPaths(root));
const endpoints = cfg.ok ? cfg.value.endpoints : undefined;

// The exact prompt the generator sends for this case.
const seed = loadDesignRun(root, fromRun);
const tc = seed.testCases.find((c) => c.id === caseId);
if (!tc) throw new Error(`case ${caseId} not in ${fromRun}`);
const { ctx } = await createBuild({
  root,
  orgAlias: org,
  runId: 'probe-coder',
  designRunId: fromRun,
  storyKey: seed.storyKey,
  offline: true,
  say: () => undefined,
}).build({ runId: 'probe-coder', storyKey: seed.storyKey, testCases: seed.testCases });
const recipe = bindRecipe(tc, ctx);
const gp = generatorPrompt(ctx, tc, recipe);
const loader = SkillLoader.forProject(root);
let system = await composeSystemPrompt({
  system: gp.system,
  schema: TestIR,
  contract: IR_CONTRACT,
  skills: { loader, names: TEST_GENERATOR_SKILLS },
});
if (noTools) {
  const bodies = await Promise.all(TEST_GENERATOR_SKILLS.map(async (n) => `### Skill: ${n}\n${await loader.load(n)}`));
  system += `\n\n## Skills (full text; this model has no load_skill tool)\n${bodies.join('\n\n')}`;
}
const user = redactor.redactText(gp.user);
const parts = {
  instructions: gp.system.length,
  systemTotal: system.length,
  catalog: gp.user.indexOf('Field facts') - gp.user.indexOf('Page-object catalog'),
  schemaOrContract: IR_CONTRACT.length,
  user: user.length,
};
process.stdout.write(
  `Prompt for ${caseId}: system ${parts.systemTotal} chars (instructions ${parts.instructions}), user ${parts.user} chars (catalog ~${parts.catalog}); ≈${Math.ceil((parts.systemTotal + parts.user) / 4)} tokens by chars/4${noTools ? ' (skills inlined)' : ''}\n\n`,
);

interface Call {
  ok: boolean;
  status: number;
  ms: number;
  body: Record<string, unknown> | undefined;
  error?: string;
  headers: Record<string, string>;
}
async function chat(baseURL: string, key: string, body: Record<string, unknown>, timeoutMs = 180_000): Promise<Call> {
  const t0 = Date.now();
  try {
    const r = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => {
      if (/ratelimit|retry-after/i.test(k)) headers[k] = v;
    });
    let json: Record<string, unknown> | undefined;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = undefined;
    }
    const err = json?.['error'] as { message?: string; code?: string; type?: string } | string | undefined;
    const errText =
      typeof err === 'string' ? err : err ? `${err.code ?? err.type ?? ''} ${err.message ?? ''}`.trim() : undefined;
    return {
      ok: r.ok,
      status: r.status,
      ms: Date.now() - t0,
      body: json,
      ...(r.ok ? {} : { error: (errText ?? text).slice(0, 300) }),
      headers,
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - t0,
      body: undefined,
      error: e instanceof Error ? e.message : String(e),
      headers: {},
    };
  }
}
const content = (c: Call): string => {
  const ch = (
    c.body?.['choices'] as
      { message?: { content?: string | null; tool_calls?: unknown[] }; finish_reason?: string }[] | undefined
  )?.[0];
  return ch?.message?.content ?? '';
};
const finish = (c: Call): string =>
  (c.body?.['choices'] as { finish_reason?: string }[] | undefined)?.[0]?.finish_reason ?? '?';
const usage = (c: Call): { prompt_tokens?: number; completion_tokens?: number } =>
  (c.body?.['usage'] as { prompt_tokens?: number; completion_tokens?: number } | undefined) ?? {};
const verdict = (c: Call, test: (c: Call) => boolean): string =>
  c.ok
    ? test(c)
      ? `yes (${c.ms} ms)`
      : `answered but not as asked (${content(c).slice(0, 80).replace(/\s+/g, ' ')})`
    : `NO — HTTP ${c.status}: ${c.error ?? ''}`;

for (const m of models) {
  process.stdout.write(`=== ${m.provider}/${m.model}\n`);
  if (!isOpenAICompatible(m.provider)) {
    process.stdout.write('  (not an OpenAI-compatible provider; skipped)\n\n');
    continue;
  }
  const ep = resolveEndpoint(m.provider, endpoints, (k) => secrets.setting(k));
  const key = await secrets.get(ep.apiKeyEnv);
  if (!key) {
    process.stdout.write(`  ${ep.apiKeyEnv} not set\n\n`);
    continue;
  }
  try {
    const list = await listAvailableModels(m.provider, secrets, 20_000, fetch, endpoints);
    const hit = list.find((x) => x.id === m.model);
    process.stdout.write(
      `  model id listed: ${hit ? 'yes' : 'NO'}${hit?.contextWindow ? ` · context window ${hit.contextWindow}` : ' · context window not reported by the provider'}${hit?.active === false ? ' · INACTIVE' : ''}\n`,
    );
  } catch (e) {
    process.stdout.write(`  model list failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  const base = { model: m.model, temperature: 0, max_tokens: 64 };
  const ask = [{ role: 'user', content: 'Reply with exactly this JSON and nothing else: {"ok": true}' }];
  const isOk = (c: Call): boolean => /"ok"\s*:\s*true/.test(content(c));
  const plain = await chat(ep.baseURL, key, { ...base, messages: ask });
  process.stdout.write(`  plain JSON reply: ${verdict(plain, isOk)}\n`);
  const jo = await chat(ep.baseURL, key, { ...base, messages: ask, response_format: { type: 'json_object' } });
  process.stdout.write(`  response_format json_object: ${verdict(jo, isOk)}\n`);
  const js = await chat(ep.baseURL, key, {
    ...base,
    messages: ask,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'ok',
        strict: true,
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
      },
    },
  });
  process.stdout.write(`  response_format json_schema (strict): ${verdict(js, isOk)}\n`);
  const tools = await chat(ep.baseURL, key, {
    ...base,
    max_tokens: 128,
    messages: [{ role: 'user', content: 'Call the ping tool.' }],
    tools: [
      {
        type: 'function',
        function: { name: 'ping', description: 'Returns pong.', parameters: { type: 'object', properties: {} } },
      },
    ],
  });
  const calledTool = (c: Call): boolean =>
    Boolean(
      (c.body?.['choices'] as { message?: { tool_calls?: unknown[] } }[] | undefined)?.[0]?.message?.tool_calls?.length,
    );
  process.stdout.write(`  tool calling: ${verdict(tools, calledTool)}\n`);

  for (const mode of ['text', 'json_object'] as const) {
    const real = await chat(ep.baseURL, key, {
      model: m.model,
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      ...(mode === 'json_object' ? { response_format: { type: 'json_object' } } : {}),
    });
    const u = usage(real);
    let outcome: string;
    if (!real.ok) outcome = `FAILED — HTTP ${real.status}: ${real.error ?? ''}`;
    else {
      const raw = content(real);
      let parsed: unknown;
      try {
        parsed = extractJson(raw);
      } catch {
        parsed = undefined;
      }
      const ir = TestIR.safeParse(parsed);
      outcome = !ir.success
        ? `reply is not a valid TestIR (${
            parsed === undefined
              ? 'not JSON'
              : ir.error.issues
                  .slice(0, 3)
                  .map((i) => `${i.path.join('.')}: ${i.message}`)
                  .join('; ')
          })`
        : (() => {
            const p = irProblems(tc, normalizeIr(ir.data, ctx, recipe), ctx, recipe);
            return p.length
              ? `valid TestIR, ${p.length} deterministic problem(s): ${p.slice(0, 3).join(' | ')}`
              : 'valid TestIR, 0 problems';
          })();
    }
    process.stdout.write(
      `  real prompt (${mode}): ${real.ms} ms · prompt ${u.prompt_tokens ?? '?'} tok · completion ${u.completion_tokens ?? '?'} tok · finish ${finish(real)} · ${outcome}\n`,
    );
    if (Object.keys(real.headers).length)
      process.stdout.write(`    rate-limit headers: ${JSON.stringify(real.headers)}\n`);
  }
  process.stdout.write('\n');
}
