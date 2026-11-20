import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { secretValues } from '../../config/env.js';
import { modelFamily } from '../../config/modelFamily.js';
import { MODEL_ROLES, isOpenAICompatible, type ChatProvider } from '../../config/schemas.js';
import { classifyError } from '../../core/classifyError.js';
import { resolveEndpoint } from '../../models/endpoints.js';
import { groupModels, listAvailableModels, suggestGeminiModels, type AvailableModel } from '../../models/listModels.js';
import { ModelRouter } from '../../models/router.js';
import { resolveJudgeChain } from '../../eval/judgeEndpoint.js';
import type { ProviderSecrets } from '../../models/providers/index.js';
import type { Check, CheckResult, DoctorContext } from '../types.js';

function providerSecrets(ctx: DoctorContext): ProviderSecrets {
  return {
    get: async (k) => (await ctx.secrets.get(k)).value,
    setting: (k) => ctx.env[k],
  };
}

const isPlaceholder = (s: string): boolean => /<[^<>]+>/.test(s);
/** Providers whose model list doctor can fetch with a key (read-only metadata endpoints). */
const LISTABLE: readonly ChatProvider[] = ['google', 'nvidia-nim', 'groq', 'openai-compatible', 'openai', 'anthropic'];
const oneLine = (err: unknown, max = 300): string => {
  const msg = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ');
  return msg.length > max ? `${msg.slice(0, max)}…` : msg;
};

export const modelsCheck: Check = async (ctx) => {
  const base = { id: 'models', title: 'Model providers (ModelRouter)' };
  if (!ctx.config.models.ok) {
    return { ...base, status: 'red', summary: 'config/models.yaml invalid', details: ctx.config.models.errors };
  }
  const cfg = ctx.config.models.value;
  const secrets = providerSecrets(ctx);
  const router = await ModelRouter.create({
    config: cfg,
    secrets,
    secretValues: () => secretValues(ctx.env),
    logger: ctx.logger,
  });
  const details: string[] = [];
  let status = 'green' as CheckResult['status']; // widened: bump() mutates it
  const bump = (s: CheckResult['status']): void => {
    if (s === 'red' || (s === 'yellow' && status === 'green')) status = s;
  };

  const roleStatus = router.status();
  const used = new Set<ChatProvider>(roleStatus.flatMap((s) => [s.provider, ...s.fallbacks.map((f) => f.provider)]));
  if (cfg.embeddings.provider === 'google') used.add('google');

  // Model ids each key can use (read-only list calls), printed so the operator can pick ids.
  const listed = new Map<ChatProvider, AvailableModel[]>();
  if (!ctx.options.offline) {
    for (const provider of LISTABLE.filter((p) => used.has(p))) {
      let where = '';
      try {
        if (isOpenAICompatible(provider)) {
          where = ` at ${new URL(resolveEndpoint(provider, cfg.endpoints, (k) => ctx.env[k]).baseURL).host}`;
        }
        const models = await listAvailableModels(provider, secrets, 15_000, ctx.deps.fetch, cfg.endpoints);
        listed.set(provider, models);
        details.push(`${provider}${where}: key accepted, ${models.length} models available to it`);
        if (isOpenAICompatible(provider)) {
          const { groups, hidden } = groupModels(models);
          for (const [ns, ids] of groups) details.push(`  ${ns}: ${ids.join(', ')}`);
          if (hidden) details.push(`  (${hidden} non-chat ids hidden: embedding/rerank/speech/guard/vision)`);
        }
      } catch (err) {
        const missingKey = classifyError(err).detail['missingKey'];
        if (typeof missingKey === 'string') {
          details.push(`${provider}: ${missingKey} is not set, so its models cannot be listed`);
          bump('yellow');
        } else {
          details.push(`${provider}${where} list-models failed: ${oneLine(err)}`);
          bump('red');
        }
      }
    }
  }

  const describe = (provider: ChatProvider, model: string, ok: boolean, error: string | undefined): string => {
    if (!ok) {
      const unconfigured = isPlaceholder(model);
      bump(unconfigured ? 'yellow' : 'red');
      return unconfigured ? 'placeholder (not configured)' : (error ?? 'error');
    }
    const list = listed.get(provider);
    if (list && !list.some((m) => m.id === model)) {
      bump('red');
      return 'model id not available to this key';
    }
    return 'ready';
  };
  let degraded = 0;
  for (const s of roleStatus) {
    details.push(`${s.role}: ${s.provider}/${s.model} → ${describe(s.provider, s.model, s.ok, s.error)}`);
    s.fallbacks.forEach((f, i) => {
      details.push(`  fallback ${i + 1} ${f.provider}/${f.model} → ${describe(f.provider, f.model, f.ok, f.error)}`);
    });
    if (!s.ok && router.chain(s.role).length) {
      degraded++;
      details.push(`  ${s.role} currently runs on ${router.chain(s.role)[0]?.id ?? '?'} (primary not usable)`);
    }
  }

  // Judge independence (rule 8 + operator decision 2026-11-20: judge and coder from different model families).
  // The schema already rejects an identical model; a shared family is a warning (Gemini-only setups stay valid).
  const judge = cfg.roles.judge.model;
  const coder = cfg.roles.coder.model;
  if (!isPlaceholder(judge) && !isPlaceholder(coder)) {
    const jf = modelFamily(judge);
    const cf = modelFamily(coder);
    if (!jf || !cf) {
      details.push(`judge/coder families: could not tell the family of ${!jf ? judge : coder}; confirm they differ`);
      bump('yellow');
    } else if (jf === cf) {
      details.push(
        `judge/coder families: both ${jf} — pick a judge from a different family than the coder (judge independence)`,
      );
      bump('yellow');
    } else {
      details.push(`judge/coder families: ${jf} vs ${cf} (different)`);
    }
  }

  const quotaLine = [...used]
    .filter((p) => p !== 'mock')
    .map((p) => {
      const q = router.quota(p);
      const parts = [
        q.requestsPerMinute !== undefined ? `${q.requestsPerMinute} req/min` : 'no req limit',
        ...(q.tokensPerMinute !== undefined ? [`${q.tokensPerMinute} tokens/min`] : []),
        `fails over after ${Math.round(q.maxWaitMs / 1000)} s wait`,
      ];
      return `${p} ${parts.join(', ')}`;
    });
  if (quotaLine.length) details.push(`quotas: ${quotaLine.join('; ')}`);

  // DeepEval judge: the same judge chain over OpenAI-compatible endpoints (src/eval/judgeEndpoint.ts).
  const dj = resolveJudgeChain(cfg, (k) => ctx.env[k]);
  details.push(
    `DeepEval judge chain: ${dj.chain.length ? dj.chain.map((e) => `${e.provider}/${e.model}`).join(' → ') : 'none usable yet'}` +
      (dj.skipped.length
        ? ` (skipped: ${dj.skipped.map((x) => `${x.provider}/${x.model} — ${x.reason}`).join('; ')})`
        : ''),
  );

  const emb = cfg.embeddings;
  const googleList = listed.get('google');
  if (isPlaceholder(emb.model)) {
    details.push(`embeddings: ${emb.provider}/${emb.model} → placeholder (not configured)`);
    bump('yellow');
  } else if (emb.provider === 'google' && googleList && !googleList.some((m) => m.id === emb.model)) {
    details.push(`embeddings: ${emb.provider}/${emb.model} → model id not available to this key`);
    bump('red');
  } else {
    details.push(`embeddings: ${emb.provider}/${emb.model} → configured`);
  }

  let fix: string | undefined;
  if (googleList) {
    const sug = suggestGeminiModels(googleList);
    const line = [...MODEL_ROLES, 'embeddings' as const].map((r) => `${r}=${sug[r] ?? '?'}`).join(', ');
    details.push(
      `Suggested from models listed for your key (Gemini; listed is not proof a model can be called; confirm, then run qa doctor --live): ${line}`,
    );
    if (sug.newerPreview) {
      const p = Object.entries(sug.newerPreview)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      details.push(`Newer preview models also available (not GA): ${p}`);
    }
  }
  if (status !== 'green') {
    fix =
      'pick model ids from the lists above, set them in config/models.yaml (and any missing keys in .env), then re-run qa doctor';
  }

  let liveFailures = 0;
  if (ctx.options.live && !ctx.options.offline) {
    const probe = tool(() => 'pong', { name: 'ping', description: 'Returns pong.', schema: z.object({}) });
    for (const role of MODEL_ROLES) {
      for (const c of router.chain(role)) {
        const label = `live ${role}${c.index ? ` fallback ${c.index}` : ''} ${c.id}`;
        try {
          const out = await c.model.invoke([new HumanMessage('Reply with the single word OK.')]);
          const text = typeof out.content === 'string' ? out.content : JSON.stringify(out.content);
          details.push(`${label}: answered "${text.trim().slice(0, 20)}"`);
        } catch (err) {
          details.push(`${label}: FAILED ${oneLine(err, 400)}`);
          liveFailures++;
          bump('red');
          continue;
        }
        if (c.model.supportsTools) {
          try {
            await c.model.bindTools([probe]).invoke([new HumanMessage('Call the ping tool.')]);
            details.push(`${label}: tool calling accepted`);
          } catch (err) {
            details.push(
              `${label}: tool calling rejected (${oneLine(err, 160)}) → set tools: false for it in models.yaml`,
            );
            bump('yellow');
          }
        }
      }
    }
    details.push(`live calls used ${router.totalTokens()} tokens`);
  }

  const notReady = roleStatus.filter((s) => !s.ok).length;
  return {
    ...base,
    status,
    summary:
      status === 'green'
        ? ctx.options.live && !ctx.options.offline
          ? `every model in all ${MODEL_ROLES.length} role chains answered a live call`
          : `all ${MODEL_ROLES.length} roles configured and listed for their keys (not called; run qa doctor --live to verify)`
        : liveFailures
          ? `${liveFailures} model(s) failed a live call`
          : notReady
            ? `${notReady} of ${MODEL_ROLES.length} role primaries not configured${degraded ? ` (${degraded} running on a fallback)` : ''}`
            : 'configuration problem (see details)',
    details,
    ...(fix ? { fix } : {}),
  };
};
