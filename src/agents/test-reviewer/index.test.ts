import { describe, expect, it } from 'vitest';
import type { BaseMessage } from '@langchain/core/messages';
import { EvidenceIndex } from '../../oracles/index.js';
import { assessRisks, deriveObligations, resolvePersona, tierObligations } from '../impact-risk/index.js';
import { ReviewFinding, type TestCase } from '../../core/schemas/index.js';
import {
  buildCases,
  mechanicalDrafts,
  planTests,
  TestCaseIdStore,
  type PlannerContext,
} from '../test-planner/index.js';
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
import { deterministicFindings, reviewRound, settleFindings } from './index.js';

const index = new EvidenceIndex({ docs, requirements, findings, clarifications, orgChecks, components, manualTests });
const configured = [{ id: 'system-admin', profile: 'System Administrator' }];
const risks = assessRisks({ requirements, index, orgChecks, manualTests });
const obligations = tierObligations(
  deriveObligations({
    requirements,
    index,
    orgChecks,
    components,
    manualTests,
    personas: configured,
    defaultPersona: 'system-admin',
  }),
  risks,
);
const ctx: PlannerContext = {
  storyKey: 'SF-219',
  requirements,
  obligations,
  risks,
  index,
  manualTests,
  personas: [
    resolvePersona('system-admin', configured),
    resolvePersona('Read Only User', configured, orgChecks),
    resolvePersona('Sales Manager', configured, orgChecks),
  ],
  defaultPersona: 'system-admin',
  snapshotId: SNAP,
  outOfScope: ['Contact import, merge and Lead conversion'],
};

const mechanical = async (): Promise<TestCase[]> =>
  (await planTests(ctx, { ids: new TestCaseIdStore('SF-219') }, 'mechanical')).testCases;
const rules = (cases: TestCase[]) => deterministicFindings(ctx, cases).map((f) => f.rule);
const text = (m: BaseMessage): string => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));

describe('deterministic rules', () => {
  it('a complete mechanical design only reports unused personas and unexecutable high risks', async () => {
    const r = rules(await mechanical());
    expect(r.filter((x) => !['persona-unused', 'high-risk-uncovered'].includes(x))).toEqual([]);
    expect(r).toContain('persona-unused'); // Sales Manager: no profile in the org
  });

  it('missing AC coverage, deny case and negative case are reported', async () => {
    const cases = await mechanical();
    const ac2 = obligations.find((o) => o.ref === 'AC2' && o.isAc);
    const noAc2 = deterministicFindings(
      ctx,
      cases.filter((c) => !c.obligationIds.includes(ac2?.id ?? '')),
    );
    expect(noAc2.find((f) => f.rule === 'ac-positive')?.severity).toBe('H');
    const noDeny = deterministicFindings(
      ctx,
      cases.filter((c) => c.persona !== 'read-only'),
    );
    expect(noDeny.some((f) => f.rule === 'deny-missing')).toBe(true);
    const noNegative = cases.filter((c) => !(c.requirementIds.includes('SF-219-R10') && c.type === 'negative'));
    const r = deterministicFindings(ctx, noNegative);
    expect(r.some((f) => f.rule === 'ac-negative' && f.requirementIds[0] === 'SF-219-R10')).toBe(true);
  });

  it('boundary values not exercised, vague and invented expectations, scope creep and duplicates are reported', async () => {
    const cases = await mechanical();
    const boundary = cases.find(
      (c) => c.technique === 'boundary value analysis' && c.requirementIds.includes('SF-219-R10'),
    );
    if (!boundary?.steps[0]) throw new Error('no boundary case');
    const broken: TestCase[] = cases.map((c) => {
      if (c.id !== boundary.id) return c;
      return {
        ...c,
        title: 'Merge two Contacts',
        steps: [
          {
            action: 'Enter 80 characters and save',
            expected: { ...boundary.steps[0]!.expected, text: 'It works correctly' },
          },
          { action: 'Save', expected: { ...boundary.steps[0]!.expected, text: 'Error "Name too long" appears' } },
        ],
      };
    });
    const dup = { ...broken[0]!, id: 'TC-DUP' };
    const r = deterministicFindings(ctx, [...broken, dup]);
    const got = new Set(r.map((f) => f.rule));
    for (const rule of ['boundary-values', 'vague-expectation', 'ungrounded-expectation', 'scope-creep', 'duplicate']) {
      expect(got.has(rule as never)).toBe(true);
    }
  });
});

describe('review rounds', () => {
  it('recheck resolves fixed deterministic findings; planner cannot justify an H finding that still reproduces', async () => {
    const cases = await mechanical();
    const missing = cases.filter((c) => c.persona !== 'read-only');
    const r1 = await reviewRound({ ctx, cases: missing, prior: [], round: 1, mode: 'mechanical' }, {});
    const deny = r1.findings.find((f) => f.rule === 'deny-missing');
    expect(deny?.status).toBe('OPEN');
    // still missing, planner "justifies" → stays OPEN (H deterministic)
    const r2 = await reviewRound(
      {
        ctx,
        cases: missing,
        prior: r1.findings,
        round: 2,
        mode: 'mechanical',
        justifications: [{ findingId: deny?.id ?? '', reason: 'we do not need a deny case' }],
      },
      {},
    );
    expect(r2.findings.find((f) => f.id === deny?.id)?.status).toBe('OPEN');
    // fixed → RESOLVED by recheck
    const r3 = await reviewRound({ ctx, cases, prior: r2.findings, round: 2, mode: 'mechanical' }, {});
    expect(r3.findings.find((f) => f.id === deny?.id)).toMatchObject({ status: 'RESOLVED', resolvedBy: 'recheck' });
    for (const f of r3.findings) expect(ReviewFinding.safeParse(f).success).toBe(true);
  });

  it('judge findings must cite existing ids; later rounds verify them', async () => {
    const cases = await mechanical();
    const first = cases[0]?.id ?? '';
    let call = 0;
    const router = await mockRouter({
      judge: {
        responder: (messages: BaseMessage[]) => {
          call++;
          const sys = messages.map(text).join(' ');
          if (sys.includes('re-checking your own earlier findings')) {
            const id = /(RF-\d{3}) \[/.exec(messages.map(text).join('\n'))?.[1] ?? '';
            return JSON.stringify({
              verdicts: [{ findingId: id, resolved: true, reason: 'expectation now names the field error' }],
            });
          }
          if (call === 1) {
            return JSON.stringify({
              findings: [
                {
                  severity: 'M',
                  caseIds: ['TC-NOPE'],
                  topic: 'observability',
                  text: 'This finding cites a case that does not exist at all',
                },
              ],
            });
          }
          return JSON.stringify({
            findings: [
              {
                severity: 'M',
                caseIds: [first],
                topic: 'observability',
                text: 'Expected result copies evidence instead of an observable outcome',
              },
            ],
          });
        },
      },
    });
    const r1 = await reviewRound({ ctx, cases, prior: [], round: 1, mode: 'llm' }, { router });
    const judge = r1.findings.filter((f) => f.origin === 'judge');
    expect(judge).toHaveLength(1);
    expect(judge[0]?.caseIds).toEqual([first]);
    expect(r1.environment).toBe('MOCK');
    const r2 = await reviewRound({ ctx, cases, prior: r1.findings, round: 2, mode: 'llm' }, { router });
    expect(r2.findings.find((f) => f.id === judge[0]?.id)).toMatchObject({ status: 'RESOLVED', resolvedBy: 'judge' });
  });
});

describe('settleFindings', () => {
  it('nothing stays OPEN; unresolved case findings escalate cases to REVIEW_REQUIRED', async () => {
    const cases = await mechanical();
    const approved = cases.find((c) => c.reviewStatus === 'APPROVED');
    const vague: TestCase[] = cases.map((c) =>
      c.id === approved?.id
        ? { ...c, steps: [{ ...c.steps[0]!, expected: { ...c.steps[0]!.expected, text: 'works correctly' } }] }
        : c,
    );
    const r = await reviewRound({ ctx, cases: vague, prior: [], round: 1, mode: 'mechanical' }, {});
    const s = settleFindings(ctx, r.findings, vague);
    expect(s.findings.every((f) => f.status !== 'OPEN')).toBe(true);
    const settled = s.cases.find((c) => c.id === approved?.id);
    expect(settled?.reviewStatus).toBe('REVIEW_REQUIRED');
    expect(settled?.reviewReasons.at(-1)).toMatch(/unresolved reviewer finding RF-\d{3} \(vague-expectation\)/);
    const persona = s.findings.find((f) => f.rule === 'persona-unused');
    expect(persona).toMatchObject({ status: 'JUSTIFIED', escalated: false });
    expect(persona?.resolution).toMatch(/Sales Manager|sales-manager/i);
    expect(s.findings.find((f) => f.rule === 'vague-expectation')?.escalated).toBe(true);
  });
});

describe('live-demo regressions (settlement)', () => {
  it('the QA Lead restores an obligation that lost all coverage instead of settling the gap', async () => {
    const cases = await mechanical();
    const ac2 = obligations.find((o) => o.ref === 'AC2' && o.isAc);
    const without = cases.filter((c) => !c.obligationIds.includes(ac2?.id ?? ''));
    const r = await reviewRound({ ctx, cases: without, prior: [], round: 2, mode: 'mechanical' }, {});
    const gap = r.findings.find((f) => f.key === `uncovered:${ac2?.id ?? ''}`);
    expect(gap?.status).toBe('OPEN');
    const restoreIds = new TestCaseIdStore('SF-219');
    const s = settleFindings(ctx, r.findings, without, (ids) =>
      buildCases(
        ctx,
        mechanicalDrafts(
          ctx,
          ctx.obligations.filter((o) => ids.includes(o.id)),
        ),
        'mechanical',
        restoreIds,
      ),
    );
    expect(s.cases.some((c) => c.obligationIds.includes(ac2?.id ?? ''))).toBe(true);
    expect(s.findings.find((f) => f.id === gap?.id)).toMatchObject({ status: 'RESOLVED', resolvedBy: 'qa-lead' });
  });
});

describe('live-demo regressions (restated rules are vague)', () => {
  it('"the system enforces the requirement as per business rule" is flagged', async () => {
    const cases = await mechanical();
    const c0 = cases[0]!;
    const changed = [
      {
        ...c0,
        steps: [
          {
            ...c0.steps[0]!,
            expected: { ...c0.steps[0]!.expected, text: 'The system enforces the requirement as per business rule' },
          },
        ],
      },
      ...cases.slice(1),
    ];
    expect(
      deterministicFindings(ctx, changed).some((f) => f.rule === 'vague-expectation' && f.caseIds[0] === c0.id),
    ).toBe(true);
  });
});

describe('boundary values as input lengths', () => {
  it("'123456789' / '1234567890' / '12345678901' exercise a 9 / 10 / 11 digit boundary", async () => {
    const cases = await mechanical();
    const phone = obligations.find((o) => o.kind === 'boundary' && o.values.join() === '9,10,11');
    const c = cases.find((x) => phone && x.obligationIds.includes(phone.id));
    if (!c || !phone) throw new Error('no phone boundary case');
    const step = c.steps[0]!;
    const changed = cases.map((x) =>
      x.id === c.id
        ? {
            ...x,
            steps: ["'123456789'", "'1234567890'", "'12345678901'"].map((v) => ({
              ...step,
              action: `Enter ${v} in Phone and click Save`,
            })),
          }
        : x,
    );
    expect(
      deterministicFindings(ctx, changed).some((f) => f.rule === 'boundary-values' && f.caseIds.includes(c.id)),
    ).toBe(false);
  });
});
