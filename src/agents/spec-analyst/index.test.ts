import type { BaseMessage } from '@langchain/core/messages';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mockRouter } from '../../../tests/helpers/mockRouter.js';
import { QAError } from '../../core/errors.js';
import { AnalysisFinding, Clarification, Requirement, type ManualTestCase } from '../../core/schemas/index.js';
import { textDocument } from '../../inputs/adapters/text.js';
import { rowsToTests } from '../../inputs/adapters/manualTests.js';
import { messageText } from '../../models/secretGuard.js';
import { analyzeSpec, type SpecAnalystInput } from './graph.js';
import { RequirementIdStore } from './ids.js';
import { lintExistingTests, lintSources } from './lint.js';
import { RefIndex } from './refs.js';

// Synthetic domain (orders) — deliberately unrelated to the demo story.
const story = textDocument({
  sourceType: 'jira',
  ref: 'https://example.atlassian.net/browse/ORD-1',
  docId: 'ORD-1',
  text: [
    '**Summary:** Clerks create Orders',
    '',
    'As a Clerk I want to create Orders. A discount should probably apply.',
    '',
    'AC1 – Create',
    'Given I am a Clerk',
    'When I save an Order with a Customer',
    'Then the Order is saved',
    '',
    'AC2 – Quantity',
    'Given I enter Quantity 0',
    'Then an error is shown',
  ].join('\n'),
});
const rules = textDocument({
  sourceType: 'file',
  ref: 'C:/specs/order rules.pdf',
  text: [
    'Order Rules',
    'Document ID: ORS-2 Version 1.0',
    '1. Business rules',
    'OR-01 Quantity must be between 1 and 999.',
    'OR-02 Region must be one of the approved regions maintained by Ops.',
    'OR-03 Total__c updates immediately when a line changes.',
    '2. Non-functional requirements',
    'NFR-01: The Order page loads in under 2 seconds on the office network.',
  ].join('\n'),
});
const sheet = rowsToTests(
  [
    ['Test ID', 'Title', 'Requirement Ref', 'Persona', 'Steps', 'Expected Result', 'Last Run Status'],
    ['TC-1', 'Create order as clerk', 'AC1', 'Clerk', '1. New Order\n2. Save', 'Order saved', 'Pass'],
    ['TC-2', 'Fax is captured', '', 'Clerk', '1. Enter fax', 'Fax saved', 'Not Run'],
    ['TC-3', 'Create order with valid data as clerk', 'AC1', 'Clerk', '1. New Order\n2. Save', 'Order saved', 'Pass'],
    ['TC-4', 'Quantity range', 'OR-01', 'Clerk', '1. Enter 1000', 'Error', 'Fail'],
  ],
  { type: 'manual-test', ref: 'cases.xlsx', hash: 'h' },
  'Cases',
);
const tests: ManualTestCase[] = sheet.tests;
const docs = [story, rules, sheet.document];

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('deterministic lint', () => {
  const refs = new RefIndex(docs);
  it('flags vague wording, unspecified messages, external lists, timing, custom fields and NFR measurement', () => {
    const f = lintSources(docs, refs);
    const by = (rule: string): string[] => f.filter((x) => x.rule === rule).flatMap((x) => x.refs);
    expect(by('vague-wording')).toEqual(['S2']);
    expect(by('unspecified-message')).toEqual(['AC2']);
    expect(by('external-list')).toEqual(['OR-02']);
    expect(by('timing-mechanism')).toEqual(['OR-03']);
    expect(by('custom-component')).toEqual(['OR-03']);
    expect(by('nfr-measurement')).toEqual(['NFR-01']);
    for (const x of f) AnalysisFinding.parse(x);
  });

  it('flags unsupported, duplicate and failing tests and uncovered requirement sections', () => {
    const f = lintExistingTests(tests, docs, refs);
    const kinds = f.map((x) => `${x.kind}:${x.refs[0] ?? ''}`);
    expect(kinds).toContain('UNSUPPORTED_TEST:TC-2');
    expect(kinds).toContain('DUPLICATE_TEST:TC-3');
    expect(kinds).toContain('RISK_SIGNAL:TC-4');
    const gap = f.find((x) => x.kind === 'COVERAGE_GAP');
    expect(gap?.refs).toEqual(['AC2', 'OR-02', 'OR-03', 'NFR-01']);
  });
});

/** Mock model: routes by which Spec Analyst prompt it receives. */
function analystResponder(opts: { extract?: (i: number) => string; analyze?: (i: number) => string }) {
  let e = 0;
  let a = 0;
  return (msgs: BaseMessage[]): string => {
    const system = messageText(msgs[0] as BaseMessage);
    return system.includes('Turn the source documents into canonical')
      ? (opts.extract?.(e++) ?? '{}')
      : (opts.analyze?.(a++) ?? '{"findings":[],"questions":[]}');
  };
}

const draft = (key: string, sources: string[], over: Record<string, unknown> = {}) => ({
  key,
  title: `Requirement ${key}`,
  businessObjective: `Behaviour ${key}`,
  type: 'functional',
  personas: ['Clerk'],
  expectedOutcomes: ['the Order is saved'],
  expectedOutcomeClear: true,
  risk: 'HIGH',
  sources,
  ...over,
});
const extractOk = JSON.stringify({
  requirements: [
    draft('r1', ['ORD-1#AC1']),
    draft('r2', ['ORD-1#AC2', 'ORS-2#OR-01'], { type: 'validation', expectedOutcomes: ['an error is shown'] }),
    draft('r3', ['ORS-2#OR-02'], { type: 'validation', expectedOutcomes: ['only approved regions are accepted'] }),
    draft('r4', ['ORS-2#NFR-01'], {
      type: 'non-functional',
      expectedOutcomes: [],
      expectedOutcomeClear: false,
      reviewReason: 'no baseline',
    }),
  ],
});
const question = (n: number, refs: string[], ids: string[] = []) => ({
  question: `Question number ${n} about the order rules?`,
  refs,
  requirementIds: ids,
  testImpact: 'changes cases',
  proposedAssumption: 'assume the stricter rule',
  priority: n,
});

function input(over: Partial<SpecAnalystInput> = {}): SpecAnalystInput {
  return { key: 'ORD-1', sources: docs, existingTests: tests, clarifications: [], round: 1, mode: 'llm', ...over };
}

describe('analyzeSpec', () => {
  it('produces Zod-valid requirements with stable ids, real source refs and honest statuses', async () => {
    const analyze = JSON.stringify({
      findings: [
        {
          kind: 'CONFLICT',
          text: 'AC2 rejects 0 but OR-01 range wording differs',
          refs: ['ORD-1#AC2', 'ORS-2#OR-01'],
          requirementIds: ['ORD-1-R02'],
          severity: 'HIGH',
        },
      ],
      questions: [6, 1, 2, 3, 4, 5].map((n) => question(n, ['ORS-2#OR-02'])),
    });
    const router = await mockRouter({
      reasoning: { responder: analystResponder({ extract: () => extractOk, analyze: () => analyze }) },
    });
    const mem = mkdtempSync(join(tmpdir(), 'qa mem '));
    dirs.push(mem);
    const res = await analyzeSpec(input(), { router, ids: new RequirementIdStore('ORD-1', mem), maxQuestions: 5 });

    expect(res.environment).toBe('MOCK');
    const reqs = res.requirements.map((r) => Requirement.parse(r));
    expect(reqs.map((r) => r.id)).toEqual(['ORD-1-R01', 'ORD-1-R02', 'ORD-1-R03', 'ORD-1-R04']);
    expect(reqs[1]?.sources.map((s) => s.section)).toEqual(['AC2', 'OR-01']);
    expect(reqs[1]?.sources[1]?.hash).toBe(rules.source.hash);

    const status = Object.fromEntries(reqs.map((r) => [r.id, r.status]));
    expect(status).toEqual({
      'ORD-1-R01': 'EXECUTABLE',
      'ORD-1-R02': 'REVIEW_REQUIRED',
      'ORD-1-R03': 'REVIEW_REQUIRED',
      'ORD-1-R04': 'REVIEW_REQUIRED',
    });
    expect(reqs[1]?.reviewReasons.join(' ')).toMatch(/conflict/);
    expect(reqs[2]?.reviewReasons.join(' ')).toMatch(/open question Q1/);
    expect(reqs[3]?.reviewReasons).toContain('no expected outcome stated in the sources');

    expect(res.questions.map((q) => Clarification.parse(q).id)).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'Q5']);
    expect(res.questions[0]?.question).toContain('number 1');
    expect(res.questions[0]?.refs).toEqual(['OR-02']);
    expect(res.findings.some((f) => f.text.startsWith('Deferred question') && f.text.includes('number 6'))).toBe(true);
    expect(res.coverage.find((c) => c.requirementId === 'ORD-1-R01')?.coveredBy).toEqual(['TC-1', 'TC-3']);

    // Same sources again → same ids (stable across runs via .qa-memory).
    const again = await analyzeSpec(input(), { router, ids: new RequirementIdStore('ORD-1', mem), maxQuestions: 5 });
    expect(again.requirements.map((r) => r.id)).toEqual(reqs.map((r) => r.id));
  });

  it('a fabricated section ref or persona is reflected back and corrected (rule 12)', async () => {
    let reflection = '';
    const router = await mockRouter({
      reasoning: {
        responder: (msgs) => {
          const system = messageText(msgs[0] as BaseMessage);
          if (!system.includes('Turn the source documents')) return '{"findings":[],"questions":[]}';
          if (msgs.length === 2)
            return JSON.stringify({ requirements: [draft('r1', ['ORD-1#AC9'], { personas: ['Wizard'] })] });
          reflection = messageText(msgs.at(-1) as BaseMessage);
          return JSON.stringify({ requirements: [draft('r1', ['ORD-1#AC1'])] });
        },
      },
    });
    const res = await analyzeSpec(input({ existingTests: [] }), {
      router,
      ids: new RequirementIdStore('ORD-1'),
      maxQuestions: 5,
    });
    expect(reflection).toContain('cited section "ORD-1#AC9" does not exist');
    expect(reflection).toContain('persona "Wizard" is not named in any source');
    expect(res.requirements[0]?.sources[0]?.section).toBe('AC1');
  });

  it('extract that stays invalid throws INVALID_LLM_OUTPUT (QA Lead then degrades to the mechanical path)', async () => {
    const router = await mockRouter({
      reasoning: { responder: () => '{"requirements":[]}' },
      'reasoning:fallback': { responder: () => 'nope' },
    });
    const err = await analyzeSpec(input(), { router, ids: new RequirementIdStore('ORD-1'), maxQuestions: 5 }).catch(
      (e: unknown) => e,
    );
    expect((err as QAError).kind).toBe('INVALID_LLM_OUTPUT');
  });

  it('analyze failure keeps requirements + lint findings and reports a degraded step', async () => {
    const router = await mockRouter({
      reasoning: { responder: analystResponder({ extract: () => extractOk, analyze: () => 'garbage' }) },
      'reasoning:fallback': { responder: () => 'garbage' },
    });
    const res = await analyzeSpec(input(), { router, ids: new RequirementIdStore('ORD-1'), maxQuestions: 5 });
    expect(res.requirements).toHaveLength(4);
    expect(res.degraded[0]).toMatchObject({ step: 'analyze', kind: 'INVALID_LLM_OUTPUT' });
    expect(res.findings.every((f) => f.origin === 'lint')).toBe(true);
  });

  it('mechanical mode (no model): one REVIEW_REQUIRED requirement per AC/rule, Given/When/Then parsed, questions from blocking lint', async () => {
    const res = await analyzeSpec(input({ mode: 'mechanical' }), {
      ids: new RequirementIdStore('ORD-1'),
      maxQuestions: 5,
    });
    expect(res.environment).toBe('NONE');
    expect(res.requirements).toHaveLength(6);
    expect(res.requirements.every((r) => r.status === 'REVIEW_REQUIRED')).toBe(true);
    const ac1 = res.requirements.find((r) => r.sources[0]?.section === 'AC1');
    expect(ac1).toMatchObject({
      preconditions: ['I am a Clerk'],
      actions: ['I save an Order with a Customer'],
      expectedOutcomes: ['the Order is saved'],
    });
    expect(res.questions.length).toBeGreaterThanOrEqual(1);
    expect(res.questions.map((q) => q.refs[0])).toContain('OR-02');
  });

  it('round 2: answered clarifications are citable; assumed ones keep requirements REVIEW_REQUIRED and flagged', async () => {
    const clarifications: Clarification[] = [
      Clarification.parse({
        id: 'Q1',
        question: 'Which regions are approved?',
        refs: ['OR-02'],
        status: 'ANSWERED',
        answer: 'North and South only',
      }),
      Clarification.parse({
        id: 'Q2',
        question: 'Does the page time include login?',
        status: 'ASSUMED',
        assumption: 'Timed from click to form visible',
      }),
    ];
    const extract = JSON.stringify({
      requirements: [
        draft('a', ['ORS-2#OR-02', 'CLARIFICATIONS#Q1'], {
          expectedOutcomes: ['North and South are accepted; other regions rejected'],
        }),
        draft('b', ['ORS-2#NFR-01', 'CLARIFICATIONS#Q2'], {
          type: 'non-functional',
          expectedOutcomes: ['form visible within 2 s'],
        }),
      ],
    });
    const router = await mockRouter({ reasoning: { responder: analystResponder({ extract: () => extract }) } });
    const res = await analyzeSpec(input({ clarifications, round: 2, existingTests: [] }), {
      router,
      ids: new RequirementIdStore('ORD-1'),
      maxQuestions: 5,
    });
    const [a, b] = res.requirements;
    expect(a?.sources.map((s) => s.section)).toEqual(['OR-02', 'Q1']);
    expect(a?.status).toBe('EXECUTABLE'); // the human answer settles the external-list lint on OR-02
    expect(b?.status).toBe('REVIEW_REQUIRED');
    expect(b?.assumptions.known.join(' ')).toContain('ASSUMPTION (unconfirmed, Q2): Timed from click to form visible');
    expect(b?.reviewReasons.join(' ')).toContain('relies on unconfirmed assumption Q2');
  });
});
