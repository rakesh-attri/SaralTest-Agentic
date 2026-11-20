import { describe, expect, it } from 'vitest';
import { Issue, Requirement, TestCase, TestResult, isAssertable, OrgId18 } from './index.js';
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
