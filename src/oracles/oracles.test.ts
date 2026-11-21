import { describe, expect, it } from 'vitest';
import { EvidenceIndex, assignLevel, caseStatus, groundingProblems, valuesIn } from './index.js';
import {
  clarifications,
  components,
  docs,
  findings,
  manualTests,
  orgChecks,
  requirements,
} from '../../tests/helpers/designFixtures.js';

const index = new EvidenceIndex({
  docs,
  requirements,
  findings,
  clarifications,
  orgChecks,
  components,
  manualTests,
  locators: [],
  snapshotEnvironment: 'LIVE',
});

describe('EvidenceIndex', () => {
  it('indexes qualified sections and resolves unique unqualified refs', () => {
    expect(index.resolve('AC2')).toBe('SF-219#AC2');
    expect(index.resolve('brd-con-012#br-02')).toBe('BRD-CON-012#BR-02');
    expect(index.resolve('NOPE-1')).toBeUndefined();
    expect(index.get('SF-219#AC2')?.requirementIds).toEqual(['SF-219-R10']);
  });

  it('approved sections are APPROVED_REQUIREMENT; prose, assumptions and contested ones are not', () => {
    expect(index.get('SF-219#AC2')?.level).toBe('APPROVED_REQUIREMENT');
    expect(index.get('SF-219#S3')?.level).toBe('UNKNOWN_OR_CONTRADICTORY');
    expect(index.get('BRD-CON-012#A-02')?.reason).toMatch(/assumption/);
    // Q1 is answered only by an assumption → BR-04 is contested
    const br04 = index.get('BR-04');
    expect(br04?.level).toBe('UNKNOWN_OR_CONTRADICTORY');
    expect(br04?.reason).toMatch(/Q1/);
    // org conflicts do not contest a whole section: AC5 itself stays approved
    expect(index.get('AC5')?.level).toBe('APPROVED_REQUIREMENT');
  });

  it('org checks carry their own level; inactive rules and manual tests are not assertable', () => {
    expect(index.get('OC-007')?.level).toBe('DECLARED_CONFIG');
    expect(index.get('OC-003')?.level).toBe('UNKNOWN_OR_CONTRADICTORY');
    expect(index.get('ValidationRule:Contact.Phone_Must_Be_10_Digits')?.text).toMatch(
      /Phone must be exactly 10 digits\./,
    );
    expect(index.get('ValidationRule:Contact.Old_Rule')?.level).toBe('UNKNOWN_OR_CONTRADICTORY');
    expect(index.get('MTC-001')?.level).toBe('OBSERVED_ONLY');
  });

  it('sectionsOf maps requirement sources to qualified ids', () => {
    const r10 = requirements.find((r) => r.id === 'SF-219-R10');
    expect(r10 && index.sectionsOf(r10)).toEqual(['SF-219#AC2', 'BRD-CON-012#BR-02']);
  });
});

describe('assignLevel', () => {
  it('declared config beats approved requirement; both assertable', () => {
    expect(assignLevel(index, ['AC2', 'OC-002']).level).toBe('DECLARED_CONFIG');
    expect(assignLevel(index, ['AC2']).level).toBe('APPROVED_REQUIREMENT');
  });

  it('Email required (OC-003 CONFLICT) and Number_of_Contacts__c (OC-013 NOT_FOUND) are UNKNOWN', () => {
    const email = assignLevel(index, ['AC3', 'OC-003']);
    expect(email.level).toBe('UNKNOWN_OR_CONTRADICTORY');
    expect(email.reason).toMatch(/OC-003/);
    expect(assignLevel(index, ['BR-09', 'OC-013']).level).toBe('UNKNOWN_OR_CONTRADICTORY');
  });

  it('Phone format via OC-007 is DECLARED_CONFIG; citing contested BR-04 makes it UNKNOWN', () => {
    expect(assignLevel(index, ['AC5', 'OC-007']).level).toBe('DECLARED_CONFIG');
    expect(assignLevel(index, ['AC5', 'BR-04', 'OC-007']).level).toBe('UNKNOWN_OR_CONTRADICTORY');
  });

  it('UI/manual evidence only → OBSERVED_ONLY; nothing or unknown ids → UNKNOWN', () => {
    expect(assignLevel(index, ['MTC-001']).level).toBe('OBSERVED_ONLY');
    expect(assignLevel(index, []).level).toBe('UNKNOWN_OR_CONTRADICTORY');
    const ghost = assignLevel(index, ['OC-999']);
    expect(ghost.level).toBe('UNKNOWN_OR_CONTRADICTORY');
    expect(ghost.unknownIds).toEqual(['OC-999']);
  });

  it('never assigns VERIFIED', () => {
    for (const ids of [['AC2'], ['OC-002'], ['MTC-001'], ['AC2', 'OC-007']]) {
      expect(assignLevel(index, ids).level).not.toBe('VERIFIED');
    }
  });
});

describe('grounding', () => {
  it('extracts quoted values and numbers', () => {
    expect(valuesIn('shows "Phone must be exactly 10 digits." for 81 chars')).toEqual([
      'Phone must be exactly 10 digits.',
      '81',
    ]);
  });

  it('accepts values present in cited evidence or in the action', () => {
    expect(
      groundingProblems(index, 'Error "Phone must be exactly 10 digits." is shown', [
        'ValidationRule:Contact.Phone_Must_Be_10_Digits',
      ]),
    ).toEqual([]);
    expect(groundingProblems(index, 'An 81-character Last Name is rejected', ['BR-02'], 'Enter 81 characters')).toEqual(
      [],
    );
  });

  it('rejects an invented error message', () => {
    const p = groundingProblems(index, 'Error "Please enter a last name" is shown', ['AC2']);
    expect(p).toHaveLength(1);
    expect(p[0]?.message).toMatch(/do not invent/);
  });
});

describe('caseStatus', () => {
  const step = (evidenceLevel: 'APPROVED_REQUIREMENT' | 'OBSERVED_ONLY' | 'UNKNOWN_OR_CONTRADICTORY') => ({
    expected: { text: 't', evidenceLevel, evidenceIds: ['AC2'] },
  });
  it('approves only assertable cases with an available persona', () => {
    expect(
      caseStatus({ steps: [step('APPROVED_REQUIREMENT')], personaAvailable: true, persona: 'system-admin' })
        .reviewStatus,
    ).toBe('APPROVED');
    const r = caseStatus({
      steps: [step('OBSERVED_ONLY')],
      stepReasons: ['UI only'],
      personaAvailable: true,
      persona: 'a',
    });
    expect(r.reviewStatus).toBe('REVIEW_REQUIRED');
    expect(r.reviewReasons[0]).toMatch(/step 1 OBSERVED_ONLY: UI only/);
  });
  it('a missing persona blocks the case', () => {
    const r = caseStatus({ steps: [step('APPROVED_REQUIREMENT')], personaAvailable: false, persona: 'read-only' });
    expect(r.reviewStatus).toBe('BLOCKED');
    expect(r.reviewReasons[0]).toMatch(/^BLOCKED-NO-PERSONA/);
  });
});

describe('live-demo regressions (grounding)', () => {
  it('numbers inside ids (BR-06, AC#2) are not values', () => {
    expect(valuesIn('No evidence available for positive case for BR-06: Title list')).toEqual([]);
    expect(valuesIn('see AC#2 and 80 characters')).toEqual(['80']);
  });
});

describe('live-demo regressions (grounding sources)', () => {
  it('observed UI labels and the step text (action + preconditions) ground quoted values', () => {
    const loc = {
      org: 'o',
      page: 'account-record',
      element: 'button:New',
      persona: 'system-admin',
      scope: 'main',
      role: 'button',
      accessibleName: 'New',
      expression: "getByRole('button', { name: 'New', exact: true })",
      strategy: 'role' as const,
      strategyRank: 1,
      lastVerifiedAt: '2026-11-20T00:00:00.000Z',
      verifiedBy: 'explorer' as const,
      observationId: 'obs-1',
      status: 'ACTIVE' as const,
      environment: 'LIVE' as const,
    };
    const withUi = new EvidenceIndex({ docs, requirements, orgChecks, components, locators: [loc] });
    expect(groundingProblems(withUi, 'The "New" button is not available', ['OC-010'])).toEqual([]);
    expect(groundingProblems(index, 'The "New" button is not available', ['OC-010'])).toHaveLength(1);
    expect(groundingProblems(index, 'Account Name shows "Acme Test"', ['AC1'], "Open Account 'Acme Test'")).toEqual([]);
  });
});
