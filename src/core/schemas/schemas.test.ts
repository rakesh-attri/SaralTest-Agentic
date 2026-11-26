import { describe, expect, it } from 'vitest';
import {
  Approval,
  CoverageObligation,
  DataWriteState,
  GeneratedArtifact,
  IrAssertion,
  Recipe,
  TestIR,
  Issue,
  Requirement,
  ReviewFinding,
  RiskItem,
  RtmRow,
  TestCase,
  TestResult,
  isAssertable,
  OrgId18,
} from './index.js';
import { QARunState, initialRunState } from '../state.js';

const expected = (level: 'APPROVED_REQUIREMENT' | 'UNKNOWN_OR_CONTRADICTORY') => ({
  text: 'Contact.AccountId = new Account',
  evidenceLevel: level,
  evidenceIds: ['ev-1'],
});

const baseCase = {
  id: 'TC-1',
  title: 'Create Contact under Account',
  requirementIds: ['SF-1234-R01'],
  riskIds: [],
  technique: 'equivalence',
  persona: 'system-admin',
  type: 'e2e',
  priority: 'P1',
  severity: 'MAJOR',
  preconditions: [],
  tags: ['@e2e'],
  snapshotId: 'snap-1',
} as const;

describe('domain schemas', () => {
  it('validates a canonical requirement with a stable id', () => {
    const r = Requirement.safeParse({
      id: 'SF-1234-R03',
      businessObjective: 'x',
      actors: [],
      personas: [],
      preconditions: [],
      actions: [],
      businessRules: [],
      expectedOutcomes: [],
      dependencies: [],
      dataRequirements: [],
      risk: 'HIGH',
      assumptions: { known: [], unknown: [] },
      sources: [{ type: 'jira', ref: 'SF-1234', hash: 'abc' }],
      type: 'functional',
      status: 'REVIEW_REQUIRED',
    });
    expect(r.success).toBe(true);
  });

  it('an APPROVED case cannot carry an UNKNOWN_OR_CONTRADICTORY expectation', () => {
    const bad = TestCase.safeParse({
      ...baseCase,
      reviewStatus: 'APPROVED',
      steps: [{ action: 'save', expected: expected('UNKNOWN_OR_CONTRADICTORY') }],
    });
    expect(bad.success).toBe(false);
    const ok = TestCase.safeParse({
      ...baseCase,
      reviewStatus: 'APPROVED',
      steps: [{ action: 'save', expected: expected('APPROVED_REQUIREMENT') }],
    });
    expect(ok.success).toBe(true);
  });

  it('only the first three evidence levels are assertable', () => {
    expect(isAssertable('VERIFIED')).toBe(true);
    expect(isAssertable('OBSERVED_ONLY')).toBe(false);
  });

  it('TestResult requires an environment label', () => {
    expect(
      TestResult.safeParse({ testId: 't', state: 'PASS', evidenceIds: [], snapshotId: 's', runId: 'r' }).success,
    ).toBe(false);
  });

  it('Issue kinds are closed', () => {
    expect(
      Issue.safeParse({
        id: 'i',
        kind: 'WHATEVER',
        node: 'n',
        message: '',
        attempts: 0,
        createdAt: new Date().toISOString(),
      }).success,
    ).toBe(false);
  });

  it('OrgId18 accepts only 18-char 00D ids', () => {
    expect(OrgId18.safeParse('00DFIXTURE00000001').success).toBe(true);
    expect(OrgId18.safeParse('00D000000000000').success).toBe(false);
  });

  it('initialRunState produces a valid QARunState', () => {
    const s = initialRunState({
      runId: 'run-1',
      org: 'fixture',
      autonomy: 'L2',
      source: { type: 'file', ref: 'examples/stories/account-contact.md' },
      tokenLimit: 1000,
      timeLimitMin: 10,
    });
    expect(QARunState.safeParse(s).success).toBe(true);
    expect(s.status).toBe('RUNNING');
  });
});

describe('Phase 1 input schemas', () => {
  it('requires at least one source ref on a finding and defaults clarification extras', async () => {
    const { AnalysisFinding, Clarification } = await import('./index.js');
    expect(
      AnalysisFinding.safeParse({ id: 'F1', kind: 'CONFLICT', text: 'x', refs: [], severity: 'HIGH', origin: 'llm' })
        .success,
    ).toBe(false);
    const c = Clarification.parse({ id: 'Q1', question: 'Is Email required?', status: 'OPEN' });
    expect(c.refs).toEqual([]);
    expect(c.round).toBe(1);
  });
});

describe('Phase 3 design contracts', () => {
  const step = (evidenceLevel: string, evidenceIds: string[] = ['SF-219#AC2']) => ({
    action: 'save without Last Name',
    expected: { text: 'save is blocked', evidenceLevel, evidenceIds },
  });

  it('an APPROVED case cannot carry an OBSERVED_ONLY expectation', () => {
    const r = TestCase.safeParse({ ...baseCase, reviewStatus: 'APPROVED', steps: [step('OBSERVED_ONLY')] });
    expect(r.success).toBe(false);
    expect(
      TestCase.safeParse({ ...baseCase, reviewStatus: 'REVIEW_REQUIRED', steps: [step('OBSERVED_ONLY')] }).success,
    ).toBe(true);
  });

  it('every non-UNKNOWN expectation cites evidence', () => {
    expect(
      TestCase.safeParse({ ...baseCase, reviewStatus: 'REVIEW_REQUIRED', steps: [step('DECLARED_CONFIG', [])] })
        .success,
    ).toBe(false);
    expect(
      TestCase.safeParse({
        ...baseCase,
        reviewStatus: 'REVIEW_REQUIRED',
        steps: [step('UNKNOWN_OR_CONTRADICTORY', [])],
      }).success,
    ).toBe(true);
  });

  it('new TestCase / RtmRow fields default so Phase 2 data still parses', () => {
    const tc = TestCase.parse({ ...baseCase, reviewStatus: 'APPROVED', steps: [step('APPROVED_REQUIREMENT')] });
    expect(tc.origin).toBe('planned');
    expect(tc.regressionTier).toBe('optional');
    expect(tc.reviewReasons).toEqual([]);
    const row = RtmRow.parse({ requirementId: 'SF-219-R01', testCaseIds: [] });
    expect(row.status).toBe('designed');
  });

  it('risk, obligation and review finding ids are shaped', () => {
    expect(
      RiskItem.safeParse({
        id: 'RISK-01',
        desc: 'Email rule conflicts with the org',
        likelihood: 0.7,
        impact: 'H',
        score: 0.7,
        tier: 'mandatory',
        drivers: [{ kind: 'org-conflict', text: 'OC-003', weight: 0.4 }],
        requirementIds: ['SF-219-R03'],
      }).success,
    ).toBe(true);
    expect(
      CoverageObligation.safeParse({ id: 'OB-1', requirementId: 'R', ref: 'AC1', kind: 'positive', detail: 'x' })
        .success,
    ).toBe(false);
    expect(
      ReviewFinding.safeParse({
        id: 'RF-001',
        round: 1,
        severity: 'H',
        rule: 'ac-positive',
        text: 'AC2 has no positive case',
        origin: 'deterministic',
        status: 'OPEN',
      }).success,
    ).toBe(true);
  });

  it('initial run state has empty design channels', () => {
    const s = initialRunState({
      runId: 'r',
      org: 'o',
      autonomy: 'L2',
      source: { type: 'chat', ref: 'x' },
      tokenLimit: 10,
      timeLimitMin: 1,
    });
    expect(s.risks).toEqual([]);
    expect(s.reviewRound).toBe(0);
  });
});

describe('Phase 4 generation + data contracts', () => {
  const recipeYaml = {
    recipe: 'account-contact',
    approvedBy: 'Rakesh Sharma',
    objects: [
      { object: 'Account', recordType: null, fields: { Name: 'QA-{runId}-Acme {synthetic}', Industry: 'Technology' } },
      {
        object: 'Contact',
        parent: { field: 'AccountId', ref: 'Account' },
        fields: { LastName: 'QA-{runId}-{synthetic}' },
      },
    ],
    negativeVariants: [{ name: 'missing-last-name', object: 'Contact', remove: ['LastName'], expect: 'rejected' }],
    cleanup: 'reverse-dependency',
  };

  it('parses the approved Account → Contact recipe shape', () => {
    const r = Recipe.parse(recipeYaml);
    expect(r.objects[1]?.parent?.ref).toBe('Account');
    expect(r.negativeVariants[0]?.remove).toEqual(['LastName']);
  });

  it('refuses an unapproved recipe, a parent declared later, and an unknown negative step', () => {
    expect(Recipe.safeParse({ ...recipeYaml, approvedBy: '<name>' }).success).toBe(false);
    const reversed = { ...recipeYaml, objects: [...recipeYaml.objects].reverse() };
    expect(Recipe.safeParse(reversed).success).toBe(false);
    const badNeg = { ...recipeYaml, negativeVariants: [{ name: 'x', object: 'Lead', expect: 'rejected' }] };
    expect(Recipe.safeParse(badNeg).success).toBe(false);
  });

  it('test IR: elements are page-object members and every assertion cites an expectation', () => {
    const ok = TestIR.safeParse({
      caseId: 'TC-SF-219-003',
      data: ['Account'],
      steps: [
        {
          caseStep: 0,
          title: 'Save without Last Name',
          actions: [{ do: 'click', element: 'contact-new.save' }],
          assertions: [
            {
              check: 'fieldError',
              element: 'contact-new.lastName',
              expect: { caseStep: 0, evidenceIds: ['SF-219#AC2'] },
            },
          ],
        },
      ],
    });
    expect(ok.success).toBe(true);
    const raw = TestIR.safeParse({
      caseId: 'x',
      steps: [{ caseStep: 0, title: 'raw', actions: [{ do: 'click', element: "page.locator('//div')" }] }],
    });
    expect(raw.success).toBe(false);
    // Omitted evidence parses; normalizeIr fills it from the case step and irProblems rejects an empty list.
    const noEvidence = IrAssertion.safeParse({ check: 'toast', expect: { caseStep: 0 } });
    expect(noEvidence.success && noEvidence.data.expect.evidenceIds).toEqual([]);
  });

  it('generated artifacts carry lineage and review status; old pass-1 findings stay valid', () => {
    const a = GeneratedArtifact.parse({
      kind: 'spec',
      path: 'tests/generated/SF-219/x.spec.ts',
      hash: 'h',
      testCaseIds: ['TC-1'],
    });
    expect(a.locatorsUsed).toEqual([]);
    expect(a.origin).toBe('deterministic');
    expect(
      ReviewFinding.parse({
        id: 'RF-001',
        round: 1,
        severity: 'L',
        rule: 'duplicate',
        text: 't',
        origin: 'deterministic',
        status: 'OPEN',
      }).pass,
    ).toBeUndefined();
  });

  it('data plan: an issue-free plan is valid; approvals have stable ids', () => {
    expect(
      Approval.safeParse({
        id: 'AP-0123456789ab',
        checkpoint: 'new-data-recipe-or-mutation-type',
        subject: 'recipe:account-contact@abc',
        orgId: '00DdN00000uQ5dKUAS',
        approvedBy: 'operator',
        approvedAt: new Date().toISOString(),
      }).success,
    ).toBe(true);
    expect(DataWriteState.options).toContain('FAILED');
  });
});

describe('Phase 5 execution contracts', () => {
  it('the committed SF-219 manifest parses with pass-2 recheck fields and manual-only cases', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { StoryManifest } = await import('./index.js');
    const raw = JSON.parse(
      readFileSync(
        join(import.meta.dirname, '..', '..', '..', 'tests', 'generated', 'SF-219', 'manifest.json'),
        'utf8',
      ),
    ) as unknown;
    const m = StoryManifest.parse(raw);
    expect(m.storyKey).toBe('SF-219');
    expect(m.artifacts.length).toBeGreaterThan(0);
    expect(m.manualOnly.length).toBeGreaterThan(0);
  });

  it('older TestResult rows stay valid; runner detail is optional', () => {
    const base = {
      testId: 'TC-1',
      state: 'PASS',
      evidenceIds: [],
      environment: 'FIXTURE',
      snapshotId: 's',
      runId: 'r',
    };
    expect(TestResult.parse(base).attachments).toEqual([]);
    const r = TestResult.parse({
      ...base,
      state: 'UNCERTAIN',
      flaky: true,
      attempts: 2,
      browser: 'chrome',
      dataCleanup: 'CLEAN',
    });
    expect(r.flaky).toBe(true);
    expect(TestResult.safeParse({ ...base, dataCleanup: 'DIRTY' }).success).toBe(false);
  });

  it('a JIRA comment draft is bound to a sha256 and an observed message names its page and placement', async () => {
    const { JiraCommentDraft, ObservedMessage } = await import('./index.js');
    const at = '2026-11-26T10:00:00.000Z';
    expect(
      JiraCommentDraft.safeParse({ storyKey: 'SF-1', runId: 'r', text: 'x', sha256: 'abc', createdAt: at }).success,
    ).toBe(false);
    expect(
      JiraCommentDraft.safeParse({ storyKey: 'SF-1', runId: 'r', text: 'x', sha256: 'a'.repeat(64), createdAt: at })
        .success,
    ).toBe(true);
    const msg = {
      id: 'om-1',
      org: '00DdN00000uQ5dKUAS',
      page: 'contact-new',
      field: 'Contact.LastName',
      kind: 'required',
      placement: 'field',
      text: 'Complete this field.',
      persona: 'system-admin',
      snapshotId: 's',
      observedAt: at,
      runId: 'r',
      environment: 'LIVE',
    };
    expect(ObservedMessage.parse(msg).placement).toBe('field');
    expect(ObservedMessage.safeParse({ ...msg, environment: 'MOCK' }).success).toBe(false);
  });
});
