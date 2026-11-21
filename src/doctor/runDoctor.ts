import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnv, secretValues } from '../config/env.js';
import { loadAllConfig, type ProjectPaths } from '../config/loader.js';
import type { BrowserName } from '../config/schemas.js';
import type { Logger } from '../core/logger.js';
import { newRunId, runPaths } from '../core/runFolder.js';
import { ToolAllowList } from '../mcp/allowList.js';
import { McpHub } from '../mcp/client.js';
import { Redactor } from '../security/redact.js';
import { SecretStore } from '../security/secretStore.js';
import { run } from '../util/exec.js';
import { configCheck, secretsCheck } from './checks/config.js';
import { identityCheck } from './checks/identity.js';
import { mcpCheck } from './checks/mcp.js';
import { modelsCheck } from './checks/models.js';
import { browsersCheck, fixtureCheck, jiraCheck, skillsCheck, tracingCheck } from './checks/services.js';
import { nodeCheck, pnpmCheck, pythonCheck, salesforceCheck } from './checks/system.js';
import type { Check, CheckResult, DoctorContext, DoctorDeps, DoctorOptions } from './types.js';

export interface DoctorReport {
  generatedAt: string;
  root: string;
  options: DoctorOptions;
  counts: { green: number; yellow: number; red: number };
  results: CheckResult[];
  savedTo?: string;
}

/** Ordered list; `group` runs sequentially, items inside run in parallel. */
const CHECKS: { name: string; check: Check; timeoutMs: number }[] = [
  { name: 'node', check: nodeCheck, timeoutMs: 5_000 },
  { name: 'pnpm', check: pnpmCheck, timeoutMs: 20_000 },
  { name: 'config', check: configCheck, timeoutMs: 10_000 },
  { name: 'secrets', check: secretsCheck, timeoutMs: 15_000 },
  { name: 'skills', check: skillsCheck, timeoutMs: 10_000 },
  { name: 'browsers', check: browsersCheck, timeoutMs: 90_000 },
  { name: 'models', check: modelsCheck, timeoutMs: 300_000 }, // --live probes big hosted models
  { name: 'mcp', check: mcpCheck, timeoutMs: 240_000 },
  { name: 'jira', check: jiraCheck, timeoutMs: 20_000 },
  { name: 'salesforce', check: salesforceCheck, timeoutMs: 90_000 },
  { name: 'salesforce-identity', check: identityCheck, timeoutMs: 120_000 },
  { name: 'python', check: pythonCheck, timeoutMs: 40_000 },
  { name: 'tracing', check: tracingCheck, timeoutMs: 30_000 },
  { name: 'fixture', check: fixtureCheck, timeoutMs: 20_000 },
];

export async function defaultProbeBrowser(name: BrowserName): Promise<string | undefined> {
  try {
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({
      headless: true,
      timeout: 30_000,
      ...(name === 'chromium' ? {} : { channel: name }),
    });
    await browser.close();
    return undefined;
  } catch (err) {
    return (err instanceof Error ? err.message : String(err)).split('\n')[0];
  }
}

export function defaultDeps(ctx: { allowList: ToolAllowList; redactor: Redactor; logger: Logger }): DoctorDeps {
  return {
    run,
    fetch: globalThis.fetch.bind(globalThis),
    mcpHub: (servers) =>
      new McpHub({
        servers,
        allowList: ctx.allowList,
        redactor: ctx.redactor,
        logger: ctx.logger,
        connectTimeoutMs: 180_000, // first `npx -y` download can be slow
      }),
    probeBrowser: defaultProbeBrowser,
  };
}

async function withTimeout(
  name: string,
  ms: number,
  fn: () => Promise<CheckResult | CheckResult[]>,
): Promise<CheckResult[]> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const out = await Promise.race([
      fn(),
      new Promise<never>((_r, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`check timed out after ${ms} ms`));
        }, ms);
      }),
    ]);
    const list = Array.isArray(out) ? out : [out];
    return list.map((r) => ({ ...r, durationMs: r.durationMs ?? Date.now() - started }));
  } catch (err) {
    // A doctor check must never crash the doctor.
    return [
      {
        id: name,
        title: name,
        status: 'red',
        summary: `check failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - started,
      },
    ];
  } finally {
    clearTimeout(timer);
  }
}

export interface RunDoctorInput {
  paths: ProjectPaths;
  options: DoctorOptions;
  logger: Logger;
  deps?: Partial<DoctorDeps>;
  /** Only run these check names (tests). */
  only?: string[];
  onProgress?: (msg: string) => void;
  save?: boolean;
}

export async function runDoctor(input: RunDoctorInput): Promise<DoctorReport> {
  const env = await loadEnv(input.paths.root);
  const config = await loadAllConfig(input.paths);
  const secrets = new SecretStore(env);
  const redactor = new Redactor({ secrets: secretValues(env) });
  const allowList = new ToolAllowList(config['mcp-tools'].ok ? config['mcp-tools'].value : {});
  const deps: DoctorDeps = { ...defaultDeps({ allowList, redactor, logger: input.logger }), ...input.deps };
  const ctx: DoctorContext = {
    paths: input.paths,
    env,
    config,
    secrets,
    options: input.options,
    deps,
    logger: input.logger,
  };

  const selected = CHECKS.filter((c) => !input.only || input.only.includes(c.name));
  input.onProgress?.(
    `Running ${selected.length} checks (offline=${input.options.offline}, live=${input.options.live})…`,
  );
  const results = (
    await Promise.all(
      selected.map(async (c) => {
        const r = await withTimeout(c.name, c.timeoutMs, () => c.check(ctx));
        input.onProgress?.(`  done: ${c.name}`);
        return r;
      }),
    )
  ).flat();

  // Secrets never appear in doctor output, even inside error messages.
  const safe = results.map((r) => ({
    ...r,
    summary: redactor.redactSecrets(r.summary),
    ...(r.details ? { details: r.details.map((d) => redactor.redactSecrets(d)) } : {}),
  }));
  const counts = {
    green: safe.filter((r) => r.status === 'green').length,
    yellow: safe.filter((r) => r.status === 'yellow').length,
    red: safe.filter((r) => r.status === 'red').length,
  };
  const report: DoctorReport = {
    generatedAt: new Date().toISOString(),
    root: input.paths.root,
    options: input.options,
    counts,
    results: safe,
  };
  if (input.save !== false) {
    const p = runPaths(input.paths.root, newRunId('doctor'));
    await mkdir(p.dir, { recursive: true });
    const file = join(p.dir, 'doctor.json');
    report.savedTo = file;
    await writeFile(file, JSON.stringify(report, null, 2), 'utf8');
  }
  return report;
}

const TAG: Record<CheckResult['status'], string> = { green: '[ OK ]', yellow: '[WARN]', red: '[FAIL]' };

/** Plain-ASCII report (renders in Windows PowerShell 5 consoles too). */
export function formatReport(r: DoctorReport): string {
  const lines: string[] = [`qa doctor — sf-qa-agent environment check`, `root: ${r.root}`, ''];
  const width = Math.max(...r.results.map((x) => x.title.length), 10);
  for (const x of r.results) {
    lines.push(`${TAG[x.status]} ${x.title.padEnd(width)}  ${x.summary}`);
    for (const d of x.details ?? []) lines.push(`${' '.repeat(width + 9)}- ${d}`);
    if (x.fix && x.status !== 'green') lines.push(`${' '.repeat(width + 9)}fix: ${x.fix}`);
  }
  lines.push('');
  lines.push(
    `Summary: ${r.counts.green} OK, ${r.counts.yellow} WARN, ${r.counts.red} FAIL` +
      (r.counts.red
        ? ' — FAIL items must be fixed before a run.'
        : r.counts.yellow
          ? ' — WARN items have a fallback or are expected at this phase.'
          : ''),
  );
  if (r.savedTo) lines.push(`Saved: ${r.savedTo}`);
  return lines.join('\n');
}

export function exitCodeFor(r: DoctorReport): number {
  return r.counts.red > 0 ? 1 : 0;
}
