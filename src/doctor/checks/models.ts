import { HumanMessage } from '@langchain/core/messages';
import { secretValues } from '../../config/env.js';
import { MODEL_ROLES } from '../../config/schemas.js';
import { listAvailableModels, suggestGeminiModels, type AvailableModel } from '../../models/listModels.js';
import { ModelRouter } from '../../models/router.js';
import type { ProviderSecrets } from '../../models/providers/index.js';
import type { Check, CheckResult, DoctorContext } from '../types.js';

function providerSecrets(ctx: DoctorContext): ProviderSecrets {
  return {
    get: async (k) => (await ctx.secrets.get(k)).value,
    setting: (k) => ctx.env[k],
  };
}

const isPlaceholder = (s: string): boolean => /<[^<>]+>/.test(s);

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

  // Real model ids the Google key can use (read-only list call).
  let google: AvailableModel[] | undefined;
  const usesGoogle =
    Object.values(cfg.roles).some((r) => r.provider === 'google' || r.fallback?.provider === 'google') ||
    cfg.embeddings.provider === 'google';
  if (usesGoogle && !ctx.options.offline) {
    try {
      google = await listAvailableModels('google', secrets, 15_000, ctx.deps.fetch);
      details.push(`Google: key accepted, ${google.length} models available to it`);
    } catch (err) {
      details.push(`Google list-models failed: ${err instanceof Error ? err.message : String(err)}`);
      bump('red');
    }
  }
  const available = new Set(google?.map((m) => m.id));

  for (const s of router.status()) {
    const label = `${s.role}: ${s.provider}/${s.model}`;
    if (!s.ok) {
      const unconfigured = isPlaceholder(s.model);
      details.push(`${label} → ${unconfigured ? 'placeholder (not configured)' : (s.error ?? 'error')}`);
      bump(unconfigured ? 'yellow' : 'red');
    } else if (s.provider === 'google' && google && !available.has(s.model)) {
      details.push(`${label} → model id not available to this key`);
      bump('red');
    } else {
      details.push(`${label} → ready`);
    }
    if (s.fallback) {
      const fb = `  fallback ${s.fallback.provider}/${s.fallback.model}`;
      details.push(
        s.fallback.ok
          ? `${fb} → ready`
          : `${fb} → ${isPlaceholder(s.fallback.model) ? 'placeholder' : (s.fallback.error ?? 'error')}`,
      );
      if (!s.fallback.ok) bump(isPlaceholder(s.fallback.model) ? 'yellow' : 'red');
    }
  }
  const emb = cfg.embeddings;
  if (isPlaceholder(emb.model)) {
    details.push(`embeddings: ${emb.provider}/${emb.model} → placeholder (not configured)`);
    bump('yellow');
  } else if (emb.provider === 'google' && google && !available.has(emb.model)) {
    details.push(`embeddings: ${emb.provider}/${emb.model} → model id not available to this key`);
    bump('red');
  } else {
    details.push(`embeddings: ${emb.provider}/${emb.model} → configured`);
  }

  let fix: string | undefined;
  if (google) {
    const sug = suggestGeminiModels(google);
    const line = [...MODEL_ROLES, 'embeddings' as const].map((r) => `${r}=${sug[r] ?? '?'}`).join(', ');
    details.push(
      `Suggested from models listed for your key (listed is not proof a model can be called; confirm, then run qa doctor --live): ${line}`,
    );
    if (sug.newerPreview) {
      const p = Object.entries(sug.newerPreview)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      details.push(`Newer preview models also available (not GA): ${p}`);
    }
    if (status !== 'green') fix = 'set the model ids in config/models.yaml (suggestions above), then re-run qa doctor';
  } else if (status !== 'green') {
    fix = 'fill model ids in config/models.yaml';
  }

  let liveFailures = 0;
  if (ctx.options.live && !ctx.options.offline) {
    for (const role of MODEL_ROLES) {
      const s = router.status().find((x) => x.role === role);
      if (!s?.ok) continue;
      try {
        const out = await router.get(role).invoke([new HumanMessage('Reply with the single word OK.')]);
        const text = typeof out.content === 'string' ? out.content : JSON.stringify(out.content);
        details.push(`live ${role}: answered "${text.trim().slice(0, 20)}"`);
      } catch (err) {
        const msg = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ');
        details.push(`live ${role}: FAILED ${msg.length > 400 ? `${msg.slice(0, 400)}…` : msg}`);
        liveFailures++;
        bump('red');
      }
    }
    details.push(`live calls used ${router.totalTokens()} tokens`);
  }

  const notReady = router.status().filter((s) => !s.ok).length;
  return {
    ...base,
    status,
    summary:
      status === 'green'
        ? ctx.options.live && !ctx.options.offline
          ? `all ${MODEL_ROLES.length} roles answered a live call`
          : `all ${MODEL_ROLES.length} roles configured and listed for the key (not called; run qa doctor --live to verify)`
        : liveFailures
          ? `${liveFailures} role(s) failed a live call`
          : notReady
            ? `${notReady} of ${MODEL_ROLES.length} roles not configured`
            : 'configuration problem (see details)',
    details,
    ...(fix ? { fix } : {}),
  };
};
