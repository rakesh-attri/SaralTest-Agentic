import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Check, CheckResult } from '../types.js';

export const nodeCheck: Check = () => {
  const v = process.versions.node;
  const major = Number(v.split('.')[0]);
  const base = { id: 'node', title: 'Node.js' };
  if (major < 22) {
    return Promise.resolve({
      ...base,
      status: 'red',
      summary: `v${v} is too old (need >= 22 LTS)`,
      fix: 'winget install OpenJS.NodeJS.LTS',
    });
  }
  if (major % 2 === 1) {
    return Promise.resolve({
      ...base,
      status: 'yellow',
      summary: `v${v} is an odd (non-LTS) release`,
      fix: 'use an even-numbered LTS release (22, 24, 26…)',
    });
  }
  return Promise.resolve({ ...base, status: 'green', summary: `v${v} (even-numbered LTS line)` });
};

export const pnpmCheck: Check = async (ctx) => {
  const r = await ctx.deps.run('pnpm', ['--version'], { timeoutMs: 15_000 });
  if (r.code === 0) return { id: 'pnpm', title: 'pnpm', status: 'green', summary: `v${r.stdout.trim()}` };
  return {
    id: 'pnpm',
    title: 'pnpm',
    status: 'yellow',
    summary: `not found (${r.error ?? r.stderr.trim()})`,
    fix: 'npm install -g pnpm',
  };
};

export const pythonCheck: Check = async (ctx) => {
  const base = { id: 'python', title: 'Python sidecar (uv + 3.12)' };
  const uv = await ctx.deps.run('uv', ['--version'], { timeoutMs: 15_000 });
  if (uv.code !== 0) {
    return {
      ...base,
      status: 'yellow',
      summary: 'uv not found — DeepEval sidecar unavailable (needed from Phase 8)',
      fix: 'winget install astral-sh.uv',
    };
  }
  const py = await ctx.deps.run('uv', ['python', 'find', '3.12'], { timeoutMs: 20_000 });
  const evalDir = existsSync(join(ctx.paths.root, 'eval', 'pyproject.toml'));
  const details = [
    uv.stdout.trim(),
    evalDir
      ? 'eval/ project present'
      : 'eval/ project not built yet (Phase 8) — eval gates will degrade to UNEVALUATED',
  ];
  if (py.code !== 0) {
    return {
      ...base,
      status: 'yellow',
      summary: 'Python 3.12 not installed for uv',
      details,
      fix: 'uv python install 3.12',
    };
  }
  return { ...base, status: 'green', summary: `Python 3.12 at ${py.stdout.trim()}`, details };
};

const SfOrgList = z.looseObject({
  result: z.looseObject({}).catchall(z.unknown()),
});
const SfOrg = z.looseObject({
  alias: z.string().optional(),
  username: z.string().optional(),
  orgId: z.string().optional(),
  connectedStatus: z.string().optional(),
});

export const salesforceCheck: Check = async (ctx) => {
  const base = { id: 'salesforce', title: 'Salesforce CLI + org identity' };
  const ver = await ctx.deps.run('sf', ['--version'], { timeoutMs: 30_000 });
  if (ver.code !== 0) {
    return {
      ...base,
      status: 'red',
      summary: 'sf CLI not found',
      fix: 'npm install -g @salesforce/cli',
    };
  }
  const details: string[] = [ver.stdout.trim().split(/\r?\n/)[0] ?? 'sf'];
  let status: CheckResult['status'] = 'green';
  const fixes: string[] = [];

  const orgsCfg = ctx.config.orgs;
  if (!orgsCfg.ok) {
    return { ...base, status: 'red', summary: 'config/orgs.yaml invalid', details: orgsCfg.errors, fix: orgsCfg.fix };
  }
  const live = orgsCfg.value.orgs.filter((o) => o.environment === 'LIVE');

  // Authorized orgs on this machine. Only alias/username/orgId are read; the raw output (may hold tokens) is dropped.
  const known = new Map<string, z.infer<typeof SfOrg>>();
  if (!ctx.options.offline) {
    const list = await ctx.deps.run('sf', ['org', 'list', '--json'], { timeoutMs: 60_000 });
    try {
      const parsed = SfOrgList.parse(JSON.parse(list.stdout));
      for (const group of Object.values(parsed.result)) {
        if (!Array.isArray(group)) continue;
        for (const raw of group) {
          const o = SfOrg.safeParse(raw);
          if (o.success && o.data.alias) known.set(o.data.alias, o.data);
        }
      }
    } catch {
      details.push('could not read `sf org list --json`');
    }
  }

  for (const org of live) {
    const placeholder = /<[^<>]+>/.test(org.instanceUrl) || /^00D0{12}/.test(org.orgId);
    if (placeholder) {
      details.push(`${org.alias} (${org.profile}): not configured yet — placeholder org ID / instance URL`);
      status = status === 'red' ? 'red' : 'yellow';
      continue;
    }
    if (ctx.options.offline) {
      details.push(`${org.alias}: skipped (--offline)`);
      continue;
    }
    const authed = known.get(org.alias);
    if (!authed) {
      details.push(`${org.alias}: alias not authorized on this machine`);
      fixes.push(`sf org login jwt --client-id <ECA key> --jwt-key-file <key> --username <user> --alias ${org.alias}`);
      status = status === 'red' ? 'red' : 'yellow';
      continue;
    }
    const same = authed.orgId?.slice(0, 15) === org.orgId.slice(0, 15);
    if (!same) {
      details.push(`${org.alias}: org ID mismatch — config ${org.orgId}, sf ${authed.orgId ?? '?'} (would HARD_STOP)`);
      status = 'red';
    } else {
      details.push(
        `${org.alias}: authorized, org ID matches orgs.yaml (${authed.connectedStatus ?? 'status unknown'})`,
      );
    }
  }
  if (!ctx.env.SF_ECA_CLIENT_ID || !ctx.env.SF_JWT_KEY_PATH) {
    details.push('JWT via External Client App not configured (SF_ECA_CLIENT_ID / SF_JWT_KEY_PATH empty)');
    fixes.push('Create the External Client App and key: see docs/setup/salesforce-auth.md');
    status = status === 'red' ? 'red' : 'yellow';
  } else if (!existsSync(ctx.env.SF_JWT_KEY_PATH)) {
    details.push('SF_JWT_KEY_PATH is set but the key file does not exist (put .env comments on their own line)');
    status = status === 'red' ? 'red' : 'yellow';
  } else {
    details.push('JWT via External Client App configured (client id set, key file present)');
  }
  const fixture = orgsCfg.value.orgs.find((o) => o.environment === 'FIXTURE');
  if (fixture) details.push(`${fixture.alias}: offline fixture org (FIXTURE, never live evidence)`);

  return {
    ...base,
    status,
    summary:
      status === 'green'
        ? 'all live orgs authorized and matching'
        : status === 'red'
          ? 'identity mismatch — runs on that org would hard-stop'
          : 'live orgs not ready yet (see details)',
    details,
    ...(fixes.length || status !== 'green'
      ? {
          fix:
            fixes[0] ??
            'Fill orgs.yaml with real 18-char org IDs and authorize each alias with sf org login jwt (docs/setup/salesforce-auth.md)',
        }
      : {}),
  };
};
