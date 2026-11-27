// `qa visual run` / `approve` contract on a temp project (path with spaces) against the offline fixture (FIXTURE).
// Playwright is injected (a fake JSON report with attachments): this tests preflight, candidate building, the
// approval checkpoint, baseline storage and trust — the real browser run is the demo's job.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTempProject, REPO_ROOT } from '../../tests/helpers/tempProject.js';
import { snapshotName, VISUAL_REGIONS } from '../core/schemas/visual.js';
import { startFixtureServer, type FixtureServer } from '../fixture/server.js';
import { SnapshotStore } from '../knowledge/snapshotStore.js';
import { ApprovalStore } from '../security/approvals.js';
import { createSfContext } from '../sf/context.js';
import { runDiscovery } from '../sf/discovery/index.js';
import type { Runner } from '../util/exec.js';
import { approveBaselines, VISUAL_BASELINE_CHECKPOINT } from './approve.js';
import { baselineFolder, loadBaselines } from './baselines.js';
import { renderVisualDiffMd } from './report.js';
import { runVisual } from './run.js';

let server: FixtureServer;
let root: string;
let org: Awaited<ReturnType<typeof createSfContext>>['org'];
const say = (): void => undefined;
const VIEWPORTS = ['desktop', 'tablet'];

interface FakeOpts {
  /** names whose screenshot failed against an existing baseline */
  diff?: string[];
  /** no baselines yet: every region reports a missing snapshot */
  missing?: boolean;
  /** byte content of each region image */
  pixel?: string;
  /** the regions test failed before any capture */
  crash?: boolean;
  /** layout findings: a Salesforce-owned load-time shift (account-record) and one in our own component (contact-details) */
  layout?: boolean;
}

const fakeSpawn =
  (o: FakeOpts, calls: Record<string, string>[]): Runner =>
  (_cmd, _args, opts) => {
    const env = opts?.env ?? {};
    calls.push(env);
    const runDir = env['QA_RUN_DIR'] ?? '';
    const out = join(runDir, 'test-results');
    mkdirSync(out, { recursive: true });
    const file = (name: string, content: string): string => {
      const f = join(out, name);
      writeFileSync(f, content);
      return f;
    };
    const tests = VIEWPORTS.map((vp) => {
      const attachments: { name: string; path?: string; body?: string; contentType: string }[] = [];
      const errors: { message: string }[] = [];
      if (!o.crash) {
        for (const region of VISUAL_REGIONS) {
          const name = snapshotName(region, 'system-admin', vp);
          const img = `${o.pixel ?? 'px'}-${name}`;
          attachments.push({
            name: `visual-layout-${region}.json`,
            body: Buffer.from(
              JSON.stringify({ region, name, findings: o.layout ? fakeFindings(region, vp) : [] }),
            ).toString('base64'),
            contentType: 'application/json',
          });
          attachments.push({
            name: `visual-shot-${name}.png`,
            path: file(`shot-${name}.png`, img),
            contentType: 'image/png',
          });
          if (o.missing) {
            // as Playwright with updateSnapshots 'none': no -actual attachment, only the error
            errors.push({ message: `A snapshot doesn't exist at ${name}.png, writing actual.` });
          } else if (o.diff?.includes(name)) {
            attachments.push({
              name: `${name}-expected.png`,
              path: file(`${name}-expected.png`, 'old'),
              contentType: 'image/png',
            });
            attachments.push({
              name: `${name}-actual.png`,
              path: file(`${name}-actual.png`, `${img}-new`),
              contentType: 'image/png',
            });
            attachments.push({
              name: `${name}-diff.png`,
              path: file(`${name}-diff.png`, 'diff'),
              contentType: 'image/png',
            });
            errors.push({
              message: `expect(locator).toHaveScreenshot(expected) failed\n\n  5210 pixels (ratio 0.03 of all image pixels) are different.\n\n  Snapshot: ${name}.png`,
            });
          }
        }
      } else errors.push({ message: 'TimeoutError: locator.click: Timeout 20000ms exceeded.' });
      return {
        projectName: `visual-system-admin-${vp}`,
        results: [{ status: errors.length ? 'failed' : 'passed', errors, attachments }],
      };
    });
    const a11yTests = VIEWPORTS.map((vp) => ({
      projectName: `visual-system-admin-${vp}`,
      results: [
        {
          status: 'passed',
          errors: [],
          attachments: [
            {
              name: 'visual-a11y-new-contact-dialog.json',
              contentType: 'application/json',
              body: Buffer.from(
                JSON.stringify({
                  region: 'new-contact-dialog',
                  viewport: vp,
                  failing: [],
                  baseline: [{ ruleId: 'color-contrast', impact: 'serious', targets: 2, help: 'contrast' }],
                  unnamed: [],
                  tabOrder: { inOrder: true, missing: [], leftScope: false },
                }),
              ).toString('base64'),
            },
          ],
        },
      ],
    }));
    writeFileSync(
      join(runDir, 'playwright-results.json'),
      JSON.stringify({
        suites: [
          {
            title: 'regions.spec.ts',
            specs: [{ title: 'VIS-001 Account record page, Contact Details panel and New Contact dialog', tests }],
          },
          { title: 'a11y.spec.ts', specs: [{ title: 'A11Y-001 Account record page', tests: a11yTests }] },
        ],
      }),
    );
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };

const deps = (spawn: Runner) => ({
  spawn,
  probe: () => Promise.resolve({ ok: true }),
  ensureSession: () => Promise.resolve({ landedHost: '127.0.0.1', reused: true }),
});

function fakeFindings(region: string, viewport: string): Record<string, unknown>[] {
  const base = { region, viewport, fieldOverlap: false };
  if (region === 'account-record')
    return [
      { ...base, kind: 'layout-shift', detail: 'cumulative layout shift 0.9 > 0.1', value: 0.9, owner: 'salesforce' },
    ];
  if (region === 'contact-details')
    return [{ ...base, kind: 'clipped-text', elements: ['Our Label'], detail: '"Our Label" cut off', owner: 'ours' }];
  return [];
}

const run = (runId: string, o: FakeOpts, calls: Record<string, string>[] = [], autonomy: 'L2' | 'L3' = 'L3') =>
  runVisual({ root, runId, orgAlias: 'fixture', autonomy, say, echo: false }, deps(fakeSpawn(o, calls)));

const approve = (runId: string, extra: { only?: string[]; a11y?: boolean; layout?: boolean } = {}) =>
  approveBaselines({
    root,
    runId,
    org,
    baselineDir: 'tests/visual-baselines',
    approvedBy: 'QA Operator',
    approvalsFile: join(root, '.qa-memory', 'approvals.jsonl'),
    ...extra,
  });

beforeAll(async () => {
  server = await startFixtureServer({ fixtureDir: join(REPO_ROOT, 'examples', 'fixture'), port: 0 });
  root = makeTempProject();
  const orgsFile = join(root, 'config', 'orgs.yaml');
  writeFileSync(orgsFile, readFileSync(orgsFile, 'utf8').replace('http://127.0.0.1:4545', server.url));
  // tablet is deferred in the example config; the runner is still tested with two viewports (switched back on)
  const execFile = join(root, 'config', 'execution.yaml');
  writeFileSync(
    execFile,
    readFileSync(execFile, 'utf8').replace(/^ {2}viewports: \[desktop\]/m, '  viewports: [desktop, tablet]'),
  );
  cpSync(join(REPO_ROOT, 'examples', 'recipes'), join(root, 'examples', 'recipes'), { recursive: true });
  const ctx = await createSfContext({ root, runId: 'snap-setup', orgAlias: 'fixture' });
  org = ctx.org;
  const sf = await ctx.connect();
  const discovery = await runDiscovery({
    sf,
    environment: 'FIXTURE',
    orgId: ctx.org.orgId,
    apiVersion: '62.0',
    objects: ['Account', 'Contact'],
  });
  const store = new SnapshotStore(join(root, '.qa-memory', 'knowledge.db'));
  store.save({ discovery, orgAlias: 'fixture', release: 'fixture' });
  store.close();
});
afterAll(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

describe('qa visual run / approve on the offline fixture (FIXTURE)', () => {
  it('a new recipe version without approval at L2 → BLOCKED; Playwright never starts', async () => {
    const calls: Record<string, string>[] = [];
    const out = await run('vis-blocked', {}, calls, 'L2');
    expect(out.status).toBe('BLOCKED');
    expect(out.blockedReason).toMatch(/account-contact: not approved for fixture/);
    expect(calls).toEqual([]);
  });

  it('first run: every region is NO_BASELINE, a Salesforce-owned a11y rule is NEW_STANDARD; env contract set', async () => {
    const calls: Record<string, string>[] = [];
    const out = await run('vis-1', { missing: true }, calls);
    expect(calls[0]).toMatchObject({
      QA_ORG: 'fixture',
      QA_ENVIRONMENT: 'FIXTURE',
      QA_VISUAL_VIEWPORTS: 'desktop,tablet',
      QA_VISUAL_PERSONAS: 'system-admin',
    });
    const s = out.summary;
    expect(s?.environment).toBe('FIXTURE');
    expect(s?.release).toBe('FIXTURE');
    expect(s?.candidates.map((c) => c.status)).toEqual(Array(6).fill('NO_BASELINE'));
    expect(s?.a11y.map((f) => f.status)).toEqual(['NEW_STANDARD', 'NEW_STANDARD']);
    expect(s?.counts).toMatchObject({ match: 0, candidates: 6, a11yNewStandard: 2 });
    expect(out.status).toBe('COMPLETE');
    expect(existsSync(join(root, 'runs', 'vis-1', s?.candidates[0]?.images.actual ?? 'x'))).toBe(true);
    const md = renderVisualDiffMd(s ?? (undefined as never));
    expect(md).toContain('FIXTURE — offline fixture, NOT a Salesforce result');
    expect(md).toContain('pnpm qa visual approve --run vis-1');
    expect(md).not.toMatch(/defect found/i);
  });

  it('approve stores the images with sha256 + release, records the checkpoint and audit; the next run matches', async () => {
    const r = approve('vis-1', { a11y: true });
    expect(r.approved).toHaveLength(6);
    expect(r.approval?.checkpoint).toBe(VISUAL_BASELINE_CHECKPOINT);
    expect(r.a11yAccepted.map((a) => a.ruleIds)).toEqual([['color-contrast'], ['color-contrast']]);
    const m = loadBaselines(baselineFolder(root, 'tests/visual-baselines', 'fixture'), org);
    expect(m.baselines.every((b) => b.release === 'FIXTURE' && b.approvalId === r.approval?.id)).toBe(true);
    expect(new ApprovalStore(join(root, '.qa-memory', 'approvals.jsonl')).all().at(-1)?.subject).toMatch(
      /^visual:fixture:/,
    );
    const audit = readFileSync(join(root, 'runs', 'vis-1', 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(audit.filter((l) => l.includes('"VisualBaseline"'))).toHaveLength(6);

    const out = await run('vis-2', {});
    expect(out.summary?.candidates.map((c) => c.status)).toEqual(Array(6).fill('MATCH'));
    expect(out.summary?.a11y.map((f) => f.status)).toEqual(['BASELINE', 'BASELINE']);
    expect(approve('vis-2').approval).toBeUndefined(); // nothing to approve
  });

  it('a changed region is a DIFF candidate with the pixel ratio; approving it clears it', async () => {
    const name = snapshotName('contact-details', 'system-admin', 'desktop');
    const out = await run('vis-3', { diff: [name] });
    const c = out.summary?.candidates.find((x) => x.name === name);
    expect(c).toMatchObject({ status: 'DIFF', diffPixels: 5210, diffPixelRatio: 0.03 });
    expect(c?.images.diff).toBeDefined();
    expect(out.summary?.counts).toMatchObject({ match: 5, candidates: 1 });
    expect(() => approve('vis-3', { only: ['nope'] })).toThrow(/not in run vis-3: nope/);
    expect(approve('vis-3').approved.map((b) => b.name)).toEqual([name]);
    const after = await run('vis-4', { pixel: 'px' });
    // Playwright reports a match; the baseline is the approved run-3 image, untouched → MATCH
    expect(after.summary?.candidates.find((x) => x.name === name)?.status).toBe('MATCH');
  });

  it('an edited baseline file or another release is RE_APPROVE; a crashed test is NOT_CAPTURED', async () => {
    const folder = baselineFolder(root, 'tests/visual-baselines', 'fixture');
    const name = snapshotName('account-record', 'system-admin', 'tablet');
    writeFileSync(join(folder, `${name}.png`), 'edited by hand');
    const out = await run('vis-5', {});
    const c = out.summary?.candidates.find((x) => x.name === name);
    expect(c?.status).toBe('RE_APPROVE');
    expect(c?.reason).toMatch(/hash differs/);
    const crashed = await run('vis-6', { crash: true });
    expect(crashed.summary?.candidates.every((x) => x.status === 'NOT_CAPTURED')).toBe(true);
    expect(crashed.status).toBe('PARTIAL');
  });

  it('a tampered actual image is never approved', async () => {
    await run('vis-7', { missing: true, pixel: 'new' });
    const s = JSON.parse(readFileSync(join(root, 'runs', 'vis-7', 'visual', 'visual-summary.json'), 'utf8')) as {
      candidates: { images: { actual: string } }[];
    };
    writeFileSync(join(root, 'runs', 'vis-7', s.candidates[0]?.images.actual ?? ''), 'swapped');
    const r = approve('vis-7');
    expect(r.skipped[0]?.reason).toMatch(/hash differs/);
    expect(r.approved).toHaveLength(5);
  });

  it('layout: ours fails, Salesforce-owned is NEW_STANDARD until accepted with --layout, then BASELINE', async () => {
    const first = await run('vis-8', { layout: true });
    const st = (region: string): (string | undefined)[] =>
      first.summary?.layout.filter((f) => f.region === region).map((f) => f.status) ?? [];
    expect(st('account-record')).toEqual(['NEW_STANDARD', 'NEW_STANDARD']);
    expect(st('contact-details')).toEqual(['FAIL', 'FAIL']);
    expect(first.summary?.counts).toMatchObject({ layout: 4, layoutFail: 2, layoutNewStandard: 2 });
    expect(renderVisualDiffMd(first.summary ?? (undefined as never))).toContain('| NEW_STANDARD | salesforce |');

    const r = approve('vis-8', { layout: true });
    expect(r.layoutAccepted.map((e) => e.keys)).toEqual([['layout-shift:'], ['layout-shift:']]);
    const audit = readFileSync(join(root, 'runs', 'vis-8', 'audit.jsonl'), 'utf8');
    expect(audit.match(/"LayoutBaseline"/g)).toHaveLength(2);

    const next = await run('vis-9', { layout: true });
    expect(next.summary?.layout.map((f) => f.status).sort()).toEqual(['BASELINE', 'BASELINE', 'FAIL', 'FAIL']);
  });
});
