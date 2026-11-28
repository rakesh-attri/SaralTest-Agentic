import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { PolicyConfig } from '../../config/schemas.js';
import { checkpointRequired } from '../../security/approvals.js';
import { ExplorationCharter, ExplorationFinding } from './exploration.js';
import { DefectDraft, FaultScorecard, HealRepair, Investigation, ROUTE_OF, Verdict } from './investigation.js';

const repo = join(import.meta.dirname, '..', '..', '..');
const at = '2026-11-27T10:00:00.000Z';
const fp = { sha256: 'a'.repeat(64), count: 2, items: ['expect(x).toBe(1)', 'expect(y).toBe(2)'] };

describe('Phase 7 investigation contracts', () => {
  it('keeps Phase 0–6 investigations valid and defaults the new fields', () => {
    const old = Investigation.parse({
      failureId: 'F1',
      observations: [],
      hypotheses: [{ id: 'H1', text: 't', test: 'x', evidenceIds: [] }],
      verdict: 'UNKNOWN',
      confidence: 0.2,
      status: 'SUSPECTED',
    });
    expect(old.signals).toEqual([]);
    expect(old.experiments).toEqual([]);
    expect(old.evidenceIds).toEqual([]);
  });

  it('routes every verdict to an owner', () => {
    for (const v of Verdict.options) expect(ROUTE_OF[v]).toBeDefined();
    expect(ROUTE_OF.SCRIPT_LOCATOR).toBe('self-healer');
    expect(ROUTE_OF.PRODUCT_DEFECT).toBe('defect-judge');
  });

  it('keeps old defect drafts valid; a draft still needs evidence', () => {
    const base = {
      id: 'DEF-1',
      failureId: 'F1',
      title: '[Contact] deleted when it has open Cases for system-admin',
      stepsToReproduce: ['a'],
      expected: 'blocked',
      actual: 'deleted',
      evidenceIds: ['EV-1'],
      severity: 'MAJOR',
      published: false,
    };
    expect(DefectDraft.parse(base).reproductions).toEqual([]);
    expect(() => DefectDraft.parse({ ...base, evidenceIds: [] })).toThrow();
  });

  it('accepts a heal repair with fingerprints', () => {
    const r = HealRepair.parse({
      id: 'HR-1',
      runId: 'run-1',
      caseId: 'TC-1',
      specPath: 'tests/generated/X/a.spec.ts',
      failureId: 'F1',
      kind: 'locator',
      locatorBefore: {
        page: 'p',
        element: 'saveButton',
        persona: 'system-admin',
        expression: "getByRole('button', { name: 'Save' })",
      },
      locatorAfter: {
        page: 'p',
        element: 'saveButton',
        persona: 'system-admin',
        expression: "getByRole('button', { name: 'Save Record' })",
      },
      fingerprintBefore: fp,
      fingerprintAfter: fp,
      assertionsUnchanged: true,
      behaviourChanging: false,
      reason: 'label renamed',
      status: 'PROPOSED',
      environment: 'FIXTURE',
      createdAt: at,
    });
    expect(r.attempt).toBe(1);
  });

  it('scorecard schema', () => {
    const s = FaultScorecard.parse({
      suiteId: 'fixture',
      runId: 'r',
      environment: 'FIXTURE',
      total: 1,
      correct: 1,
      outcomes: [
        {
          faultId: 'F1',
          expectedVerdict: 'ENVIRONMENT',
          actualVerdict: 'ENVIRONMENT',
          correct: true,
          confidence: 0.9,
          runId: 'r-F1',
          testState: 'FAIL',
        },
      ],
      assertionChanges: 0,
      passed: true,
      createdAt: at,
    });
    expect(s.passed).toBe(true);
  });

  it('exploration findings need evidence; charters carry limits', () => {
    const c = ExplorationCharter.parse({
      id: 'CH-1',
      area: 'contact-create',
      persona: 'system-admin',
      resources: 'New Contact dialog',
      risk: 'rules not enforced',
      mission: 'Explore contact-create as system-admin …',
      timeBoxMin: 10,
      maxSteps: 60,
      maxSaves: 5,
      saturationSteps: 8,
      stopConditions: ['time-box'],
      reason: 'AC without a passing test',
    });
    expect(c.requirementIds).toEqual([]);
    expect(() =>
      ExplorationFinding.parse({
        id: 'XF-1',
        charterId: 'CH-1',
        kind: 'question',
        title: 't',
        observation: 'o',
        steps: [],
        severity: 'MINOR',
        suggestion: 'question',
        evidenceIds: [],
      }),
    ).toThrow();
  });
});

describe('Phase 7 policy', () => {
  const policy = PolicyConfig.parse(parse(readFileSync(join(repo, 'config', 'policy.yaml'), 'utf8')));

  it('publishing a defect waits for a human at every autonomy level', () => {
    for (const level of ['L1', 'L2', 'L3'] as const) {
      expect(checkpointRequired(policy, level, 'publish-defect')).toBe(true);
    }
  });

  it('investigation and charter limits are configured', () => {
    expect(policy.investigation.reproductions).toBeGreaterThanOrEqual(2);
    expect(policy.investigation.minConfidence).toBe(0.6);
    expect(policy.exploration.maxSavesPerCharter).toBe(5);
    expect(policy.exploration.charterMinutes).toBe(10);
  });

  it('defaults investigation settings when policy.yaml has none', () => {
    const raw = parse(readFileSync(join(repo, 'config', 'policy.yaml'), 'utf8')) as Record<string, unknown>;
    delete raw['investigation'];
    const p = PolicyConfig.parse(raw);
    expect(p.investigation).toEqual({ reproductions: 2, flakyReruns: 3, minConfidence: 0.6, extendedWaitFactor: 3 });
  });
});
