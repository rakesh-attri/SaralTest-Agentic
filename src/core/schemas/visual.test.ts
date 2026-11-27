import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ExecutionConfig, PolicyConfig } from '../../config/schemas.js';
import { checkpointRequired } from '../../security/approvals.js';
import { BaselineManifest, VisualCandidate, VisualRunSummary, snapshotName } from './visual.js';

const repo = join(import.meta.dirname, '..', '..', '..');
const sha = 'a'.repeat(64);

describe('visual contracts', () => {
  it('names a snapshot region-persona-viewport', () => {
    expect(snapshotName('contact-details', 'system-admin', 'tablet')).toBe('contact-details-system-admin-tablet');
  });

  it('accepts a baseline manifest and rejects a bad hash / approval id', () => {
    const base = {
      name: 'contact-details-system-admin-desktop',
      region: 'contact-details',
      persona: 'system-admin',
      viewport: 'desktop',
      sha256: sha,
      release: "Winter '27",
      approvedBy: 'Operator',
      approvalId: 'AP-0123456789ab',
      approvedAt: '2026-11-27T10:00:00.000Z',
      sourceRun: 'run-1',
    };
    const ok = BaselineManifest.parse({
      org: 'qa-prod',
      orgId: '00DdN00000uQ5dKUAS',
      environment: 'LIVE',
      baselines: [base],
    });
    expect(ok.a11y).toEqual([]);
    expect(() =>
      BaselineManifest.parse({
        org: 'qa-prod',
        orgId: '00DdN00000uQ5dKUAS',
        environment: 'LIVE',
        baselines: [{ ...base, sha256: 'x' }],
      }),
    ).toThrow();
    expect(() =>
      BaselineManifest.parse({
        org: 'qa-prod',
        orgId: '00DdN00000uQ5dKUAS',
        environment: 'LIVE',
        baselines: [{ ...base, approvalId: 'AP-1' }],
      }),
    ).toThrow();
  });

  it('rejects an unknown region or status on a candidate', () => {
    const c = {
      name: 'n',
      region: 'contact-details',
      persona: 'system-admin',
      viewport: 'desktop',
      status: 'DIFF',
      maxDiffPixelRatio: 0.01,
      images: {},
      reason: 'differs',
      environment: 'FIXTURE',
    };
    expect(VisualCandidate.parse(c).status).toBe('DIFF');
    expect(() => VisualCandidate.parse({ ...c, region: 'home' })).toThrow();
    expect(() => VisualCandidate.parse({ ...c, status: 'DEFECT' })).toThrow();
  });

  it('requires counts on a run summary', () => {
    expect(() =>
      VisualRunSummary.parse({
        runId: 'r',
        org: 'fixture',
        orgId: '00D000000000000AAA',
        environment: 'FIXTURE',
        release: 'FIXTURE',
        persona: 'system-admin',
        viewports: ['desktop'],
        browser: 'chromium',
        candidates: [],
        createdAt: '2026-11-27T10:00:00.000Z',
      }),
    ).toThrow();
  });
});

describe('visual config', () => {
  const example = parse(readFileSync(join(repo, 'config', 'execution.example.yaml'), 'utf8')) as Record<
    string,
    unknown
  >;

  it('example config selects desktop + one smaller viewport', () => {
    const c = ExecutionConfig.parse(example);
    expect(c.visual.viewports).toEqual(['desktop', 'tablet']);
    expect(c.visual.baselineDir).toBe('tests/visual-baselines');
  });

  it('rejects a visual viewport that is not defined', () => {
    const bad = structuredClone(example) as { visual: { viewports: string[] } };
    bad.visual.viewports = ['desktop', 'phone'];
    expect(() => ExecutionConfig.parse(bad)).toThrow(/viewport phone not defined/);
  });

  it('baseline approval waits for a human at every autonomy level', () => {
    const policy = PolicyConfig.parse(parse(readFileSync(join(repo, 'config', 'policy.yaml'), 'utf8')));
    for (const level of ['L1', 'L2', 'L3'] as const) {
      expect(checkpointRequired(policy, level, 'approve-visual-baseline')).toBe(true);
    }
  });
});
