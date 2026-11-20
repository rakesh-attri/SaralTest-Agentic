import { join } from 'node:path';
import { startFixtureServer } from '../../fixture/server.js';
import { checkLangfuse, initTracing } from '../../observability/tracing.js';
import { Redactor } from '../../security/redact.js';
import { SkillLoader } from '../../skills/skillLoader.js';
import type { BrowserName } from '../../config/schemas.js';
import type { Check, CheckResult } from '../types.js';

export const browsersCheck: Check = async (ctx) => {
  const base = { id: 'browsers', title: 'Playwright browsers' };
  const exec = ctx.config.execution;
  const wanted: BrowserName = exec.ok ? exec.value.browser : 'chromium';
  const fallback = exec.ok ? exec.value.fallbackBrowser : undefined;
  const all: BrowserName[] = ['chromium', 'chrome', 'msedge'];
  const outcome = new Map<BrowserName, string | undefined>();
  await Promise.all(all.map(async (b) => outcome.set(b, await ctx.deps.probeBrowser(b))));
  const details = all.map(
    (b) => `${b}: ${outcome.get(b) === undefined ? 'launches (headless)' : `unavailable — ${outcome.get(b) ?? ''}`}`,
  );
  details.push(`configured: browser=${wanted}${fallback ? `, fallback=${fallback}` : ''} (config/execution.yaml)`);
  if (outcome.get(wanted) === undefined) {
    return { ...base, status: 'green', summary: `${wanted} ready`, details };
  }
  if (fallback && outcome.get(fallback) === undefined) {
    return {
      ...base,
      status: 'yellow',
      summary: `${wanted} unavailable, fallback ${fallback} ready`,
      details,
      fix:
        wanted === 'chromium'
          ? 'pnpm exec playwright install chromium'
          : `install ${wanted} or switch config/execution.yaml`,
    };
  }
  return {
    ...base,
    status: 'red',
    summary: `${wanted} unavailable and no working fallback`,
    details,
    fix: 'pnpm exec playwright install chromium',
  };
};

export const jiraCheck: Check = async (ctx) => {
  const base = { id: 'jira', title: 'JIRA REST fallback' };
  const url = ctx.env.JIRA_BASE_URL;
  const email = ctx.env.JIRA_EMAIL;
  const token = (await ctx.secrets.get('JIRA_API_TOKEN')).value;
  if (!url || !email || !token) {
    return {
      ...base,
      status: 'yellow',
      summary: 'not configured (JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN)',
      fix: 'fill the JIRA_* entries in .env',
    };
  }
  if (ctx.options.offline) return { ...base, status: 'yellow', summary: 'skipped (--offline)' };
  try {
    const res = await ctx.deps.fetch(`${url.replace(/\/$/, '')}/rest/api/3/myself`, {
      headers: {
        authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { ...base, status: 'green', summary: `authenticated against ${new URL(url).host}` };
    return {
      ...base,
      status: 'yellow',
      summary: `${new URL(url).host} → HTTP ${res.status}`,
      fix:
        res.status === 401 || res.status === 403
          ? 'renew JIRA_API_TOKEN (id.atlassian.com → API tokens)'
          : 'check JIRA_BASE_URL',
    };
  } catch (err) {
    return { ...base, status: 'yellow', summary: `unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
};

export const tracingCheck: Check = async (ctx) => {
  const base = { id: 'tracing', title: 'Tracing (OpenTelemetry → Langfuse / Phoenix)' };
  const obs = ctx.config.observability;
  if (!obs.ok) return { ...base, status: 'red', summary: 'config/observability.yaml invalid', details: obs.errors };
  const tracing = await initTracing({
    config: obs.value,
    env: ctx.env,
    redactor: new Redactor(),
    instrumentLangChain: false,
  });
  const details = tracing.destinations.map((d) => `${d.name}: ${d.enabled ? 'on' : 'off'} — ${d.reason}`);
  await tracing.shutdown();
  let status: CheckResult['status'] = 'green';
  let summary = 'configured; exporter failures are warnings only';
  let fix: string | undefined;
  if (obs.value.exporters.langfuse.enabled) {
    if (ctx.options.offline) {
      details.push('Langfuse reachability: skipped (--offline)');
      status = 'yellow';
    } else {
      const lf = await checkLangfuse(ctx.env, 10_000, ctx.deps.fetch);
      details.push(`Langfuse reachability: ${lf.detail}`);
      if (!lf.ok) {
        status = 'yellow';
        summary = 'Langfuse not reachable — runs continue, traces are not exported';
        fix = 'check LANGFUSE_* in .env (keys from Langfuse → Project settings → API keys)';
      } else {
        summary = 'Langfuse reachable; redaction runs before export';
      }
    }
  }
  return { ...base, status, summary, details, ...(fix ? { fix } : {}) };
};

export const fixtureCheck: Check = async (ctx) => {
  const base = { id: 'fixture', title: 'Offline Salesforce fixture' };
  const fx = await startFixtureServer({ fixtureDir: join(ctx.paths.root, 'examples', 'fixture'), port: 0 });
  try {
    const res = await ctx.deps.fetch(
      `${fx.url}/services/data/v62.0/query?q=${encodeURIComponent('SELECT Id, IsSandbox FROM Organization')}`,
      { headers: { authorization: 'Bearer fixture-admin-token' } },
    );
    const body = (await res.json()) as { records?: { Id?: string }[] };
    const env = res.headers.get('x-qa-environment');
    if (res.ok && body.records?.[0]?.Id === '00DFIXTURE00000001' && env === 'FIXTURE') {
      return { ...base, status: 'green', summary: 'boots, answers SOQL, labels responses FIXTURE' };
    }
    return { ...base, status: 'red', summary: `unexpected answer (HTTP ${res.status}, label ${env ?? 'none'})` };
  } finally {
    await fx.close();
  }
};

export const skillsCheck: Check = async (ctx) => {
  const loader = SkillLoader.forProject(ctx.paths.root);
  const list = await loader.list();
  const r: CheckResult = {
    id: 'skills',
    title: 'Skills (.claude/skills)',
    status: list.length >= 15 ? 'green' : 'red',
    summary: `${list.length} skills parsed`,
    details: [list.map((s) => s.name).join(', ')],
  };
  return r;
};
