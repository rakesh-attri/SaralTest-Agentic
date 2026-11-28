import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CASE } from '../../tests/helpers/generationFixtures.js';
import { REPO_ROOT } from '../../tests/helpers/tempProject.js';
import { isAutomatable } from '../core/schemas/testCase.js';
import { applyCaseEdits, CaseEditsFile, loadCaseEdits } from './caseEdits.js';

const file = (from: string, step = 1): CaseEditsFile =>
  CaseEditsFile.parse({
    storyKey: 'SF-219',
    decidedBy: 'QA operator',
    decidedOn: '2026-11-26',
    edits: [{ caseId: CASE.id, step, from, to: 'EDITED', reason: 'test' }],
  });

describe('operator case edits', () => {
  it('replaces exact step text on a copy and lists the change', () => {
    const from = CASE.steps[0]!.action.slice(0, 8);
    const r = applyCaseEdits([CASE], file(from));
    expect(r.cases[0]!.steps[0]!.action.startsWith('EDITED')).toBe(true);
    expect(CASE.steps[0]!.action.startsWith(from)).toBe(true); // input untouched
    expect(r.changes[0]).toContain(`${CASE.id} step 1 action`);
    expect(r.cases[0]!.reviewStatus).toBe(CASE.reviewStatus);
  });

  it('an edit that matches nothing is an error', () => {
    expect(() => applyCaseEdits([CASE], file('no such text'))).toThrow(/has no "no such text"/);
    expect(() => applyCaseEdits([CASE], file('x', 99))).toThrow(/no step 99/);
  });

  it('manual-only marks the case; it is no longer automatable', () => {
    const f = { ...file(CASE.steps[0]!.action.slice(0, 5)), manualOnly: [{ caseId: CASE.id, reason: 'human check' }] };
    const r = applyCaseEdits([CASE], f);
    expect(r.cases[0]).toMatchObject({ execution: 'manual', executionReason: 'human check' });
    expect(isAutomatable(r.cases[0]!)).toBe(false);
    expect(isAutomatable(CASE)).toBe(true);
    expect(() => applyCaseEdits([CASE], { ...f, manualOnly: [{ caseId: 'TC-X', reason: 'r' }] })).toThrow(/TC-X/);
  });

  it('drops a step the operator rules not automatable; never the last one, never an unknown one', () => {
    const f = {
      ...file(CASE.steps[0]!.action.slice(0, 5)),
      dropSteps: [{ caseId: CASE.id, step: 2, reason: 'human check' }],
    };
    const r = applyCaseEdits([CASE], f);
    expect(r.cases[0]!.steps).toHaveLength(CASE.steps.length - 1);
    expect(r.cases[0]!.steps[0]!.action.startsWith('EDITED')).toBe(true);
    expect(CASE.steps).toHaveLength(2); // input untouched
    expect(r.changes.join(' ')).toContain(`${CASE.id} step 2 removed:`);
    expect(r.changes.join(' ')).toContain('(human check)');
    expect(() =>
      applyCaseEdits([CASE], {
        ...f,
        dropSteps: [
          { caseId: CASE.id, step: 1, reason: 'r' },
          { caseId: CASE.id, step: 2, reason: 'r' },
        ],
      }),
    ).toThrow(/no step left/);
    expect(() => applyCaseEdits([CASE], { ...f, dropSteps: [{ caseId: CASE.id, step: 9, reason: 'r' }] })).toThrow(
      /no step 9/,
    );
  });

  it('the SF-219 edit file parses', () => {
    const f = loadCaseEdits(join(REPO_ROOT, 'examples', 'case-edits', 'SF-219.yaml'));
    expect(f.edits.map((e) => e.caseId)).toContain('TC-SF-219-009');
    expect(f.manualOnly.map((m) => m.caseId)).toEqual(['TC-SF-219-051', 'TC-SF-219-052']);
  });

  it('Phase 7: adds an operator case citing a recorded decision, binds recipes, approves only assertable cases', () => {
    const repo = loadCaseEdits(join(REPO_ROOT, 'examples', 'case-edits', 'SF-219.yaml'));
    expect(repo.decisions.map((d) => d.id)).toContain('P7-BR08-POS');
    const pending = {
      ...CASE,
      id: 'TC-SF-219-031',
      reviewStatus: 'REVIEW_REQUIRED' as const,
      reviewReasons: ['RF-004'],
    };
    const f = CaseEditsFile.parse({
      storyKey: 'SF-219',
      decidedBy: 'Op',
      decidedOn: '2026-11-27',
      decisions: [{ id: 'P7-X', text: 'A Contact without open Cases can be deleted.' }],
      dataRecipe: [{ caseId: 'TC-SF-219-031', recipe: 'contact-open-case', reason: 'r' }],
      approve: [{ caseId: 'TC-SF-219-031', findingIds: ['RF-004'], resolution: 'counterpart added' }],
      addCases: [
        {
          ...CASE,
          origin: undefined,
          id: 'TC-SF-219-054',
          steps: [
            {
              action: 'a',
              expected: { text: 't', evidenceLevel: 'APPROVED_REQUIREMENT', evidenceIds: ['SF-219-CASE-EDITS#P7-X'] },
            },
          ],
        },
      ],
    });
    const r = applyCaseEdits([pending], f, new Set());
    const added = r.cases.find((c) => c.id === 'TC-SF-219-054');
    expect(added?.origin).toBe('operator');
    expect(r.cases.find((c) => c.id === 'TC-SF-219-031')).toMatchObject({
      reviewStatus: 'APPROVED',
      dataRecipe: 'contact-open-case',
      reviewReasons: [],
    });
    expect(r.changes.some((c) => c.includes('resolves RF-004'))).toBe(true);
    // unknown evidence refused
    const bad = CaseEditsFile.parse({ ...f, decisions: [] });
    expect(() => applyCaseEdits([pending], bad, new Set())).toThrow(/cites evidence the design run does not have/);
    // a non-assertable expectation blocks approval
    const weak = {
      ...pending,
      steps: [{ action: 'a', expected: { text: 't', evidenceLevel: 'OBSERVED_ONLY' as const, evidenceIds: ['x'] } }],
    };
    expect(() => applyCaseEdits([weak], { ...f, addCases: [] }, new Set())).toThrow(/not assertable/);
  });
});
