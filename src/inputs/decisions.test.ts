import { describe, expect, it } from 'vitest';
import { EvidenceIndex } from '../oracles/index.js';
import { buildRtm, type PlannerContext } from '../agents/test-planner/graph.js';
import { inScope } from '../graph/designNodes.js';
import type { AnalysisFinding } from '../core/schemas/requirement.js';
import { clarifications, docs, findings, requirements, SNAP } from '../../tests/helpers/designFixtures.js';
import { applyDecisions, DecisionsFile, decisionsDocId } from './decisions.js';

const f016 = {
  id: 'F-016',
  kind: 'AMBIGUITY',
  text: 'Lead Source not found',
  refs: ['BR-04'],
  requirementIds: ['SF-219-R14'],
  severity: 'MEDIUM',
  origin: 'llm',
} as AnalysisFinding;
const input = () => ({
  sources: docs,
  requirements: requirements.map((r) =>
    r.id === 'SF-219-R14'
      ? { ...r, reviewReasons: ['F-016 ambiguity: Lead Source not found', 'relies on unconfirmed assumption Q1'] }
      : r,
  ),
  findings: [...findings, f016],
  clarifications,
});
const decisions = DecisionsFile.parse({
  storyKey: 'SF-219',
  decidedBy: 'QA operator',
  decidedOn: '2026-11-25',
  answers: [
    {
      id: 'Q1',
      answer: 'Phone is required only when Lead Source is Web (rule Phone_Required_For_Web).',
      resolvesFindings: ['F-016'],
      expectedOutcomes: ['When Lead Source is not Web, a Contact without Phone is saved.'],
    },
  ],
  deferred: [{ requirementId: 'SF-219-R23', reason: 'BR-09 out of scope for now' }],
  notes: [{ id: 'C1', text: 'Email rule comes later; cases stay blocked.' }],
});

describe('applyDecisions', () => {
  const r = applyDecisions(input(), decisions);
  const r14 = r.requirements.find((x) => x.id === 'SF-219-R14');

  it('answers the clarification, settles the reasons it names and makes the requirement executable', () => {
    expect(r.clarifications.find((c) => c.id === 'Q1')).toMatchObject({ status: 'ANSWERED' });
    expect(r.clarifications.find((c) => c.id === 'Q1')?.assumption).toBeUndefined();
    expect(r14?.reviewReasons).toEqual([]);
    expect(r14?.status).toBe('EXECUTABLE');
    expect(r14?.expectedOutcomes).toContain('When Lead Source is not Web, a Contact without Phone is saved.');
    expect(r.findings.map((f) => f.id)).not.toContain('F-016');
  });

  it('turns the answer into approved, uncontested evidence', () => {
    const index = new EvidenceIndex({
      docs: r.sources,
      requirements: r.requirements,
      findings: r.findings,
      clarifications: r.clarifications,
    });
    const doc = decisionsDocId('SF-219');
    expect(index.get(`${doc}#Q1`)?.level).toBe('APPROVED_REQUIREMENT');
    expect(index.get('BRD-CON-012#BR-04')?.level).toBe('APPROVED_REQUIREMENT');
    expect(r14 && index.sectionsOf(r14)).toContain(`${doc}#Q1`);
    // context notes and deferrals are never assertable
    expect(index.get(`${doc}#C1`)?.level).toBe('UNKNOWN_OR_CONTRADICTORY');
    // before the decision, the assumption contested BR-04
    const before = new EvidenceIndex({ docs, requirements, findings: [...findings, f016], clarifications });
    expect(before.get('BRD-CON-012#BR-04')?.level).toBe('UNKNOWN_OR_CONTRADICTORY');
  });

  it('defers a requirement: out of design scope, RTM row excluded', () => {
    const r23 = r.requirements.find((x) => x.id === 'SF-219-R23');
    expect(r23?.status).toBe('DEFERRED');
    expect(inScope(r.requirements).map((x) => x.id)).not.toContain('SF-219-R23');
    const index = new EvidenceIndex({ docs: r.sources, requirements: r.requirements });
    const ctx: PlannerContext = {
      storyKey: 'SF-219',
      requirements: inScope(r.requirements),
      deferred: r.requirements.filter((x) => x.status === 'DEFERRED'),
      obligations: [],
      risks: [],
      index,
      manualTests: [],
      personas: [],
      defaultPersona: 'system-admin',
      snapshotId: SNAP,
      outOfScope: [],
    };
    const rtm = buildRtm(ctx, []);
    expect(rtm).toHaveLength(requirements.length);
    expect(rtm.find((x) => x.requirementId === 'SF-219-R23')).toMatchObject({
      status: 'excluded',
      testCaseIds: [],
    });
    expect(r.sources.at(-1)?.sections.find((s) => s.ref === 'DEFER-SF-219-R23')?.kind).toBe('out-of-scope');
  });

  it('does not change its input and lists every change', () => {
    const i = input();
    applyDecisions(i, decisions);
    expect(i.clarifications[0]?.status).toBe('ASSUMED');
    expect(r.changes).toEqual(
      expect.arrayContaining([
        'Q1 ANSWERED (was ASSUMED)',
        'SF-219-R23 DEFERRED: BR-09 out of scope for now',
        'finding F-016 resolved by decision',
      ]),
    );
  });

  it('rejects decisions that match nothing', () => {
    expect(() => applyDecisions(input(), { ...decisions, answers: [{ ...decisions.answers[0]!, id: 'Q9' }] })).toThrow(
      /Q9/,
    );
    expect(() =>
      applyDecisions(input(), {
        ...decisions,
        deferred: [{ requirementId: 'SF-219-R99', reason: 'x', resolvesFindings: [] }],
      }),
    ).toThrow(/R99/);
    expect(() =>
      applyDecisions(input(), {
        ...decisions,
        answers: [{ ...decisions.answers[0]!, resolvesFindings: ['F-404'] }],
      }),
    ).toThrow(/F-404/);
  });
});
