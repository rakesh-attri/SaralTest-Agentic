import { describe, expect, it } from 'vitest';
import type { BaseMessage } from '@langchain/core/messages';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceIndex } from '../../oracles/index.js';
import { assessRisks, deriveObligations, resolvePersona, tierObligations } from '../impact-risk/index.js';
import { TestCase } from '../../core/schemas/index.js';
import { mockRouter } from '../../../tests/helpers/mockRouter.js';
import {
  SNAP,
  clarifications,
  components,
  docs,
  findings,
  manualTests,
  orgChecks,
  requirements,
} from '../../../tests/helpers/designFixtures.js';
import { TestCaseIdStore } from './ids.js';
import {
  buildCases,
  buildRtm,
  draftProblems,
  mechanicalDrafts,
  planTests,
  priorityFor,
  revisePlan,
  type PlannerContext,
} from './graph.js';

const index = new EvidenceIndex({ docs, requirements, findings, clarifications, orgChecks, components, manualTests });
const configured = [{ id: 'system-admin', profile: 'System Administrator' }];
const obligationsRaw = deriveObligations({
  requirements,
  index,
  orgChecks,
  components,
  manualTests,
  personas: configured,
  defaultPersona: 'system-admin',
});
const risks = assessRisks({ requirements, index, orgChecks, manualTests });
const obligations = tierObligations(obligationsRaw, risks);
const ctx: PlannerContext = {
  storyKey: 'SF-219',
  storyTitle: 'Add Contacts from Account',
  requirements,
  obligations,
  risks,
  index,
  manualTests,
  personas: [resolvePersona('system-admin', configured), resolvePersona('Read Only User', configured, orgChecks)],
  defaultPersona: 'system-admin',
  snapshotId: SNAP,
  outOfScope: ['Contact import'],
  recipes: ['account-contact'],
};

const text = (m: BaseMessage): string => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));

/** Mock planner: one case per obligation, citing the first allowed evidence, no invented values. */
function plannerResponder(opts: { invent?: boolean } = {}) {
  return (messages: BaseMessage[]): string => {
    const user = messages.map(text).find((t) => t.includes('OBLIGATIONS TO COVER')) ?? '';
    const cases: unknown[] = [];
    const blocks = user.split(/\n(?= {2}OB-\d{3})/);
    for (const b of blocks) {
      const ob = /^ {2}(OB-\d{3}) \[[^\]]*\]/.exec(b);
      if (!ob) continue;
      const persona = /· persona ([a-z0-9-]+)/.exec(b)?.[1] ?? 'system-admin';
      const ev = /\n {4}- ([^\s(]+) \(/.exec(b)?.[1];
      cases.push({
        key: `k-${ob[1] ?? ''}`,
        title: `Verify ${ob[1] ?? ''}`,
        obligationIds: [ob[1]],
        persona,
        type: 'functional',
        technique: 'use case',
        steps: [
          {
            action: 'Open the Account, click New in Contacts, fill the form and click Save',
            expected: opts.invent
              ? 'The error "Please fill this in" appears'
              : 'The save outcome stated by the cited evidence is observed on the record page',
            obligationId: ob[1],
            evidence: ev ? [ev] : ['SF-219#AC1'],
          },
        ],
      });
    }
    return JSON.stringify({ cases });
  };
}

const ids = () => new TestCaseIdStore('SF-219');

describe('priorityFor', () => {
  it('security / data → P0, HIGH → P1, MEDIUM → P2', () => {
    const get = (id: string) => requirements.filter((r) => r.id === id);
    expect(priorityFor(get('SF-219-R16'), obligations)).toBe('P0');
    expect(priorityFor(get('SF-219-R36'), obligations)).toBe('P0'); // HIGH-risk core-flow AC
    expect(priorityFor(get('SF-219-R10'), obligations)).toBe('P2');
  });
});

describe('mechanical planning', () => {
  it('one case per obligation; expected text is verbatim evidence; every case validates', async () => {
    const res = await planTests(ctx, { ids: ids() }, 'mechanical');
    expect(res.environment).toBe('NONE');
    expect(res.testCases).toHaveLength(obligations.length);
    for (const c of res.testCases) expect(TestCase.safeParse(c).success).toBe(true);
    const neg = res.testCases.find((c) =>
      c.obligationIds.some((o) => obligations.find((x) => x.id === o)?.evidenceIds[0] === 'OC-007'),
    );
    expect(neg?.steps[0]?.expected.text).toMatch(/^As stated in OC-007:/);
    expect(neg?.steps[0]?.expected.evidenceLevel).toBe('DECLARED_CONFIG');
    expect(neg?.reviewStatus).toBe('APPROVED');
  });

  it('the Email-required negative is REVIEW_REQUIRED, the Read Only deny case BLOCKED-NO-PERSONA', async () => {
    const res = await planTests(ctx, { ids: ids() }, 'mechanical');
    const email = res.testCases.find((c) => c.steps[0]?.expected.evidenceIds.includes('OC-003'));
    expect(email?.reviewStatus).toBe('REVIEW_REQUIRED');
    expect(email?.reviewReasons.join(' ')).toMatch(/OC-003/);
    const deny = res.testCases.find((c) => c.persona === 'read-only');
    expect(deny?.reviewStatus).toBe('BLOCKED');
    expect(deny?.reviewReasons[0]).toMatch(/BLOCKED-NO-PERSONA/);
  });

  it('manual tests listed on an obligation are reused', async () => {
    const res = await planTests(ctx, { ids: ids() }, 'mechanical');
    expect(res.testCases.some((c) => c.origin === 'manual-reuse' && c.manualTestId === 'MTC-002')).toBe(true);
  });

  it('RTM covers every requirement with obligation coverage', async () => {
    const res = await planTests(ctx, { ids: ids() }, 'mechanical');
    expect(res.rtm.map((r) => r.requirementId).sort()).toEqual(requirements.map((r) => r.id).sort());
    for (const row of res.rtm) expect(row.coverage?.covered).toBe(row.coverage?.total);
    expect(res.rtm.find((r) => r.requirementId === 'SF-219-R16')?.status).toBe('blocked');
  });

  it('stable ids across re-runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa ids '));
    const a = await planTests(ctx, { ids: new TestCaseIdStore('SF-219', dir) }, 'mechanical');
    const b = await planTests(ctx, { ids: new TestCaseIdStore('SF-219', dir) }, 'mechanical');
    expect(b.testCases.map((c) => c.id)).toEqual(a.testCases.map((c) => c.id));
    expect(a.testCases[0]?.id).toBe('TC-SF-219-001');
  });
});

describe('requirement-level review reasons', () => {
  it('cases on a mechanical or outcome-less requirement are REVIEW_REQUIRED; section-scoped reasons are not copied', async () => {
    const reqs = requirements.map((r) =>
      r.id === 'SF-219-R10'
        ? {
            ...r,
            status: 'REVIEW_REQUIRED' as const,
            reviewReasons: ['generated mechanically (model unavailable): needs analyst review'],
          }
        : r.id === 'SF-219-R36'
          ? { ...r, reviewReasons: ['F-001 ambiguity: Vague wording "probably"'] }
          : r,
    );
    const res = await planTests({ ...ctx, requirements: reqs }, { ids: ids() }, 'mechanical');
    const r10 = res.testCases.filter((c) => c.requirementIds.includes('SF-219-R10'));
    expect(r10.length).toBeGreaterThan(0);
    for (const c of r10) {
      expect(c.reviewStatus).toBe('REVIEW_REQUIRED');
      expect(c.reviewReasons.join(' ')).toMatch(/requirement SF-219-R10: generated mechanically/);
    }
    const ac1 = res.testCases.find((c) => c.refs.includes('AC1') && c.requirementIds.includes('SF-219-R36'));
    expect(ac1?.reviewStatus).toBe('APPROVED');
  });
});

describe('live-demo regressions (requirement reasons)', () => {
  it('a requirement reason blocks only cases citing its refs; reasons without refs block every case', async () => {
    const reqs = requirements.map((r) =>
      r.id === 'SF-219-R14'
        ? { ...r, status: 'REVIEW_REQUIRED' as const, reviewReasons: ['relies on unconfirmed assumption Q1'] }
        : r.id === 'SF-219-R23'
          ? { ...r, status: 'REVIEW_REQUIRED' as const, reviewReasons: ['no expected outcome stated in the sources'] }
          : r,
    );
    const res = await planTests({ ...ctx, requirements: reqs }, { ids: ids() }, 'mechanical');
    // Q1 refs BR-04; the OC-007 format case cites AC5 + OC-007 only → not blocked
    const fmt = res.testCases.find(
      (c) =>
        c.steps.some((s) => s.expected.evidenceIds.includes('OC-007')) && c.technique !== 'boundary value analysis',
    );
    expect(fmt?.reviewReasons.some((x) => x.includes('Q1'))).toBe(false);
    for (const c of res.testCases.filter((x) => x.requirementIds.includes('SF-219-R23'))) {
      expect(c.reviewStatus).toBe('REVIEW_REQUIRED');
      expect(c.reviewReasons.join(' ')).toMatch(/no expected outcome stated/);
    }
  });
});

describe('model planning', () => {
  it('uses model drafts, labels MOCK, code assigns levels and status', async () => {
    const router = await mockRouter({ reasoning: { responder: plannerResponder() } });
    const res = await planTests(ctx, { ids: ids(), router, batchSize: 6 }, 'llm');
    expect(res.environment).toBe('MOCK');
    expect(res.degraded).toEqual([]);
    expect(res.testCases.length).toBe(obligations.length);
    expect(res.testCases.every((c) => c.origin !== 'mechanical')).toBe(true);
    expect(res.charter.environment).toBe('MOCK');
    expect(res.charter.personas.find((p) => p.id === 'read-only')?.available).toBe(false);
  });

  it('an invented error message is reflected back; persistent invention degrades to mechanical', async () => {
    const router = await mockRouter({
      reasoning: { responder: plannerResponder({ invent: true }) },
      'reasoning:fallback': { responder: plannerResponder({ invent: true }) },
    });
    const res = await planTests(ctx, { ids: ids(), router, batchSize: 100 }, 'llm');
    expect(res.degraded).toHaveLength(1);
    expect(res.degraded[0]?.reason).toMatch(/Please fill this in|INVALID|not in the cited evidence/i);
    expect(res.testCases.every((c) => c.origin === 'mechanical' || c.origin === 'manual-reuse')).toBe(true);
  });
});

describe('draftProblems', () => {
  it('rejects evidence outside the obligation, wrong persona and uncovered obligations', () => {
    const deny = obligations.find((o) => o.kind === 'deny');
    const drafts = mechanicalDrafts(ctx, obligations);
    const bad = drafts.map((d) =>
      d.obligationIds[0] === deny?.id
        ? { ...d, persona: 'system-admin', steps: [{ ...d.steps[0]!, evidence: ['OC-007'] }] }
        : d,
    );
    const p = draftProblems(ctx, bad.slice(1), obligations);
    expect(p.some((m) => m.includes('must run as persona "read-only"'))).toBe(true);
    expect(p.some((m) => m.includes('"OC-007" is not allowed'))).toBe(true);
    expect(p.some((m) => m.startsWith('not covered:'))).toBe(true);
  });
});

describe('revisePlan', () => {
  it('without a model nothing changes', async () => {
    const res = await planTests(ctx, { ids: ids() }, 'mechanical');
    const r = await revisePlan(ctx, { ids: ids() }, res.testCases, [], 'mechanical');
    expect(r.testCases).toHaveLength(res.testCases.length);
  });

  it('model justifications and case updates are applied; status recomputed by code', async () => {
    const res = await planTests(ctx, { ids: ids() }, 'mechanical');
    const target = res.testCases.find((c) => c.reviewStatus === 'APPROVED');
    if (!target) throw new Error('no approved case');
    const finding = {
      id: 'RF-001',
      key: 'vague:x',
      escalated: false,
      round: 1,
      severity: 'M' as const,
      rule: 'vague-expectation' as const,
      caseIds: [target.id],
      requirementIds: target.requirementIds,
      refs: [],
      text: 'expected is copied evidence, make it observable',
      origin: 'deterministic' as const,
      status: 'OPEN' as const,
    };
    const ob = obligations.find((o) => o.id === target.obligationIds[0]);
    const router = await mockRouter({
      reasoning: {
        responder: () =>
          JSON.stringify({
            cases: [
              {
                key: target.id,
                title: target.title,
                obligationIds: target.obligationIds,
                persona: target.persona,
                type: target.type,
                technique: target.technique,
                steps: [
                  {
                    action: 'Click Save',
                    expected: 'The record is not saved and the field shows an error',
                    obligationId: ob?.id,
                    evidence: [ob?.evidenceIds[0]],
                  },
                ],
              },
            ],
            justifications: [{ findingId: 'RF-002', reason: 'unknown finding id should be rejected' }],
          }),
      },
      'reasoning:fallback': {
        responder: () =>
          JSON.stringify({
            cases: [],
            justifications: [
              { findingId: 'RF-001', reason: 'The expectation quotes the org fact verbatim on purpose.' },
            ],
          }),
      },
    });
    const r = await revisePlan(ctx, { ids: ids(), router }, res.testCases, [finding], 'llm');
    // primary kept citing an unknown finding → reflected → fallback justified instead
    expect(r.justifications).toEqual([
      { findingId: 'RF-001', reason: 'The expectation quotes the org fact verbatim on purpose.' },
    ]);
    expect(r.testCases).toHaveLength(res.testCases.length);
    expect(buildRtm(ctx, r.testCases)).toHaveLength(requirements.length);
  });
});

describe('live-demo regressions (revise never loses coverage)', () => {
  it('a revision that removes the only case of an obligation is rejected and nothing changes', async () => {
    const res = await planTests(ctx, { ids: ids() }, 'mechanical');
    const victim = res.testCases.find((c) => c.refs.includes('AC2'));
    if (!victim) throw new Error('no AC2 case');
    const finding = {
      id: 'RF-001',
      key: 'dup:x',
      escalated: false,
      round: 1,
      severity: 'L' as const,
      rule: 'duplicate' as const,
      caseIds: [victim.id],
      requirementIds: victim.requirementIds,
      refs: [],
      text: 'looks like a duplicate',
      origin: 'deterministic' as const,
      status: 'OPEN' as const,
    };
    const remover = () =>
      JSON.stringify({
        cases: [],
        remove: res.testCases
          .filter((c) => c.obligationIds.some((o) => victim.obligationIds.includes(o)))
          .map((c) => c.id),
      });
    const router = await mockRouter({
      reasoning: { responder: remover },
      'reasoning:fallback': { responder: remover },
    });
    const r = await revisePlan(ctx, { ids: ids(), router }, res.testCases, [finding], 'llm');
    expect(r.testCases.map((c) => c.id).sort()).toEqual(res.testCases.map((c) => c.id).sort());
    expect(r.rejected?.some((x) => x.problems[0]?.startsWith('removal would leave'))).toBe(true);
    expect(r.changedFor).toEqual([]);
  });
});

describe('live-demo regressions (must-cite + persona)', () => {
  it('a step citing only the favourable section still carries the contesting org check', () => {
    const neg = obligations.find((o) => o.kind === 'negative' && o.mustCite.includes('OC-003'));
    if (!neg) throw new Error('no OC-003 obligation');
    const [c] = buildCases(
      ctx,
      [
        {
          key: 'k',
          title: 'Email is required',
          obligationIds: [neg.id],
          persona: 'system-admin',
          type: 'negative',
          technique: 'equivalence partitioning',
          preconditions: [],
          steps: [
            {
              action: 'Leave Email empty and Save',
              expected: 'The save is rejected',
              obligationId: neg.id,
              evidence: ['SF-219#AC3'],
            },
          ],
        },
      ],
      'planned',
      ids(),
    );
    expect(c?.steps[0]?.expected.evidenceIds).toContain('OC-003');
    expect(c?.steps[0]?.expected.evidenceLevel).toBe('UNKNOWN_OR_CONTRADICTORY');
    expect(c?.reviewStatus).toBe('REVIEW_REQUIRED');
  });

  it('an unavailable persona is rejected when the obligation does not require it', () => {
    const pos = obligations.find((o) => o.kind === 'positive' && o.ref === 'AC2');
    if (!pos) throw new Error('no AC2 obligation');
    const p = draftProblems(
      ctx,
      [
        {
          key: 'k',
          title: 'Last Name required',
          obligationIds: [pos.id],
          persona: 'read-only',
          type: 'functional',
          technique: 'use case',
          preconditions: [],
          steps: [
            {
              action: 'Save without Last Name',
              expected: 'The save is rejected',
              obligationId: pos.id,
              evidence: [pos.evidenceIds[0] ?? ''],
            },
          ],
        },
      ],
      [pos],
    );
    expect(p.some((m) => m.includes('has no test user') && m.includes('use "system-admin"'))).toBe(true);
  });
});

describe('revise accepts valid cases individually', () => {
  it('one invalid revised case does not discard a valid one', async () => {
    const res = await planTests(ctx, { ids: ids() }, 'mechanical');
    const a = res.testCases.find((c) => c.refs.includes('AC2') && c.type === 'functional');
    const b = res.testCases.find((c) => c.refs.includes('AC1'));
    if (!a || !b) throw new Error('cases missing');
    const obA = obligations.find((o) => o.id === a.obligationIds[0]);
    const finding = (id: string, caseId: string) => ({
      id,
      key: `vague:${caseId}`,
      escalated: false,
      round: 1,
      severity: 'M' as const,
      rule: 'vague-expectation' as const,
      caseIds: [caseId],
      requirementIds: [],
      refs: [],
      text: 'not observable',
      origin: 'deterministic' as const,
      status: 'OPEN' as const,
    });
    const draft = (key: string, obligationId: string, evidence: string, expected: string) => ({
      key,
      title: 'revised case title',
      obligationIds: [obligationId],
      persona: 'system-admin',
      type: 'functional',
      technique: 'use case',
      steps: [{ action: 'Leave Last Name empty and click Save', expected, obligationId, evidence: [evidence] }],
    });
    const responder = () =>
      JSON.stringify({
        cases: [
          draft(
            a.id,
            obA?.id ?? '',
            obA?.evidenceIds[0] ?? '',
            'The record is not saved and the Last Name field shows an error',
          ),
          draft(b.id, b.obligationIds[0] ?? '', 'SF-219#AC1', 'An error "Totally invented" appears'),
        ],
      });
    const router = await mockRouter({ reasoning: { responder } });
    const r = await revisePlan(
      ctx,
      { ids: ids(), router },
      res.testCases,
      [finding('RF-001', a.id), finding('RF-002', b.id)],
      'llm',
    );
    expect(r.changedFor).toEqual(['RF-001']);
    expect(r.rejected?.map((x) => x.key)).toEqual([b.id]);
    expect(r.testCases.find((c) => c.id === a.id)?.steps[0]?.expected.text).toMatch(/Last Name field shows an error/);
    expect(r.testCases.find((c) => c.id === b.id)?.steps).toEqual(b.steps);
  });
});
