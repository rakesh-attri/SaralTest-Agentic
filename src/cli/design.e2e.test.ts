import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, makeTempProject } from '../../tests/helpers/tempProject.js';
import {
  clarifications,
  components,
  docs,
  findings,
  manualTests,
  requirements,
} from '../../tests/helpers/designFixtures.js';
import { SnapshotStore } from '../knowledge/snapshotStore.js';
import type { DiscoveredComponent } from '../sf/discovery/types.js';
import { TestCase } from '../core/schemas/index.js';

const QA = join(REPO_ROOT, 'bin', 'qa.mjs');
const root = makeTempProject();
const FIXTURE_ORG = '00DFIXTURE00000001';

function qa(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [QA, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 150_000,
    windowsHide: true,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeAll(() => {
  // a FIXTURE snapshot (synthetic components) and a finished analysis run, as qa discover / qa analyze would leave them
  const store = new SnapshotStore(join(root, '.qa-memory', 'knowledge.db'));
  const now = new Date().toISOString();
  store.save({
    discovery: {
      environment: 'FIXTURE',
      orgId: FIXTURE_ORG,
      apiVersion: '62.0',
      objects: ['Account', 'Contact'],
      components: components.map((c): DiscoveredComponent => ({
        type: c.type as DiscoveredComponent['type'],
        apiName: c.apiName,
        ...(c.label ? { label: c.label } : {}),
        ...(c.parent ? { parent: c.parent } : {}),
        body: c.body ?? {},
        evidenceStatus: 'DECLARED',
      })),
      dependencies: [],
      areas: [],
      startedAt: now,
      finishedAt: now,
    },
    orgAlias: 'fixture',
    release: 'fixture',
  });
  store.close();
  const dir = join(root, 'runs', 'run-e2e-seed', 'analysis');
  mkdirSync(join(dir, 'sources'), { recursive: true });
  writeFileSync(join(dir, 'requirements.json'), JSON.stringify(requirements));
  writeFileSync(join(dir, 'findings.json'), JSON.stringify(findings));
  writeFileSync(join(dir, 'clarifications.json'), JSON.stringify(clarifications));
  writeFileSync(join(dir, 'existing-tests.json'), JSON.stringify(manualTests));
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ runId: 'run-e2e-seed', storyKey: 'SF-219' }));
  for (const d of docs) writeFileSync(join(dir, 'sources', `${d.docId}.json`), JSON.stringify(d));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('qa design / qa review (paths with spaces, offline, FIXTURE)', () => {
  it('qa design --from-run … --org fixture --offline writes a reviewed, labelled design', () => {
    const r = qa([
      'design',
      '--from-run',
      'run-e2e-seed',
      '--org',
      'fixture',
      '--offline',
      '--run-id',
      'run-e2e-design',
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/Design inputs: snapshot snap-/);
    expect(r.stdout).toMatch(/\[mechanical: no model\]\s+\[FIXTURE org\]/);
    expect(r.stdout).toMatch(/\[x\] every AC covered: 5\/5/);
    expect(r.stdout).toMatch(/\[x\] every expectation evidence-labelled/);
    expect(r.stdout).toMatch(/\[x\] reviewer findings resolved or justified: .* 0 open/);
    const dir = join(root, 'runs', 'run-e2e-design', 'design');
    for (const f of ['test-plan.md', 'rtm.xlsx', 'test-design-report.html'])
      expect(existsSync(join(dir, f))).toBe(true);
    const cases = (JSON.parse(readFileSync(join(dir, 'test-cases.json'), 'utf8')) as unknown[]).map((c) =>
      TestCase.parse(c),
    );
    expect(cases.find((c) => c.persona === 'read-only')?.reviewStatus).toBe('BLOCKED');
  }, 160_000);

  it('qa review --run re-reviews an existing design', () => {
    const r = qa(['review', '--run', 'run-e2e-design', '--offline']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/0 open/);
    expect(existsSync(join(root, 'runs', 'run-e2e-design', 'design', 'review-recheck.json'))).toBe(true);
  }, 160_000);

  it('qa design explains a missing snapshot', () => {
    const r = qa([
      'design',
      '--from-run',
      'run-e2e-seed',
      '--org',
      'fixture',
      '--snapshot',
      'snap-nope',
      '--offline',
      '--run-id',
      'run-e2e-nosnap',
    ]);
    expect(r.stdout + r.stderr).toMatch(/no stored snapshot snap-nope for org fixture/);
    expect(r.stdout).toMatch(/PARTIAL/);
  }, 160_000);
});
