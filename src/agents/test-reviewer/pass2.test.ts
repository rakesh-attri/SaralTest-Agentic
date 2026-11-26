import { describe, expect, it } from 'vitest';
import type { DryRunReport } from '../../core/schemas/generation.js';
import type { ObservedMessage } from '../../core/schemas/execution.js';
import { mockRouter } from '../../../tests/helpers/mockRouter.js';
import { CASE, GOOD_IR, generationContext } from '../../../tests/helpers/generationFixtures.js';
import { bindRecipe } from '../test-generator/context.js';
import { caseHash, type GeneratedSpec } from '../test-generator/graph.js';
import { hashText } from '../test-generator/pageObjects.js';
import { locatorsUsed, renderSkeleton, renderSpec, specPath } from '../test-generator/render.js';
import type { ToolchainResult } from '../test-generator/toolchain.js';
import {
  astViolations,
  messageMismatches,
  pass2Findings,
  reviewPass2Round,
  settlePass2,
  unevidencedMessageSteps,
  observedForStep,
  withoutJudge,
} from './pass2.js';

const ctx = generationContext();
const recipe = bindRecipe(CASE, ctx);

function spec(ir = GOOD_IR): GeneratedSpec {
  const text = renderSpec({ tc: CASE, ir, ctx, recipe, caseHash: caseHash(CASE), irHash: 'h', model: 'mock' });
  const path = specPath('SF-219', CASE);
  return {
    caseId: CASE.id,
    path,
    text,
    ir,
    problems: [],
    model: 'mock/mock-flash',
    artifact: {
      kind: 'spec',
      path,
      hash: hashText(text),
      testCaseIds: [CASE.id],
      caseHash: caseHash(CASE),
      locatorsUsed: locatorsUsed(ir, ctx.catalog, recipe),
      dataBindings: ['account-contact'],
      origin: 'generated',
      reviewReasons: [],
    },
  };
}
const toolchain = (s: GeneratedSpec, extra: Partial<ToolchainResult> = {}): ToolchainResult => ({
  typecheck: { [s.path]: [] },
  lint: { [s.path]: [] },
  listed: { [s.path]: [`${CASE.id} ${CASE.title}`] },
  toolErrors: [],
  ...extra,
});
const dryRun = (s: GeneratedSpec, failing: string[] = []): DryRunReport => ({
  orgAlias: 'qa-prod',
  environment: 'LIVE',
  persona: 'system-admin',
  at: new Date().toISOString(),
  pageErrors: [],
  checks: s.artifact.locatorsUsed.map((e) => ({
    element: e,
    page: e.split('.')[0] ?? '',
    persona: 'system-admin',
    expression: 'x',
    count: failing.includes(e) ? 0 : 1,
    visible: !failing.includes(e),
    enabled: !failing.includes(e),
    ok: !failing.includes(e),
  })),
  ok: failing.length === 0,
});

describe('Test Reviewer pass 2: AST checks', () => {
  it('flags assertions under a condition, sleeps, raw fetch, raw page locators and .only', () => {
    const bad = [
      "test('x', async ({ page }) => {",
      '  if (await page.isVisible()) { await expect(a).toBeVisible(); }',
      '  await page.waitForTimeout(500);',
      "  await fetch('https://x');",
      "  await page.getByRole('button').click();",
      '});',
      "test.only('y', async () => {});",
    ].join('\n');
    const rules = astViolations(bad).map((v) => `${v.rule}:${v.text.replace(/^line \d+: /, '')}`);
    expect(rules).toEqual(
      expect.arrayContaining([
        'ast-violation:assertion inside a condition (may be skipped)',
        'ast-violation:fixed sleep (page.waitForTimeout)',
        'ast-violation:raw fetch',
        'raw-locator:raw locator page.getByRole(…) in a test — use a page object',
        'ast-violation:test.only must not be generated',
      ]),
    );
    expect(astViolations(spec().text)).toEqual([]);
  });
});

describe('Test Reviewer pass 2: checklist + settlement', () => {
  it('a clean, listed, dry-run-resolved spec is APPROVED', () => {
    const s = spec();
    const f = pass2Findings({ ctx, cases: [CASE], specs: [s], toolchain: toolchain(s), dryRun: dryRun(s) });
    expect(f).toEqual([]);
    expect(settlePass2([], [s]).artifacts[0]?.reviewStatus).toBe('APPROVED');
  });

  it('locators dry-run as another persona than the case persona → REVIEW_REQUIRED (unverified for that persona)', () => {
    const s = spec();
    const rep = { ...CASE, persona: 'sales-rep' };
    const f = pass2Findings({
      ctx: { ...ctx, personas: ['system-admin', 'sales-rep'] },
      cases: [rep],
      specs: [s],
      toolchain: toolchain(s),
      dryRun: dryRun(s),
    });
    expect(f.map((x) => [x.rule, x.severity, x.text])).toContainEqual([
      'locator-unresolved',
      'M',
      'locators were dry-run as system-admin, not as the case persona sales-rep: unverified for sales-rep',
    ]);
  });

  it('per-persona dry-runs: a case is checked against its own persona; a dry-run that could not start says why', () => {
    const s = spec();
    const rep = { ...CASE, persona: 'sales-rep' };
    const ctx2 = { ...ctx, personas: ['system-admin', 'sales-rep'] };
    const ok = { ...dryRun(s), persona: 'sales-rep' };
    const f1 = pass2Findings({
      ctx: ctx2,
      cases: [rep],
      specs: [s],
      toolchain: toolchain(s),
      dryRuns: [dryRun(s), ok],
    });
    expect(f1.filter((x) => x.rule === 'locator-unresolved')).toEqual([]);
    const failed = {
      ...dryRun(s),
      persona: 'sales-rep',
      checks: [],
      pageErrors: [{ page: '*', error: "sObject type 'Contact' is not supported." }],
      ok: false,
    };
    const f2 = pass2Findings({
      ctx: ctx2,
      cases: [rep],
      specs: [s],
      toolchain: toolchain(s),
      dryRuns: [dryRun(s), failed],
    });
    const texts = f2.filter((x) => x.rule === 'locator-unresolved').map((x) => x.text);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts[0]).toMatch(
      /did not resolve in the dry-run as sales-rep \(not checked: \*: sObject type 'Contact' is not supported\.\)/,
    );
  });

  it('typecheck / lint / not listed / unresolved locator → BLOCKED with reasons', async () => {
    const s = spec();
    const r = await reviewPass2Round(
      {
        ctx,
        cases: [CASE],
        specs: [s],
        toolchain: toolchain(s, { typecheck: { [s.path]: ['3:1 TS2304 Cannot find name'] }, listed: { [s.path]: [] } }),
        dryRun: dryRun(s, ['contact-new.lastName']),
        prior: [],
        round: 1,
        mode: 'mechanical',
      },
      {},
    );
    expect(r.findings.map((f) => f.rule).sort()).toEqual(['locator-unresolved', 'not-listed', 'typecheck']);
    const settled = settlePass2(r.findings, [s]);
    expect(settled.findings.every((f) => f.status !== 'OPEN')).toBe(true);
    expect(settled.artifacts[0]?.reviewStatus).toBe('BLOCKED');
    expect(settled.artifacts[0]?.reviewReasons.join(' ')).toMatch(/typecheck.*TS2304/);
  });

  it('a RE_VERIFY locator, no dry-run, or a mechanical skeleton → REVIEW_REQUIRED (never APPROVED)', () => {
    const ir = structuredClone(GOOD_IR);
    ir.steps[0]!.actions.push({
      do: 'fill',
      element: 'contact-new.phone',
      value: { kind: 'unique', label: 'phone', format: 'phone' },
    });
    const s = spec(ir);
    const f = pass2Findings({ ctx, cases: [CASE], specs: [s], toolchain: toolchain(s) });
    expect(f.map((x) => x.rule).sort()).toEqual(['locator-not-active', 'locator-unresolved']);
    expect(f.every((x) => x.severity === 'M')).toBe(true);
    const r = settlePass2(
      f.map((d, n) => ({
        ...d,
        id: `RF-00${n + 1}`,
        round: 1,
        origin: 'deterministic' as const,
        status: 'OPEN' as const,
        escalated: false,
        pass: 2 as const,
      })),
      [s],
    );
    expect(r.artifacts[0]?.reviewStatus).toBe('REVIEW_REQUIRED');

    const mech: GeneratedSpec = {
      ...s,
      ir: undefined,
      text: renderSkeleton(CASE, ctx, 'no model', 'h'),
      artifact: { ...s.artifact, origin: 'mechanical', locatorsUsed: [] },
      degradedReason: 'no model',
    };
    const mf = pass2Findings({ ctx, cases: [CASE], specs: [mech], toolchain: toolchain(mech), dryRun: dryRun(mech) });
    expect(mf.map((x) => x.rule)).toEqual(['mechanical']);
  });

  it('an unavailable persona blocks the spec; a missing spec for an APPROVED case is reported', () => {
    const s = spec();
    const f = pass2Findings({
      ctx: { ...ctx, personas: [] },
      cases: [CASE, { ...CASE, id: 'TC-SF-219-077' }],
      specs: [s],
      toolchain: toolchain(s),
      dryRun: dryRun(s),
    });
    expect(f.map((x) => x.rule).sort()).toEqual(['persona-unavailable', 'spec-missing']);
  });

  it('round 2 resolves findings that no longer reproduce; the judge finding is verified (mock judge, MOCK)', async () => {
    const broken = structuredClone(GOOD_IR);
    broken.steps[1]!.assertions = [];
    const s1 = spec(broken);
    let calls = 0;
    const router = await mockRouter({
      judge: {
        responder: (messages) => {
          calls++;
          if (calls === 1) {
            return JSON.stringify({
              findings: [
                {
                  severity: 'M',
                  caseIds: [CASE.id],
                  requirementIds: [],
                  topic: 'weakened',
                  text: 'step 1 does not check that the Contact was not saved',
                },
              ],
            });
          }
          const last = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join(' ');
          const id = /(RF-\d{3})/.exec(last)?.[1] ?? 'RF-999';
          return JSON.stringify({
            verdicts: [{ findingId: id, resolved: true, reason: 'the API rejection oracle now covers it' }],
          });
        },
      },
    });
    const r1 = await reviewPass2Round(
      {
        ctx,
        cases: [CASE],
        specs: [s1],
        toolchain: toolchain(s1),
        dryRun: dryRun(s1),
        prior: [],
        round: 1,
        mode: 'llm',
      },
      { router },
    );
    expect(r1.environment).toBe('MOCK');
    expect(r1.findings.filter((f) => f.origin === 'deterministic').map((f) => f.rule)).toContain('assertion-missing');
    expect(r1.findings.filter((f) => f.origin === 'judge')).toHaveLength(1);
    expect(r1.feedback[CASE.id]?.length).toBe(r1.findings.length); // all go back to the generator

    const s2 = spec(); // regenerated with the fix
    const r2 = await reviewPass2Round(
      {
        ctx,
        cases: [CASE],
        specs: [s2],
        toolchain: toolchain(s2),
        dryRun: dryRun(s2),
        prior: r1.findings,
        round: 2,
        mode: 'llm',
      },
      { router },
    );
    expect(r2.findings.every((f) => f.status === 'RESOLVED')).toBe(true);
    expect(r2.findings.find((f) => f.origin === 'judge')?.resolvedBy).toBe('judge');
    expect(r2.findings.filter((f) => f.origin === 'deterministic').every((f) => f.resolvedBy === 'recheck')).toBe(true);
    expect(settlePass2(r2.findings, [s2]).artifacts[0]?.reviewStatus).toBe('APPROVED');
  });
});

describe('judge outage (2026-11-25: NIM and Gemini both 503 for hours)', () => {
  const outage = () =>
    mockRouter({
      judge: {
        responder: () => {
          throw Object.assign(new Error('503 This model is currently experiencing high demand'), { status: 503 });
        },
      },
    });
  const input = (s: GeneratedSpec, transientDegrades?: boolean) => ({
    ctx,
    cases: [CASE],
    specs: [s],
    toolchain: toolchain(s),
    dryRun: dryRun(s),
    prior: [],
    round: 1,
    mode: 'llm' as const,
    ...(transientDegrades ? { transientDegrades } : {}),
  });

  it('graph mode: the TRANSIENT error reaches the QA Lead (retry); qa review: deterministic only, nothing APPROVED', async () => {
    const s = spec();
    await expect(reviewPass2Round(input(s), { router: await outage() })).rejects.toMatchObject({ kind: 'TRANSIENT' });
    const r = await reviewPass2Round(input(s, true), { router: await outage() });
    expect(r.judgeDegraded).toBe(true);
    const settled = settlePass2(r.findings, [s]);
    expect(settled.artifacts[0]?.reviewStatus).toBe('APPROVED');
    const [a] = withoutJudge(settled.artifacts);
    expect(a?.reviewStatus).toBe('REVIEW_REQUIRED');
    expect(a?.reviewReasons.join(' ')).toMatch(/judge unavailable/);
  });
});

describe('expected error text needs org evidence (operator 2026-11-26)', () => {
  const ev = { caseStep: 0, evidenceIds: ['SF-219#AC2'] };
  const tc = (expected: string): typeof CASE => ({
    ...CASE,
    steps: [{ ...CASE.steps[0]!, expected: { ...CASE.steps[0]!.expected, text: expected } }],
  });
  const ir = (message?: { rule: string }): typeof GOOD_IR => ({
    ...GOOD_IR,
    steps: [
      {
        caseStep: 0,
        title: 'Save',
        actions: [],
        assertions: [
          { check: 'fieldError', element: 'contact-new.phone', ...(message ? { message } : {}), expect: ev },
        ],
      },
    ],
  });

  it('a step that expects an error message but asserts no evidenced text is flagged', () => {
    const t = tc('Contact is not saved; error message is displayed on the Last Name field indicating it is required');
    expect(unevidencedMessageSteps(t, ir())).toEqual([0]);
    expect(unevidencedMessageSteps(t, ir({ rule: 'Phone_Must_Be_10_Digits' }))).toEqual([]);
    expect(unevidencedMessageSteps(tc("validation error 'Enter a 10-digit phone number.' is shown"), ir())).toEqual([
      0,
    ]);
    // a warning / "error … indicating" with no rule-evidenced text is held too (TC-050, TC-048)
    expect(
      unevidencedMessageSteps(
        tc('A possible duplicate warning is displayed indicating a Contact already exists'),
        ir(),
      ),
    ).toEqual([0]);
    expect(
      unevidencedMessageSteps(tc('an inline error appears on the Email field indicating the format is invalid'), ir()),
    ).toEqual([0]);
    // no message expected → presence-only is fine
    expect(unevidencedMessageSteps(tc('The Last Name field is marked invalid'), ir())).toEqual([]);
  });

  it('UI-observed texts evidence the message (OBSERVED), but an unasserted text keeps the spec in review', () => {
    const obs = (o: Partial<ObservedMessage>): ObservedMessage => ({
      id: 'om-1',
      org: 'o',
      page: 'contact-new',
      field: 'Contact.Phone',
      kind: 'validation',
      placement: 'field',
      text: 'Enter a valid phone.',
      persona: 'system-admin',
      snapshotId: 's',
      observedAt: '2026-11-26T10:00:00.000Z',
      runId: 'observe-1',
      environment: 'LIVE',
      ...o,
    });
    const c2 = {
      ...ctx,
      observedMessages: [
        obs({}),
        obs({ id: 'om-2', field: 'Contact.Email', text: 'other field' }),
        obs({ id: 'om-3', kind: 'duplicate', placement: 'alert', field: 'Contact.Email', text: 'Duplicate!' }),
      ],
    };
    const t = tc('an inline error message is displayed on the Phone field');
    expect(observedForStep(t, ir(), 0, c2).map((m) => m.text)).toEqual(['Enter a valid phone.']);
    expect(observedForStep(tc('A possible duplicate warning is displayed'), ir(), 0, c2).map((m) => m.text)).toEqual([
      'Duplicate!',
    ]);
    expect(observedForStep(t, ir(), 0, ctx)).toEqual([]);
    // a maximum-length expectation is never evidenced by another message (qa-prod truncates instead)
    expect(
      observedForStep(
        tc('error message is displayed on the Phone field indicating maximum length is exceeded'),
        ir(),
        0,
        c2,
      ),
    ).toEqual([]);
    const s = spec(ir());
    const f = pass2Findings({ ctx: c2, cases: [t], specs: [s], toolchain: toolchain(s), dryRun: dryRun(s) });
    expect(f.map((x) => x.rule)).toContain('message-unasserted');
    expect(f.map((x) => x.rule)).not.toContain('message-unevidenced');
    expect(f.find((x) => x.rule === 'message-unasserted')?.text).toMatch(
      /"Enter a valid phone\." \(OBSERVED 2026-11-26, observe-1\)/,
    );
  });
});

describe('case quote vs org rule message (operator 2026-11-26)', () => {
  it('flags a step that quotes a message other than the org rule text the spec asserts', () => {
    const ev = { caseStep: 0, evidenceIds: ['SF-219#AC2'] };
    const ir = {
      ...GOOD_IR,
      steps: [
        {
          caseStep: 0,
          title: 'Save',
          actions: [],
          assertions: [
            {
              check: 'fieldError' as const,
              element: 'contact-new.phone',
              message: { rule: 'Phone_Must_Be_10_Digits' },
              expect: ev,
            },
          ],
        },
      ],
    };
    const tc = (text: string): typeof CASE => ({
      ...CASE,
      steps: [{ ...CASE.steps[0]!, expected: { ...CASE.steps[0]!.expected, text } }],
    });
    expect(messageMismatches(tc("error 'Phone must be exactly 10 digits.' is shown"), ir, ctx)[0]?.text).toMatch(
      /quotes "Phone must be exactly 10 digits\." but Contact\.Phone_Must_Be_10_Digits says "Enter a 10-digit phone number\."/,
    );
    expect(messageMismatches(tc("error 'Enter a 10-digit phone number.' is shown"), ir, ctx)).toEqual([]);
  });
});

describe('no URL or record-id assertions (operator rule 2026-11-26)', () => {
  it('rejects URL checks, ids read from the URL, id comparisons and hard-coded ids; the after-Save pattern passes', () => {
    const bad = [
      "test('x', async ({ page, data, sf }) => {",
      "  viewed['c'] = await recordIdFromView(page, 'Contact');",
      "  await data.adoptCreated('c', 'Contact', viewed['c']);",
      String.raw`  await expect(page).toHaveURL(/\/lightning\/r\/Contact\/[a-zA-Z0-9]{15,18}\/view/);`,
      "  await expect.poll(() => soqlValue(sf, 'Contact', viewed['c'] ?? '', 'AccountId')).toBe(data.id('Account'));",
      "  expect(page.url()).toContain('003dN00000AbCd1');",
      '});',
    ].join('\n');
    const v = astViolations(bad).filter((x) => x.rule === 'dynamic-assertion');
    expect(v.map((x) => x.text).join('\n')).toMatch(/recordIdFromView reads the record id/);
    expect(v.map((x) => x.text).join('\n')).toMatch(/adoptCreated/);
    expect(v.map((x) => x.text).join('\n')).toMatch(/URL check \(expect\(page\)\.toHaveURL\)/);
    expect(v.map((x) => x.text).join('\n')).toMatch(/compares a record id \(data\.id\('Account'\)\)/);
    expect(v.map((x) => x.text).join('\n')).toMatch(/hard-coded record id '003dN00000AbCd1'/);
    const good = [
      "test('x', async ({ page, data }) => {",
      '  await expectToast(page, name);',
      '  await expect(relatedListRecord(list, name)).toBeVisible();',
      "  await data.adopt('c', 'Contact', 'LastName', name);",
      '  await relatedListRecord(list, name).click();',
      '  await expectRecordTitle(page, name);',
      "  const saved = await data.tagged('Contact', { LastName: name }, ['LastName', 'Account.Name']);",
      "  expect(saved[0]).toMatchObject({ LastName: name, 'Account.Name': data.value('Account', 'Name') });",
      '});',
    ].join('\n');
    expect(astViolations(good).filter((x) => x.rule === 'dynamic-assertion')).toEqual([]);
  });
});

describe('judge per spec (run-p5-build-1/2: one call for 7 specs timed out at 120 s)', () => {
  const OTHER = { ...CASE, id: 'TC-SF-219-999' };
  const s1 = spec();
  const s2: GeneratedSpec = {
    ...s1,
    caseId: OTHER.id,
    path: s1.path.replace(CASE.id, OTHER.id),
    artifact: { ...s1.artifact, path: s1.path.replace(CASE.id, OTHER.id), testCaseIds: [OTHER.id] },
  };
  const prompts: string[] = [];
  const router = () =>
    mockRouter({
      judge: {
        responder: (messages) => {
          const user = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
          prompts.push(user);
          if (user.includes(`### ${OTHER.id}`))
            throw Object.assign(new Error('judge model call timed out after 120000 ms'), { status: 503 });
          return '{"findings":[]}';
        },
      },
    });

  it('reviews one spec per call; an outage for one spec leaves only that spec unjudged', async () => {
    prompts.length = 0;
    const r = await reviewPass2Round(
      {
        ctx,
        cases: [CASE, OTHER],
        specs: [s1, s2],
        prior: [],
        round: 1,
        mode: 'llm',
        transientDegrades: true,
        judgeRetryMs: [0],
      },
      { router: await router() },
    );
    const withCase = prompts.filter((p) => p.includes(`### ${CASE.id}`));
    const withOther = prompts.filter((p) => p.includes(`### ${OTHER.id}`));
    expect(withCase.length).toBeGreaterThan(0);
    expect(withCase.every((p) => !p.includes(`### ${OTHER.id}`))).toBe(true);
    // the failing spec was retried (judgeRetryMs) before it was given up
    expect(withOther.length).toBeGreaterThan(withCase.length);
    expect(r.unjudged).toEqual([OTHER.id]);
    expect(r.judgeDegraded).toBe(true);
    const approved = [s1, s2].map((s) => ({ ...s.artifact, reviewStatus: 'APPROVED' as const }));
    const out = withoutJudge(approved, r.unjudged);
    expect(out.map((a) => a.reviewStatus)).toEqual(['APPROVED', 'REVIEW_REQUIRED']);
  });
});
