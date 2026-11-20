import { CONFIG_NAMES } from '../../config/loader.js';
import { PROVIDER_KEY } from '../../models/providers/index.js';
import type { EnvKey } from '../../config/env.js';
import type { Check, CheckResult } from '../types.js';

export const configCheck: Check = (ctx) => {
  const results: CheckResult[] = [];
  for (const name of CONFIG_NAMES) {
    const r = ctx.config[name];
    const base = { id: `config:${name}`, title: `config/${name}.yaml` };
    if (!r.ok) {
      results.push({ ...base, status: 'red', summary: r.reason, details: r.errors, fix: r.fix });
    } else if (r.unconfigured.length) {
      results.push({
        ...base,
        status: 'yellow',
        summary: `valid, ${r.unconfigured.length} placeholder value(s) still to fill in`,
        details: r.unconfigured.slice(0, 12).map((p) => `placeholder: ${p}`),
        fix: `edit ${r.file}`,
      });
    } else {
      results.push({ ...base, status: 'green', summary: 'valid' });
    }
  }
  return Promise.resolve(results);
};

export const secretsCheck: Check = async (ctx) => {
  const keyring = await ctx.secrets.keyringStatus();
  const wanted = new Set<EnvKey>(['JIRA_API_TOKEN', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY']);
  if (ctx.config.models.ok) {
    for (const r of Object.values(ctx.config.models.value.roles)) {
      const k = PROVIDER_KEY[r.provider];
      if (k) wanted.add(k);
    }
  }
  const details: string[] = [
    keyring.available
      ? 'Windows Credential Manager: available (service "sf-qa-agent")'
      : `Windows Credential Manager: unavailable (${keyring.error ?? '?'}) — using .env only`,
  ];
  const missing: string[] = [];
  for (const k of [...wanted].sort()) {
    const s = await ctx.secrets.get(k);
    details.push(`${k}: ${s.source === 'none' ? 'missing' : `set (${s.source})`}`);
    if (s.source === 'none') missing.push(k);
  }
  return {
    id: 'secrets',
    title: 'Secrets (keyring → .env)',
    status: missing.length ? 'yellow' : keyring.available ? 'green' : 'yellow',
    summary: missing.length ? `missing: ${missing.join(', ')}` : 'all required keys present (values never shown)',
    details,
    ...(missing.length
      ? { fix: 'add the missing keys to .env (or Windows Credential Manager, service sf-qa-agent)' }
      : {}),
  };
};
