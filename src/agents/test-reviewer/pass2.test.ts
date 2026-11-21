import { describe, expect, it } from 'vitest';
import type { DryRunReport } from '../../core/schemas/generation.js';
import { mockRouter } from '../../../tests/helpers/mockRouter.js';
import { CASE, GOOD_IR, generationContext } from '../../../tests/helpers/generationFixtures.js';
import { bindRecipe } from '../test-generator/context.js';
import { caseHash, type GeneratedSpec } from '../test-generator/graph.js';
import { hashText } from '../test-generator/pageObjects.js';
import { locatorsUsed, renderSkeleton, renderSpec, specPath } from '../test-generator/render.js';
import type { ToolchainResult } from '../test-generator/toolchain.js';
import { astViolations, pass2Findings, reviewPass2Round, settlePass2 } from './pass2.js';

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
