import { describe, expect, it } from 'vitest';
import { IrAction, IrAssertion, TestIR, ValueRef } from '../../core/schemas/generation.js';
import { CASE, GOOD_IR, generationContext } from '../../../tests/helpers/generationFixtures.js';
import { bindRecipe, irProblems, normalizeIr } from './context.js';
import { generatorPrompt } from './graph.js';
import { IR_CONTRACT, relevantCatalog } from './promptParts.js';
import { renderSpec } from './render.js';

const literals = (u: { options: readonly { shape: Record<string, unknown> }[] }, key: string): string[] =>
  u.options.map((o) => (o.shape[key] as { value: string }).value);

describe('compact IR contract (prompt size, run-p4-coder-groq-1: 9.6k tokens > Groq 7–8k TPM)', () => {
  it('names every action, assertion and value kind the schema accepts (kept in sync with the Zod schema)', () => {
    for (const k of literals(IrAction, 'do')) expect(IR_CONTRACT).toContain(`do: "${k}"`);
    for (const k of literals(IrAssertion, 'check')) expect(IR_CONTRACT).toContain(`"${k}"`);
    for (const k of literals(ValueRef, 'kind')) expect(IR_CONTRACT).toContain(`kind: "${k}"`);
    expect(IR_CONTRACT.length).toBeLessThan(4000);
  });

  it('the per-case catalog keeps what the case needs; an a11y case keeps every dialog field', () => {
    const ctx = generationContext();
    const recipe = bindRecipe(CASE, ctx);
    const pages = relevantCatalog(ctx, CASE, recipe);
    const refs = pages.flatMap((p) => p.members.map((m) => m.ref));
    expect(refs).toEqual(
      expect.arrayContaining([
        'contact-new.lastName',
        'contact-new.saveButton',
        'account-record.contactsNewButton',
        'contact-new.root',
      ]),
    );
    const a11y = relevantCatalog(ctx, { ...CASE, type: 'a11y' }, recipe);
    const dialogFields = ctx.catalog.pages
      .find((p) => p.id === 'contact-new')!
      .members.filter((m) => m.role === 'textbox');
    expect(a11y.find((p) => p.id === 'contact-new')!.members.filter((m) => m.role === 'textbox')).toHaveLength(
      dialogFields.length,
    );
    const { system, user } = generatorPrompt(ctx, CASE, recipe);
    expect(system.length + user.length).toBeLessThan(12_000);
  });
});

describe('normalizeIr (meaning-preserving; NIM answers, run-p4-coder-nim-1)', () => {
  const ctx = generationContext();
  const recipe = bindRecipe(CASE, ctx);

  it('maps page-style record refs to the recipe step of that object and kebab-cases labels', () => {
    const ir = structuredClone(GOOD_IR);
    ir.steps[0]!.actions[0] = {
      do: 'openNewFromRelatedList',
      parentRef: 'account-record.root',
      relatedList: 'contactsRelatedList',
    };
    ir.data = ['account-record'];
    const n = normalizeIr(ir, ctx, recipe);
    expect(n.data).toEqual(['Account']);
    expect(n.steps[0]!.actions[0]).toMatchObject({ parentRef: 'Account', relatedList: 'Contacts' });
    expect(irProblems(CASE, n, ctx, recipe)).toEqual([]);
    const parsed = TestIR.parse({
      ...GOOD_IR,
      steps: [
        {
          ...GOOD_IR.steps[0],
          actions: [
            { do: 'fill', element: 'contact-new.firstName', value: { kind: 'unique', label: 'contactFirstName' } },
          ],
        },
      ],
    });
    const a = parsed.steps[0]!.actions[0];
    expect(a?.do === 'fill' && a.value.kind === 'unique' ? a.value.label : '').toBe('contact-first-name');
  });

  it('leaves ambiguous refs alone so the checks still reject them', () => {
    const ir = structuredClone(GOOD_IR);
    ir.steps[0]!.actions[0] = { do: 'openNewFromRelatedList', parentRef: 'somewhere', relatedList: 'Contacts' };
    expect(irProblems(CASE, normalizeIr(ir, ctx, recipe), ctx, recipe).join('\n')).toMatch(
      /record somewhere is not created/,
    );
  });
});

describe('normalizeIr: omitted evidence (NIM, run-p4-coder-nim-3, TC-003)', () => {
  it('fills omitted evidence with the case step’s own evidence; never cites anything new', () => {
    const ctx = generationContext();
    const recipe = bindRecipe(CASE, ctx);
    const ir = structuredClone(GOOD_IR);
    ir.steps[0]!.assertions[0]!.expect.evidenceIds = [];
    ir.steps[0]!.assertions.push({
      check: 'toast',
      contains: { kind: 'literal', value: 'Last Name', evidenceIds: [] },
      expect: { caseStep: 0, evidenceIds: [] },
    });
    const n = normalizeIr(ir, ctx, recipe, CASE);
    expect(n.steps[0]!.assertions[0]!.expect.evidenceIds).toEqual(['SF-219#AC2']);
    const t = n.steps[0]!.assertions[2];
    expect(t?.check === 'toast' && t.contains?.kind === 'literal' ? t.contains.evidenceIds : []).toEqual([
      'SF-219#AC2',
    ]);
    expect(irProblems(CASE, n, ctx, recipe)).toEqual([]);
    // Without the case (no source of evidence) the check still rejects it.
    expect(irProblems(CASE, normalizeIr(ir, ctx, recipe), ctx, recipe).join('\n')).toMatch(/cites no evidence/);
  });
});

describe('oracle checks from run-p4-coder-nim-4 (judge findings made deterministic)', () => {
  const ctx = generationContext();
  const recipe = bindRecipe(CASE, ctx);
  const ev = { caseStep: 0, evidenceIds: ['SF-219#AC2'] };

  it('soqlNoRecord must use a unique value the test typed (recipe values may already exist)', () => {
    const ir = structuredClone(GOOD_IR);
    ir.data = ['Account', 'Contact'];
    ir.steps[0]!.assertions.push({
      check: 'soqlNoRecord',
      object: 'Contact',
      field: 'FirstName',
      value: { kind: 'data', ref: 'Contact', field: 'FirstName' },
      expect: ev,
    });
    expect(irProblems(CASE, ir, ctx, recipe).join('\n')).toMatch(
      /soqlNoRecord must look for a unique value this test typed/,
    );
    const ok = structuredClone(GOOD_IR);
    ok.steps[0]!.actions.splice(1, 0, {
      do: 'fill',
      element: 'contact-new.firstName',
      value: { kind: 'unique', label: 'first', format: 'text' },
    });
    ok.steps[0]!.assertions.push({
      check: 'soqlNoRecord',
      object: 'Contact',
      field: 'FirstName',
      value: { kind: 'unique', label: 'first', format: 'text' },
      expect: ev,
    });
    expect(irProblems(CASE, ok, ctx, recipe)).toEqual([]);
  });

  it('a typed value is checked on the record the test created, not on a recipe record', () => {
    const ir = structuredClone(GOOD_IR);
    ir.data = ['Account', 'Contact'];
    ir.steps[0]!.assertions.push({
      check: 'soqlField',
      ref: 'Contact',
      object: 'Contact',
      field: 'LastName',
      equals: { kind: 'length', length: 80, evidenceIds: ['SF-219#AC2'] },
      expect: ev,
    });
    expect(irProblems(CASE, ir, ctx, recipe).join('\n')).toMatch(
      /Contact is a recipe record; the value the test typed is on the record it created/,
    );
  });

  it('a spec without assertions through expect does not import it (unused import fails lint)', () => {
    const ir = structuredClone(GOOD_IR);
    ir.steps = [
      {
        caseStep: 0,
        title: 'Only a field error',
        actions: [{ do: 'openNewFromRelatedList', parentRef: 'Account', relatedList: 'Contacts' }],
        assertions: [{ check: 'fieldError', element: 'contact-new.lastName', expect: ev }],
      },
    ];
    const text = renderSpec({
      tc: { ...CASE, steps: [CASE.steps[0]!] },
      ir,
      ctx,
      recipe,
      caseHash: 'h',
      irHash: 'h',
      model: 'm',
    });
    expect(text).toContain("import { test, expect } from '../../fixtures/index.js';"); // toBeVisible in openNewFromRelatedList
    const apiOnly = structuredClone(GOOD_IR);
    apiOnly.steps = [
      { caseStep: 0, title: 'Adopt only', actions: [{ do: 'apiUpdate', ref: 'Account', fields: {} }], assertions: [] },
    ];
    expect(renderSpec({ tc: CASE, ir: apiOnly, ctx, recipe, caseHash: 'h', irHash: 'h', model: 'm' })).toContain(
      "import { test } from '../../fixtures/index.js';",
    );
  });
});
