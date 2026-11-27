// `qa visual run` (PLAN.md §7g, Phase 6): runs the visual + a11y suite (tests/visual/**, playwright.visual.config.ts)
// with the Playwright Test runner after the same preflight as `qa run` (identity → browser → persona sessions →
// recipe approval), then turns the Playwright JSON into candidates (src/visual/collect.ts), reconciles the run's
// test data and writes `runs/<id>/visual/visual-summary.json`. Baselines are never written here.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { QAError } from '../core/errors.js';
import { runPaths } from '../core/runFolder.js';
import { VISUAL_REGIONS, VisualRunSummary, type VisualRegion } from '../core/schemas/visual.js';
import type { Autonomy } from '../core/state.js';
import { MAX_RUN_ID } from '../runner/execute.js';
import { preflight, type PreflightDeps } from '../runner/preflight.js';
import { reconcileRun, type ReconcileReport } from '../runner/reconcile.js';
import { run as defaultSpawn, type Runner } from '../util/exec.js';
import { baselineFolder, loadBaselines } from './baselines.js';
import { collectVisual, VisualPlaywrightJson } from './collect.js';

type Say = (msg: string) => void;

/** The recipe the suite's tests create (one Account + Contact per test, tagged and cleaned up). */
export const VISUAL_RECIPES = ['account-contact'] as const;

export interface VisualRunOptions {
  root: string;
  runId: string;
  orgAlias: string;
  persona?: string;
  viewports?: readonly string[];
  browser?: string;
  autonomy?: Autonomy;
  say: Say;
  echo?: boolean;
  timeoutMs?: number;
}

export interface VisualRunOutcome {
  status: 'COMPLETE' | 'PARTIAL' | 'BLOCKED';
  blockedReason?: string;
  summary?: VisualRunSummary;
  reconcile?: ReconcileReport;
  summaryFile?: string;
}

export const visualSummaryFile = (runDir: string): string => join(runDir, 'visual', 'visual-summary.json');

export function loadVisualSummary(runDir: string): VisualRunSummary {
  const f = visualSummaryFile(runDir);
  if (!existsSync(f)) throw new QAError('DATA', `no visual summary in ${runDir}`, { fix: 'run qa visual run first' });
  return VisualRunSummary.parse(JSON.parse(readFileSync(f, 'utf8')));
}

export async function runVisual(
  o: VisualRunOptions,
  d: PreflightDeps & { spawn?: Runner } = {},
): Promise<VisualRunOutcome> {
  if (o.runId.length > MAX_RUN_ID)
    throw new QAError('DATA', `run id "${o.runId}" is longer than ${MAX_RUN_ID} characters`);
  const say = o.say;
  const startedAt = new Date().toISOString();
  const paths = runPaths(o.root, o.runId);
  mkdirSync(join(paths.dir, 'visual'), { recursive: true });
  mkdirSync(paths.logs, { recursive: true });
  const persona = o.persona ?? 'system-admin';

  const pre = await preflight(
    {
      root: o.root,
      runId: o.runId,
      orgAlias: o.orgAlias,
      personas: [persona],
      recipes: [...VISUAL_RECIPES],
      ...(o.browser ? { browser: o.browser } : {}),
      ...(o.autonomy ? { autonomy: o.autonomy } : {}),
      say,
    },
    d,
  );
  if (!pre.ok) return { status: 'BLOCKED', blockedReason: pre.why };
  const { ctx, sf, browser, baseURL, autonomy } = pre;
  const environment = ctx.org.environment;
  const release = environment === 'LIVE' ? (sf.identity.releaseLabel ?? ctx.org.release) : environment;
  const visual = ctx.execution.visual;
  const viewports = o.viewports?.length ? [...o.viewports] : visual.viewports;
  const unknown = viewports.filter((v) => !ctx.execution.viewports.some((x) => x.name === v));
  if (unknown.length) throw new QAError('DATA', `viewport(s) not in config/execution.yaml: ${unknown.join(', ')}`);
  const folder = baselineFolder(o.root, visual.baselineDir, o.orgAlias);
  const manifest = loadBaselines(folder, ctx.org);
  say(
    `Visual suite on ${o.orgAlias} (${environment}, release ${release}) as ${persona} · viewports ${viewports.join(', ')} · baselines ${folder} (${manifest.baselines.length} approved)`,
  );

  const args = ['playwright', 'test', '-c', 'playwright.visual.config.ts'];
  const env: Record<string, string> = {
    QA_ORG: o.orgAlias,
    QA_RUN_ID: o.runId,
    QA_RUN_DIR: paths.dir,
    QA_STORY_KEY: 'visual',
    QA_BROWSER: browser.browser,
    QA_AUTONOMY: autonomy,
    QA_ENVIRONMENT: environment,
    QA_VISUAL_PERSONAS: persona,
    QA_VISUAL_VIEWPORTS: viewports.join(','),
    SF_BASE_URL: baseURL,
  };
  appendFileSync(paths.runLog, `\n# npx ${args.join(' ')}\n`);
  const res = await (d.spawn ?? defaultSpawn)('npx', args, {
    cwd: o.root,
    env,
    timeoutMs: o.timeoutMs ?? 30 * 60_000,
    onOutput: (chunk) => {
      appendFileSync(paths.runLog, chunk);
      if (o.echo !== false) process.stdout.write(chunk);
    },
  });
  if (res.error) say(`Playwright process: ${res.error}`);

  say('Reconciling test data (every test sub-run, then a run-wide re-query) …');
  const reconcile = await reconcileRun({
    runId: o.runId,
    runDir: paths.dir,
    org: ctx.org,
    sf,
    window: { userId: sf.identity.userId, since: startedAt },
  });
  say(`  data: ${reconcile.status} — ${reconcile.subRuns.length} sub-run(s), ${reconcile.remaining.length} remaining`);

  const pwFile = join(paths.dir, 'playwright-results.json');
  if (!existsSync(pwFile)) {
    const why = `Playwright wrote no report (exit ${String(res.code)}${res.error ? `, ${res.error}` : ''})`;
    return { status: 'PARTIAL', blockedReason: why, reconcile };
  }
  const pw = VisualPlaywrightJson.parse(JSON.parse(readFileSync(pwFile, 'utf8')));
  const ratioFor = (r: VisualRegion): number => visual.regionRatio[r] ?? visual.maxDiffPixelRatio;
  const c = collectVisual({
    pw,
    runDir: paths.dir,
    folder,
    manifest,
    release,
    environment,
    regions: VISUAL_REGIONS,
    ratioFor,
  });
  const summary = VisualRunSummary.parse({
    runId: o.runId,
    org: o.orgAlias,
    orgId: ctx.org.orgId,
    environment,
    release,
    persona,
    viewports,
    browser: browser.browser,
    candidates: c.candidates,
    layout: c.layout,
    a11y: c.a11y,
    a11yChecks: c.a11yChecks,
    tests: c.tests.map((t) => ({
      title: `${t.title} [${t.project}]`,
      state: t.state,
      ...(t.error ? { error: t.error } : {}),
    })),
    counts: {
      match: c.candidates.filter((x) => x.status === 'MATCH').length,
      candidates: c.candidates.filter((x) => x.status !== 'MATCH').length,
      layout: c.layout.length,
      a11yFail: c.a11y.filter((x) => x.status === 'FAIL').length,
      a11yNewStandard: c.a11y.filter((x) => x.status === 'NEW_STANDARD').length,
    },
    createdAt: new Date().toISOString(),
  });
  const summaryFile = visualSummaryFile(paths.dir);
  writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  writeFileSync(
    join(paths.dir, 'visual', 'data-reconciliation.json'),
    `${JSON.stringify(reconcile, null, 2)}\n`,
    'utf8',
  );
  const expected = VISUAL_REGIONS.length * viewports.length;
  const status =
    c.candidates.length === expected &&
    reconcile.status !== 'INCOMPLETE' &&
    !c.candidates.some((x) => x.status === 'NOT_CAPTURED')
      ? 'COMPLETE'
      : 'PARTIAL';
  return { status, summary, reconcile, summaryFile };
}
