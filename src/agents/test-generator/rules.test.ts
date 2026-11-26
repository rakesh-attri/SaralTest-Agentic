// Operator rules 2026-11-26 (run-p5-live-5 failures made general):
// (1) generated values fit the field's length; (2) record fields / related lists are read through the page object's
// tab helper; (3) unique values are made at run time, one per created record, never fixed at build time.
import { describe, expect, it } from 'vitest';
import type { IrAssertion, TestIR } from '../../core/schemas/generation.js';
import { fitUnique } from '../../sf/data/unique.js';
import { CASE, GOOD_IR, generationContext } from '../../../tests/helpers/generationFixtures.js';
import { astViolations, tabReadViolations, valueRuleViolations } from '../test-reviewer/pass2.js';
import { bindRecipe, irProblems, normalizeIr } from './context.js';
import { renderPageObject } from './pageObjects.js';
import { renderSpec } from './render.js';

const ctx = generationContext();
const recipe = bindRecipe(CASE, ctx);
const ev = { caseStep: 0, evidenceIds: CASE.steps[0]!.expected.evidenceIds };
const ev1 = { caseStep: 1, evidenceIds: CASE.steps[1]!.expected.evidenceIds };
const ir = (steps: TestIR['steps']): TestIR => ({ ...structuredClone(GOOD_IR), steps });
const create = (
  caseStep: number,
  fills: { element: string; label: string; format?: 'text' | 'email' }[],
  assertions: IrAssertion[],
): TestIR['steps'][number] => ({
  caseStep,
  title: 'Create a Contact',
  actions: [
    { do: 'openNewFromRelatedList', parentRef: 'Account', relatedList: 'Contacts' },
    ...fills.map((f) => ({
      do: 'fill' as const,
      element: f.element,
      value: { kind: 'unique' as const, label: f.label, format: f.format ?? ('text' as const) },
    })),
    { do: 'click', element: 'contact-new.saveButton' },
  ],
  assertions,
});
const render = (x: TestIR): string =>
  renderSpec({ tc: CASE, ir: x, ctx, recipe, caseHash: 'h', irHash: 'h', model: 'm' });

describe('(1) values fit the field length', () => {
  it('fitUnique shortens the label, then drops it; the random token always stays', () => {
    const p = 'QA-run-p5-live-5-5394bc';
    expect(fitUnique(p, 'first-name', '24e6d6')).toBe(`${p}-first-name-24e6d6`); // 41 chars: no limit given
    const v40 = fitUnique(p, 'first-name', '24e6d6', 40);
    expect(v40.length).toBeLessThanOrEqual(40);
    expect(v40).toBe(`${p}-first-name-24e6d6`.length > 40 ? `${p}-first-nam-24e6d6` : v40);
    expect(fitUnique(p, 'first-name', '24e6d6', 31)).toBe(`${p}-24e6d6`);
    expect(fitUnique(p, 'x', '24e6d6', 12)).toBe('QA-ru-24e6d6');
    for (const n of [7, 12, 20, 31, 40]) expect(fitUnique(p, 'first-name', '24e6d6', n).length).toBeLessThanOrEqual(n);
  });

  it('the renderer passes the field length to data.unique; pass 2 refuses a unique without it', () => {
    const x = normalizeIr(
      ir([
        create(
          0,
          [{ element: 'contact-new.lastName', label: 'last-name' }],
          [{ check: 'recordView', object: 'Contact', expect: ev }],
        ),
      ]),
      ctx,
      recipe,
      CASE,
    );
    const len = ctx.facts.field('Contact', 'LastName')?.length;
    expect(len).toBeGreaterThan(0);
    const text = render(x);
    expect(text).toContain(`data.unique('last-name', 'text', ${String(len)})`);
    expect(valueRuleViolations(x, text, ctx)).toEqual([]);
    const unlimited = text.replace(`data.unique('last-name', 'text', ${String(len)})`, "data.unique('last-name')");
    expect(valueRuleViolations(x, unlimited, ctx).map((v) => v.rule)).toEqual(['field-length']);
  });
});

describe('(2) fields and related lists are read through the page object tab helper', () => {
  it('record page objects get fieldInDetails / listInRelated', () => {
    const rec = renderPageObject(
      ctx.catalog.pages.find((p) => p.id === 'account-record')!,
      ctx.catalog,
    );
    expect(rec).toContain('async listInRelated(list: Locator): Promise<Locator> {');
    expect(rec).toContain('await showRelatedList(list, this.relatedTab);');
  });

  it('pass 2 flags a raw field read and a related list read before it is opened', () => {
    expect(
      tabReadViolations('await expect(contactRecordPage.titleField).toContainText(x);', ctx.catalog).map((v) => v.rule),
    ).toEqual(['tab-unaware-read']);
    expect(
      tabReadViolations(
        'await expect(await contactRecordPage.fieldInDetails(contactRecordPage.titleField)).toContainText(x);',
        ctx.catalog,
      ),
    ).toEqual([]);
    expect(
      tabReadViolations(
        'await expect(relatedListRecord(accountRecordPage.contactsRelatedList, n)).toBeVisible();',
        ctx.catalog,
      ),
    ).toHaveLength(1);
    expect(
      tabReadViolations(
        'await accountRecordPage.listInRelated(accountRecordPage.contactsRelatedList);\nawait expect(relatedListRecord(accountRecordPage.contactsRelatedList, n)).toBeVisible();',
        ctx.catalog,
      ),
    ).toEqual([]);
  });

  it('a generated create test opens the related list through the helper before every read', () => {
    const x = normalizeIr(
      ir([
        create(
          0,
          [{ element: 'contact-new.lastName', label: 'last-name' }],
          [{ check: 'recordView', object: 'Contact', expect: ev }],
        ),
      ]),
      ctx,
      recipe,
      CASE,
    );
    const text = render(x);
    expect(text).not.toContain('showRelatedList(');
    expect(tabReadViolations(text, ctx.catalog)).toEqual([]);
  });
});

describe('(3) unique values: run time, one per created record', () => {
  it('a unique value (any field) reused by a second created record gets its own value — unless the step expects a duplicate warning', () => {
    const fills = [
      { element: 'contact-new.lastName', label: 'last-name' },
      { element: 'contact-new.firstName', label: 'mail' },
    ];
    const view = (e: typeof ev): IrAssertion => ({ check: 'recordView', object: 'Contact', expect: e });
    const n = normalizeIr(ir([create(0, fills, [view(ev)]), create(1, fills, [view(ev1)])]), ctx, recipe, CASE);
    const labels = (i: number): string[] =>
      n.steps[i]!.actions.flatMap((a) => (a.do === 'fill' && a.value.kind === 'unique' ? [a.value.label] : []));
    expect(labels(0)).toEqual(['last-name', 'mail']);
    expect(labels(1)).toEqual(['last-name-2', 'mail-2']);
    expect(valueRuleViolations(n, render(n), ctx).filter((v) => v.rule === 'shared-unique')).toEqual([]);
    // the duplicate-warning test keeps the shared email on purpose
    const dup = normalizeIr(
      ir([
        create(0, fills, [view(ev)]),
        create(1, fills, [{ check: 'saveWarning', observed: 'om-dup', expect: ev1 }, view(ev1)]),
      ]),
      ctx,
      recipe,
      CASE,
    );
    const dupMail = dup.steps[1]!.actions.find((a) => a.do === 'fill' && a.element === 'contact-new.firstName');
    expect(dupMail).toMatchObject({ value: { label: 'mail' } });
  });

  it('pass 2 flags two created records sharing a unique value', () => {
    const fills = [{ element: 'contact-new.lastName', label: 'last-name' }];
    const raw = ir([
      create(0, fills, [{ check: 'recordView', object: 'Contact', expect: ev }]),
      create(1, fills, [{ check: 'recordView', object: 'Contact', expect: ev1 }]),
    ]);
    expect(valueRuleViolations(raw, '', ctx).map((v) => v.rule)).toContain('shared-unique');
  });

  it('a record name that is a value, or reused, is renamed; later references follow it', () => {
    const fills = [{ element: 'contact-new.lastName', label: 'last-name' }];
    const n = normalizeIr(
      ir([
        create(0, fills, [{ check: 'recordView', object: 'Contact', as: 'QA-run-p5-build-2-1wbegpwv', expect: ev }]),
        create(1, fills, [
          { check: 'recordView', object: 'Contact', as: 'QA-run-p5-build-2-1wbegpwv', expect: ev1 },
          {
            check: 'soqlField',
            ref: 'QA-run-p5-build-2-1wbegpwv',
            object: 'Contact',
            field: 'LastName',
            equals: { kind: 'unique', label: 'last-name', format: 'text' },
            expect: ev1,
          },
        ]),
      ]),
      ctx,
      recipe,
      CASE,
    );
    const as = n.steps.map((s) => s.assertions.find((a) => a.check === 'recordView'));
    expect(as.map((a) => (a?.check === 'recordView' ? a.as : ''))).toEqual(['createdContact1', 'createdContact2']);
    expect(n.steps[1]!.assertions[1]).toMatchObject({ ref: 'createdContact2' });
    expect(render(n)).not.toMatch(/QA-run-/);
  });

  it('a run-specific literal is refused by the generator checks and by pass 2', () => {
    const bad = ir([
      {
        caseStep: 0,
        title: 'x',
        actions: [
          { do: 'openNewFromRelatedList', parentRef: 'Account', relatedList: 'Contacts' },
          {
            do: 'fill',
            element: 'contact-new.lastName',
            value: { kind: 'literal', value: 'QA-run-p5-build-2-abc', evidenceIds: ev.evidenceIds },
          },
        ],
        assertions: [],
      },
    ]);
    expect(irProblems(CASE, bad, ctx, recipe).join('\n')).toMatch(/is a run-specific value/);
    expect(
      astViolations("await data.adopt('QA-run-p5-build-2-1wbegpwv', 'Contact', 'LastName', x);").map((v) => v.rule),
    ).toEqual(['build-time-value']);
  });
});
