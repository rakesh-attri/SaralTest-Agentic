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

  it('the SF-219 edit file parses', () => {
    const f = loadCaseEdits(join(REPO_ROOT, 'examples', 'case-edits', 'SF-219.yaml'));
    expect(f.edits.map((e) => e.caseId)).toContain('TC-SF-219-009');
    expect(f.manualOnly.map((m) => m.caseId)).toEqual(['TC-SF-219-051', 'TC-SF-219-052']);
  });
});
