// Runner preflight + execution contract on a temp project (path with spaces) against the offline fixture (FIXTURE).
// Playwright and the browser are injected: no test is really executed here (that is the demo's job).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTempProject, REPO_ROOT } from '../../tests/helpers/tempProject.js';
import { HardStopError } from '../core/errors.js';
import { startFixtureServer, type FixtureServer } from '../fixture/server.js';
import { SnapshotStore } from '../knowledge/snapshotStore.js';
import { createSfContext } from '../sf/context.js';
import { runDiscovery } from '../sf/discovery/index.js';
import type { Runner } from '../util/exec.js';
import { executeStory, planStoryExecution } from './execute.js';

let server: FixtureServer;
let root: string;
const SPEC = 'tests/generated/SF-9/TC-SF-9-001-create-contact.spec.ts';

function manifest(over: Record<string, unknown> = {}): void {
  const art = {
    kind: 'spec',
    path: SPEC,
    hash: 'h1',
    testCaseIds: ['TC-SF-9-001'],
    dataBindings: ['account-contact'],
    origin: 'generated',
    reviewStatus: 'APPROVED',
    reviewReasons: [],
    dependsOn: [],
    ...over,
  };
  writeFileSync(
    join(root, 'tests', 'generated', 'SF-9', 'manifest.json'),
    JSON.stringify({ storyKey: 'SF-9', artifacts: [art], manualOnly: [{ caseId: 'TC-SF-9-002', reason: 'human' }] }),
  );
}

const pwReport = (status: 'expected' | 'unexpected') => ({
  suites: [
    {
      title: 'SF-9',
      file: 'SF-9/TC-SF-9-001-create-contact.spec.ts',
      specs: [
        {
          id: 'pw-1',
          title: 'TC-SF-9-001 create contact',
          file: 'SF-9/TC-SF-9-001-create-contact.spec.ts',
          tests: [
            {
              projectName: 'system-admin',
              status,
              annotations: [],
              results: [{ status: status === 'expected' ? 'passed' : 'failed', duration: 5, retry: 0, errors: [] }],
            },
          ],
        },
      ],
    },
  ],
});

const fakeSpawn =
  (status: 'expected' | 'unexpected', calls: { args: readonly string[]; env: Record<string, string> }[]): Runner =>
  (_cmd, args, opts) => {
    const env = opts?.env ?? {};
    calls.push({ args, env });
    mkdirSync(env['QA_RUN_DIR'] ?? '', { recursive: true });
    writeFileSync(join(env['QA_RUN_DIR'] ?? '', 'playwright-results.json'), JSON.stringify(pwReport(status)));
    return Promise.resolve({ code: status === 'expected' ? 0 : 1, stdout: '', stderr: '' });
  };

const deps = (spawn: Runner) => ({
  spawn,
  probe: () => Promise.resolve({ ok: true }),
  ensureSession: () => Promise.resolve({ landedHost: '127.0.0.1', reused: true }),
});

beforeAll(async () => {
  server = await startFixtureServer({ fixtureDir: join(REPO_ROOT, 'examples', 'fixture'), port: 0 });
  root = makeTempProject();
  const orgsFile = join(root, 'config', 'orgs.yaml');
  writeFileSync(orgsFile, readFileSync(orgsFile, 'utf8').replace('http://127.0.0.1:4545', server.url));
  cpSync(join(REPO_ROOT, 'examples', 'recipes'), join(root, 'examples', 'recipes'), { recursive: true });
  mkdirSync(join(root, 'tests', 'generated', 'SF-9'), { recursive: true });
  writeFileSync(
    join(root, SPEC),
    "test('TC-SF-9-001', { tag: ['@functional', '@persona:system-admin'] }, () => {});\n",
  );
  // A snapshot of the fixture org (the gate and the data plan read it).
  const ctx = await createSfContext({ root, runId: 'snap-setup', orgAlias: 'fixture' });
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

describe('Runner (qa run) preflight and execution on the offline fixture', () => {
  const say = (): void => undefined;

  it('a new recipe version without approval at L2 → BLOCKED before any test; Playwright never starts', async () => {
    manifest();
    const calls: { args: readonly string[]; env: Record<string, string> }[] = [];
    const out = await executeStory(
      { root, runId: 'run-x-unapproved', storyKey: 'SF-9', orgAlias: 'fixture', autonomy: 'L2', say },
      deps(fakeSpawn('expected', calls)),
    );
    expect(out.status).toBe('BLOCKED');
    expect(out.blockedReason).toMatch(/account-contact: not approved for fixture — .*qa data approve/);
    expect(calls).toEqual([]);
    expect(out.results.find((r) => r.caseId === 'TC-SF-9-001')).toMatchObject({
      state: 'BLOCKED',
      environment: 'FIXTURE',
    });
    expect(out.results.find((r) => r.caseId === 'TC-SF-9-002')).toMatchObject({ state: 'SKIPPED' });
  });

  it('executes approved specs with the run env contract; results.json holds TestResult[] labelled FIXTURE', async () => {
    manifest();
    const calls: { args: readonly string[]; env: Record<string, string> }[] = [];
    const out = await executeStory(
      {
        root,
        runId: 'run-x-ok',
        storyKey: 'SF-9',
        orgAlias: 'fixture',
        autonomy: 'L3',
        browser: 'chrome',
        say,
        echo: false,
      },
      deps(fakeSpawn('expected', calls)),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      'playwright',
      'test',
      'TC-SF-9-001-create-contact.spec.ts',
      '--project',
      'system-admin',
    ]);
    expect(calls[0]?.env).toMatchObject({
      QA_ORG: 'fixture',
      QA_RUN_ID: 'run-x-ok',
      QA_STORY_KEY: 'SF-9',
      QA_BROWSER: 'chrome',
      QA_AUTONOMY: 'L3',
      SF_BASE_URL: server.url,
    });
    expect(calls[0]?.env['QA_RUN_DIR']).toBe(join(root, 'runs', 'run-x-ok'));
    expect(out.status).toBe('COMPLETE');
    expect(out.summary).toMatchObject({ environment: 'FIXTURE', browser: 'chrome', cleanup: 'NONE' });
    expect(out.summary.executed.PASS).toBe(1);
    const saved = JSON.parse(readFileSync(join(root, 'runs', 'run-x-ok', 'results.json'), 'utf8')) as unknown[];
    expect(saved).toEqual(out.results);
    expect(out.results.every((r) => r.environment === 'FIXTURE')).toBe(true);
  });

  it('a stale spec is BLOCKED by the gate and nothing is executed', async () => {
    manifest({ stale: { components: ['ValidationRule:Contact.X changed'], snapshotId: 's2', markedAt: 'now' } });
    const calls: { args: readonly string[]; env: Record<string, string> }[] = [];
    const out = await executeStory(
      { root, runId: 'run-x-stale', storyKey: 'SF-9', orgAlias: 'fixture', autonomy: 'L3', say },
      deps(fakeSpawn('expected', calls)),
    );
    expect(calls).toEqual([]);
    expect(out.results.find((r) => r.caseId === 'TC-SF-9-001')).toMatchObject({ state: 'BLOCKED' });
    expect(out.results.find((r) => r.caseId === 'TC-SF-9-001')?.reason).toMatch(/^stale: /);
  });

  it('specs built for another org: staleness is not re-checked against this org and the manifest is not modified', async () => {
    manifest({ dependsOn: [{ component: 'ValidationRule:Contact.Phone_Must_Be_10_Digits', hash: 'qa-prod-hash' }] });
    const file = join(root, 'tests', 'generated', 'SF-9', 'manifest.json');
    const m = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...m, org: 'qa-prod' }));
    const before = readFileSync(file, 'utf8');
    const plan = await planStoryExecution(root, 'fixture', 'SF-9');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(plan.items.find((i) => i.caseId === 'TC-SF-9-001')?.decision).toBe('EXECUTE');
    expect(plan.stalenessNote).toMatch(/built for qa-prod/);
    // the build org itself still re-checks (fixture as build org: the qa-prod hash differs → STALE)
    writeFileSync(file, JSON.stringify({ ...m, org: 'fixture' }));
    const own = await planStoryExecution(root, 'fixture', 'SF-9');
    expect(own.items.find((i) => i.caseId === 'TC-SF-9-001')?.decision).toBe('BLOCKED');
  });

  it('an identity mismatch is a hard stop (the run ends BLOCKED, nothing executes)', async () => {
    manifest();
    const calls: { args: readonly string[]; env: Record<string, string> }[] = [];
    await expect(
      executeStory(
        { root, runId: 'run-x-identity', storyKey: 'SF-9', orgAlias: 'fixture', autonomy: 'L3', say },
        {
          ...deps(fakeSpawn('expected', calls)),
          createContext: async (o) => {
            const ctx = await createSfContext(o);
            return { ...ctx, connect: () => Promise.reject(new HardStopError('IDENTITY_MISMATCH', 'wrong org')) };
          },
        },
      ),
    ).rejects.toBeInstanceOf(HardStopError);
    expect(calls).toEqual([]);
  });

  it('refuses a run id too long for the run-tag field', async () => {
    await expect(
      executeStory({ root, runId: 'r'.repeat(41), storyKey: 'SF-9', orgAlias: 'fixture', say }),
    ).rejects.toThrow(/longer than 40/);
  });
});
