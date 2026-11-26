import { describe, expect, it } from 'vitest';
import { IrAction, IrAssertion, TestIR, ValueRefUnion } from '../../core/schemas/generation.js';
import { CASE, GOOD_IR, generationContext } from '../../../tests/helpers/generationFixtures.js';
import { bindRecipe, irProblems, normalizeIr } from './context.js';
import { generatorPrompt } from './graph.js';
import { IR_CONTRACT, relevantCatalog } from './promptParts.js';
import { renderSpec } from './render.js';

const literals = (u: { options: readonly { shape: Record<string, unknown> }[] }, key: string): string[] =>
  u.options.map((o) => (o.shape[key] as { value: string }).value);

describe('compact IR contract (prompt size, run-p4-coder-groq-1: 9.6k tokens > Groq 7–8k TPM)', () => {
  it('names every action, assertion and value kind the schema accepts (kept in sync with the Zod schema)', () => {
    // adopt stays in the schema for old IR files only: cleanup is code-owned and not offered to the model.
    for (const k of literals(IrAction, 'do').filter((x) => x !== 'adopt')) expect(IR_CONTRACT).toContain(`do: "${k}"`);
    for (const k of literals(IrAssertion, 'check')) expect(IR_CONTRACT).toContain(`"${k}"`);
    for (const k of literals(ValueRefUnion, 'kind')) expect(IR_CONTRACT).toContain(`kind: "${k}"`);
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
      /soqlNoRecord must look for a run-unique value this test typed/,
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

  it('a typed boundary-length value (run-unique) also proves "not saved" (run-p4-coder-nim-6, TC-004)', () => {
    const ir = structuredClone(GOOD_IR);
    const v81 = { kind: 'length' as const, length: 81, evidenceIds: ['SF-219#AC2'] };
    ir.steps[0]!.actions.splice(1, 0, { do: 'fill', element: 'contact-new.lastName', value: v81 });
    ir.steps[0]!.assertions.push({
      check: 'soqlNoRecord',
      object: 'Contact',
      field: 'LastName',
      value: v81,
      expect: ev,
    });
    const tc = {
      ...CASE,
      steps: [{ ...CASE.steps[0]!, action: 'Enter a Last Name with 81 characters and click Save' }, CASE.steps[1]!],
    };
    expect(irProblems(tc, ir, ctx, recipe)).toEqual([]);
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

describe('value shorthand without kind (run-p4-coder-nim-7, TC-003)', () => {
  it('maps {data, field} / {unique} / {length} to the canonical value; leaves unknown shapes to the schema', () => {
    const step = (value: unknown) => ({
      caseStep: 0,
      title: 'x step',
      actions: [{ do: 'fill', element: 'contact-new.firstName', value }],
    });
    const parse = (value: unknown) => TestIR.safeParse({ caseId: 'TC', steps: [step(value)] });
    const v = (value: unknown) => {
      const r = parse(value);
      const a = r.success ? r.data.steps[0]!.actions[0] : undefined;
      return a?.do === 'fill' ? a.value : undefined;
    };
    expect(v({ data: 'Contact', field: 'FirstName' })).toEqual({ kind: 'data', ref: 'Contact', field: 'FirstName' });
    expect(v({ unique: 'firstName' })).toEqual({ kind: 'unique', label: 'first-name', format: 'text' });
    expect(v({ length: 81 })).toEqual({ kind: 'length', length: 81, evidenceIds: [] });
    expect(parse({ text: 'Acme' }).success).toBe(false);
  });
});

describe('cleanup is code-owned (operator 2026-11-25: the model never writes cleanup)', () => {
  const ctx = generationContext();
  const recipe = bindRecipe(CASE, ctx);
  const v79 = { kind: 'length' as const, length: 79, evidenceIds: ['SF-219#AC2'] };
  const ev = { caseStep: 0, evidenceIds: ['SF-219#AC2'] };
  const tc = {
    ...CASE,
    steps: [
      { ...CASE.steps[0]!, action: 'Enter a Last Name with exactly 79 characters and click Save' },
      CASE.steps[1]!,
    ],
  };
  const saveStep = (assertions: TestIR['steps'][number]['assertions'], extra: IrAction[] = []): TestIR => {
    const ir = structuredClone(GOOD_IR);
    ir.steps[0] = {
      caseStep: 0,
      title: 'Save a 79-character Last Name',
      actions: [
        { do: 'openNewFromRelatedList', parentRef: 'Account', relatedList: 'Contacts' },
        { do: 'fill', element: 'contact-new.lastName', value: v79 },
        { do: 'click', element: 'contact-new.saveButton' },
        ...extra,
      ],
      assertions,
    };
    return ir;
  };

  it('after a create-dialog Save: toast, related list, header, SOQL by run tag — never a URL or record id', () => {
    const n = normalizeIr(saveStep([{ check: 'recordView', object: 'Contact', expect: ev }]), ctx, recipe, tc);
    expect(n.steps[0]!.assertions[0]).toMatchObject({ check: 'recordView', as: 'createdContact1' });
    expect(irProblems(tc, n, ctx, recipe)).toEqual([]);
    const text = renderSpec({ tc, ir: n, ctx, recipe, caseHash: 'h', irHash: 'h', model: 'm' });
    const order = [
      'await expectToast(page, len79);',
      'await expect(relatedListRecord(accountRecordPage.contactsRelatedList, len79)).toBeVisible();',
      "await data.adopt('createdContact1', 'Contact', 'LastName', len79);",
      'await relatedListRecord(accountRecordPage.contactsRelatedList, len79).click();',
      'await expectRecordTitle(page, len79);',
      "const saved = await data.tagged('Contact', { 'LastName': len79 }, ['LastName', 'Account.Name']);",
      "expect(saved[0]).toMatchObject({ 'LastName': len79, 'Account.Name': data.value('Account', 'Name') });",
    ].map((l) => text.indexOf(l));
    expect(order.every((x) => x >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).not.toMatch(/recordIdFromView|toHaveURL|adoptCreated|viewed\[/);
  });

  it('a case literal typed as the record name becomes run-unique; a parent id comparison becomes a name comparison', () => {
    const lit = { kind: 'literal' as const, value: 'TestContact', evidenceIds: ['SF-219#AC2'] };
    const ir = saveStep([
      { check: 'recordView', object: 'Contact', as: 'c', expect: ev },
      { check: 'recordTitle', contains: lit, expect: ev },
      {
        check: 'soqlField',
        ref: 'c',
        object: 'Contact',
        field: 'AccountId',
        equals: { kind: 'recordId', ref: 'Account' },
        expect: ev,
      },
    ]);
    ir.steps[0]!.actions[1] = { do: 'fill', element: 'contact-new.lastName', value: lit };
    const n = normalizeIr(ir, ctx, recipe, tc);
    expect(n.steps[0]!.actions[1]).toMatchObject({ value: { kind: 'unique', label: 'test-contact' } });
    // the model's own header check of the create step is replaced by the code-owned one (run-p5-build-1)
    expect(n.steps[0]!.assertions.map((a) => a.check)).toEqual(['recordView', 'soqlField']);
    expect(n.steps[0]!.assertions[1]).toMatchObject({
      field: 'Account.Name',
      equals: { kind: 'data', ref: 'Account', field: 'Name' },
    });
    expect(n.notes.join(' ')).toMatch(/run-unique \(label 'TestContact'\)/);
    // a record id comparison the normaliser cannot map is refused
    const raw = saveStep([
      {
        check: 'soqlField',
        ref: 'Account',
        object: 'Account',
        field: 'Id',
        equals: { kind: 'recordId', ref: 'Account' },
        expect: ev,
      },
    ]);
    expect(irProblems(tc, raw, ctx, recipe).join('\n')).toMatch(/never compare record ids/);
  });

  it('model-written adopts are removed; a Save with neither recordView nor a rejection assertion is a problem', () => {
    const withAdopt = saveStep(
      [{ check: 'recordView', object: 'Contact', as: 'c79', expect: ev }],
      [{ do: 'adopt', as: 'c79', object: 'Contact', field: 'LastName', value: v79 }],
    );
    const n = normalizeIr(withAdopt, ctx, recipe, tc);
    expect(n.steps[0]!.actions.some((a) => a.do === 'adopt')).toBe(false);
    expect(n.notes.join(' ')).toMatch(/adopt\(s\) removed — cleanup is code-owned/);
    expect(irProblems(tc, normalizeIr(saveStep([]), ctx, recipe, tc), ctx, recipe).join('\n')).toMatch(
      /after Save in the create dialog assert \{"check":"recordView"/,
    );
    const rejected = saveStep([{ check: 'fieldError', element: 'contact-new.lastName', expect: ev }]);
    expect(irProblems(tc, normalizeIr(rejected, ctx, recipe, tc), ctx, recipe)).toEqual([]);
  });

  it('the IR contract no longer offers adopt', () => {
    expect(IR_CONTRACT).not.toContain('do: "adopt"');
    expect(IR_CONTRACT).toMatch(/NEVER assert URLs or record ids/);
  });
});

describe('navigation shorthand rewritten by code (run-p4-build-decided-1)', () => {
  const ctx = generationContext();
  const recipe = bindRecipe(CASE, ctx);
  const withActions = (actions: IrAction[]): TestIR => {
    const ir = structuredClone(GOOD_IR);
    ir.steps[0]!.actions = actions;
    return ir;
  };

  it('click on the related list New button after opening the parent = openNewFromRelatedList; parent lookup fill dropped', () => {
    const n = normalizeIr(
      withActions([
        { do: 'openRecord', ref: 'Account', object: 'Account' },
        { do: 'click', element: 'account-record.contactsNewButton' },
        { do: 'fill', element: 'contact-new.accountId', value: { kind: 'data', ref: 'Account', field: 'Name' } },
        { do: 'click', element: 'contact-new.saveButton' },
      ]),
      ctx,
      recipe,
      CASE,
    );
    expect(n.steps[0]!.actions).toEqual([
      { do: 'openRecord', ref: 'Account', object: 'Account' },
      { do: 'openNewFromRelatedList', parentRef: 'Account', relatedList: 'Contacts' },
      { do: 'click', element: 'contact-new.saveButton' },
    ]);
    expect(n.notes.join(' ')).toMatch(/pre-fills it/);
    expect(irProblems(CASE, n, ctx, recipe)).toEqual([]);
  });

  it('leaves anything else to the checks: a New click with no record opened, a lookup filled with another record', () => {
    const lone = normalizeIr(withActions([{ do: 'click', element: 'account-record.contactsNewButton' }]), ctx, recipe);
    expect(lone.steps[0]!.actions).toEqual([{ do: 'click', element: 'account-record.contactsNewButton' }]);
    const other = normalizeIr(
      withActions([
        { do: 'openNewFromRelatedList', parentRef: 'Account', relatedList: 'Contacts' },
        { do: 'fill', element: 'contact-new.accountId', value: { kind: 'data', ref: 'OtherAccount', field: 'Name' } },
      ]),
      ctx,
      recipe,
    );
    expect(other.steps[0]!.actions).toHaveLength(2);
  });
});

describe('picklists: select (run-p4-build-decided-2: Lead Source = Web could not be expressed)', () => {
  const ctx = generationContext();
  const recipe = bindRecipe(CASE, ctx);
  const withActions = (actions: IrAction[]): TestIR => {
    const ir = structuredClone(GOOD_IR);
    ir.steps[0]!.actions = [
      { do: 'openNewFromRelatedList', parentRef: 'Account', relatedList: 'Contacts' },
      ...actions,
    ];
    return ir;
  };
  const web = { kind: 'literal' as const, value: 'Web', evidenceIds: [] };

  it('fill on a picklist combobox becomes select; an active snapshot value is grounded by the org; renders selectPicklist', () => {
    const n = normalizeIr(
      withActions([
        { do: 'fill', element: 'contact-new.leadSource', value: web },
        { do: 'click', element: 'contact-new.saveButton' },
      ]),
      ctx,
      recipe,
      CASE,
    );
    expect(n.steps[0]!.actions[1]).toMatchObject({ do: 'select', element: 'contact-new.leadSource' });
    expect(irProblems(CASE, n, ctx, recipe)).toEqual([]);
    const spec = renderSpec({ tc: CASE, ir: n, ctx, recipe, caseHash: 'h', irHash: 'h', model: 'm' });
    expect(spec).toContain("await selectPicklist(page, newContactDialog.leadSource, 'Web');");
    expect(spec).toMatch(/import \{[^}]*selectPicklist[^}]*\} from/);
  });

  it('rejects a value the picklist does not have and select on a non-picklist field', () => {
    const bad = withActions([
      { do: 'select', element: 'contact-new.leadSource', value: { ...web, value: 'Partner' } },
      { do: 'select', element: 'contact-new.lastName', value: web },
    ]);
    const problems = irProblems(CASE, normalizeIr(bad, ctx, recipe, CASE), ctx, recipe).join(' | ');
    expect(problems).toMatch(/"Partner" is not an active value of Contact\.LeadSource \(values: Web, Phone Inquiry\)/);
    expect(problems).toMatch(/contact-new\.lastName is not a picklist field/);
  });
});

describe('run-specific recipe values written as literals (run-p4-build-decided-3: TC-012, TC-051)', () => {
  it('a literal equal to a synthetic recipe value becomes a data ref; a plain literal is kept', () => {
    const ctx = generationContext();
    const recipe = bindRecipe(CASE, ctx);
    const name = String(recipe?.plan.steps.find((s) => s.stepId === 'Account')?.fields['Name']);
    expect(name).toContain(recipe?.plan.runId);
    const ir = structuredClone(GOOD_IR);
    ir.steps[0]!.assertions = [
      {
        check: 'relatedListHasRecord',
        parentRef: 'Account',
        relatedList: 'Contacts',
        name: { kind: 'literal', value: name, evidenceIds: [] },
        expect: { caseStep: 0, evidenceIds: ['SF-219#AC2'] },
      },
      {
        check: 'toast',
        contains: { kind: 'literal', value: 'Contact', evidenceIds: [] },
        expect: { caseStep: 0, evidenceIds: ['SF-219#AC2'] },
      },
    ];
    const n = normalizeIr(ir, ctx, recipe, CASE);
    expect(n.steps[0]!.assertions[0]).toMatchObject({ name: { kind: 'data', ref: 'Account', field: 'Name' } });
    expect(n.steps[0]!.assertions[1]).toMatchObject({ contains: { kind: 'literal', value: 'Contact' } });
  });
});

describe('expected error messages and pre-filled values come from org evidence (operator 2026-11-26)', () => {
  const ctx = generationContext();
  const recipe = bindRecipe(CASE, ctx);
  const ev = { caseStep: 0, evidenceIds: ['SF-219#AC2'] };
  const step = (assertions: TestIR['steps'][number]['assertions']): TestIR => {
    const ir = structuredClone(GOOD_IR);
    ir.steps = [
      {
        caseStep: 0,
        title: 'Check the dialog',
        actions: [{ do: 'openNewFromRelatedList', parentRef: 'Account', relatedList: 'Contacts' }],
        assertions,
      },
    ];
    return ir;
  };
  const tc = { ...CASE, steps: [CASE.steps[0]!] };
  const problems = (ir: TestIR): string => irProblems(tc, ir, ctx, recipe).join('\n');

  it('a fieldError message names a validation rule; code renders the rule text from the snapshot', () => {
    const ir = step([
      { check: 'fieldError', element: 'contact-new.phone', message: { rule: 'Phone_Must_Be_10_Digits' }, expect: ev },
    ]);
    expect(problems(ir)).not.toMatch(/Phone_Must_Be_10_Digits/);
    const text = renderSpec({ tc, ir, ctx, recipe, caseHash: 'h', irHash: 'h', model: 'm' });
    expect(text).toContain(
      "await expectFieldError(newContactDialog.phone, 'Enter a 10-digit phone number.'); // message of rule Contact.Phone_Must_Be_10_Digits (org snapshot)",
    );
  });

  it('an unknown rule, or a rule that shows its error on another field, is a problem (no invented text)', () => {
    expect(
      problems(step([{ check: 'fieldError', element: 'contact-new.phone', message: { rule: 'Made_Up' }, expect: ev }])),
    ).toMatch(/Contact\.Made_Up is not an active validation rule on Contact in the snapshot/);
    expect(
      problems(
        step([
          {
            check: 'fieldError',
            element: 'contact-new.lastName',
            message: { rule: 'Phone_Must_Be_10_Digits' },
            expect: ev,
          },
        ]),
      ),
    ).toMatch(/shows its message at the top of the form, not on LastName/);
    // the schema has no free-text message: a model-written message is dropped by parsing, never rendered
    const parsed = IrAssertion.parse({
      check: 'fieldError',
      element: 'contact-new.lastName',
      message: { rule: 'X', text: 'Complete this field.' },
      expect: ev,
    });
    expect(JSON.stringify(parsed)).not.toContain('Complete this field.');
  });

  it('inputValue reads a pre-filled lookup (toHaveValue) and a picklist (toContainText)', () => {
    const ir = step([
      {
        check: 'inputValue',
        element: 'contact-new.accountId',
        equals: { kind: 'data', ref: 'Account', field: 'Name' },
        expect: ev,
      },
      {
        check: 'inputValue',
        element: 'contact-new.leadSource',
        equals: { kind: 'literal', value: 'Web', evidenceIds: ['SF-219#AC2'] },
        expect: ev,
      },
    ]);
    expect(problems(ir)).not.toMatch(/accountId|leadSource|is not a page-object member/);
    const text = renderSpec({ tc, ir, ctx, recipe, caseHash: 'h', irHash: 'h', model: 'm' });
    expect(text).toContain("await expect(newContactDialog.accountId).toHaveValue(data.value('Account', 'Name'));");
    expect(text).toContain("await expect(newContactDialog.leadSource).toContainText('Web');");
  });
});

describe('record-page field values, duplicate expects (operator 2026-11-26)', () => {
  const ctx = generationContext();
  const recipe = bindRecipe(CASE, ctx);
  const ev = { caseStep: 0, evidenceIds: ['SF-219#AC2'] };
  const tc = { ...CASE, steps: [CASE.steps[0]!] };

  it('record pages get a <field>Field member per inline-edit button (the details list item holding it)', () => {
    const page = ctx.catalog.pages.find((p) => p.id === 'contact-record');
    const title = page?.members.find((m) => m.name === 'titleField');
    expect(title).toMatchObject({ role: 'listitem', fieldApiName: 'Contact.Title' });
    expect(title?.expression).toBe(
      "getByRole('main').getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Edit Title', exact: true }) })",
    );
  });

  it('recordField renders toContainText on the field item; locale-formatted types must use soqlField', () => {
    const ir = structuredClone(GOOD_IR);
    ir.data = [...new Set([...ir.data, 'Contact'])];
    ir.steps = [
      {
        caseStep: 0,
        title: 'Check the record page',
        actions: [{ do: 'openRecord', ref: 'Contact', object: 'Contact' }],
        assertions: [
          {
            check: 'recordField',
            element: 'contact-record.titleField',
            contains: { kind: 'data', ref: 'Contact', field: 'LastName' },
            expect: ev,
          },
        ],
      },
    ];
    expect(irProblems(tc, ir, ctx, recipe).join('\n')).not.toMatch(/recordField|titleField/);
    const text = renderSpec({ tc, ir, ctx, recipe, caseHash: 'h', irHash: 'h', model: 'm' });
    expect(text).toContain(
      "await expect(contactRecordPage.titleField).toContainText(data.value('Contact', 'LastName'));",
    );
    const phone = structuredClone(ir);
    phone.steps[0]!.assertions[0] = { ...ir.steps[0]!.assertions[0]!, element: 'contact-record.phoneField' } as never;
    expect(irProblems(tc, phone, ctx, recipe).join('\n')).toMatch(
      /Contact\.Phone is a phone field; the record page shows it locale-formatted — check it with soqlField instead/,
    );
  });

  it('an assertion identical to one already in the step is rendered once', () => {
    const ir = structuredClone(GOOD_IR);
    ir.steps = [
      {
        caseStep: 0,
        title: 'Open the dialog',
        actions: [{ do: 'openNewFromRelatedList', parentRef: 'Account', relatedList: 'Contacts' }],
        assertions: [{ check: 'visible', element: 'contact-new.root', expect: ev }],
      },
    ];
    const text = renderSpec({ tc, ir, ctx, recipe, caseHash: 'h', irHash: 'h', model: 'm' });
    expect(text.split('await expect(newContactDialog.root).toBeVisible();').length - 1).toBe(1);
  });
});

describe('accepted observed messages as assertion text (Phase 5)', () => {
  const ctx0 = generationContext();
  const recipe = bindRecipe(CASE, ctx0);
  const at = '2026-11-26T10:00:00.000Z';
  const base = {
    org: 'o',
    page: 'contact-new',
    persona: 'system-admin',
    snapshotId: 's',
    observedAt: at,
    runId: 'observe-8',
    environment: 'LIVE' as const,
  };
  const ctx = {
    ...ctx0,
    observedMessages: [
      {
        ...base,
        id: 'om-req',
        field: 'Contact.LastName',
        kind: 'required' as const,
        placement: 'field' as const,
        text: 'Complete this field.',
        accepted: { by: 'QA operator', at },
      },
      {
        ...base,
        id: 'om-dup',
        field: 'Contact.Email',
        kind: 'duplicate' as const,
        placement: 'alert' as const,
        text: 'Similar Records Exist This record looks like an existing record. View Duplicates',
        accepted: { by: 'QA operator', at },
      },
      {
        ...base,
        id: 'om-new',
        field: 'Contact.LastName',
        kind: 'required' as const,
        placement: 'field' as const,
        text: 'x',
      },
    ],
  };
  const ev = { caseStep: 0, evidenceIds: CASE.steps[0]!.expected.evidenceIds };
  const ir = (assertions: TestIR['steps'][number]['assertions']): TestIR => ({
    ...structuredClone(GOOD_IR),
    steps: [
      {
        caseStep: 0,
        title: 'Save',
        actions: [{ do: 'openNewFromRelatedList', parentRef: 'Account', relatedList: 'Contacts' }],
        assertions,
      },
    ],
  });

  it('renders the accepted text (never the text of the model) and refuses an unaccepted one', () => {
    const ok = ir([
      { check: 'fieldError', element: 'contact-new.lastName', message: { observed: 'om-req' }, expect: ev },
      { check: 'saveWarning', observed: 'om-dup', expect: ev },
    ]);
    expect(irProblems(CASE, ok, ctx, recipe).filter((x) => /observed|message/.test(x))).toEqual([]);
    const text = renderSpec({ tc: CASE, ir: ok, ctx, recipe, caseHash: 'h', irHash: 'h', model: 'm' });
    expect(text).toContain("await expectFieldError(newContactDialog.lastName, 'Complete this field.'); // observed on");
    expect(text).toContain(
      "await expectSavePopover(page, 'Similar Records Exist', 'This record looks like an existing record.');",
    );
    const bad = ir([
      { check: 'fieldError', element: 'contact-new.lastName', message: { observed: 'om-new' }, expect: ev },
    ]);
    expect(irProblems(CASE, bad, ctx, recipe).join(' ')).toMatch(/om-new is not accepted by a human yet/);
    const wrongField = ir([
      { check: 'fieldError', element: 'contact-new.lastName', message: { observed: 'om-dup' }, expect: ev },
    ]);
    expect(irProblems(CASE, wrongField, ctx, recipe).join(' ')).toMatch(/alert message, not field/);
  });
});

describe('records created in the UI (run-p5-build-1: TC-010, 036, 046, 050)', () => {
  const ctx0 = generationContext();
  const recipe = bindRecipe(CASE, ctx0);
  const at = '2026-11-26T10:00:00.000Z';
  const ctx = {
    ...ctx0,
    observedMessages: [
      {
        org: 'o',
        page: 'contact-new',
        persona: 'system-admin',
        snapshotId: 's',
        observedAt: at,
        runId: 'observe-8',
        environment: 'LIVE' as const,
        id: 'om-req',
        field: 'Contact.LastName',
        kind: 'required' as const,
        placement: 'field' as const,
        text: 'Complete this field.',
        accepted: { by: 'QA operator', at },
      },
    ],
  };
  const ev = { caseStep: 0, evidenceIds: CASE.steps[0]!.expected.evidenceIds };
  const ev1 = { caseStep: 1, evidenceIds: CASE.steps[1]!.expected.evidenceIds };
  const name = { kind: 'unique' as const, label: 'last-name', format: 'text' as const };
  const seedName = { kind: 'data' as const, ref: 'Contact', field: 'LastName' };
  const create = (caseStep: number, assertions: IrAssertion[]): TestIR['steps'][number] => ({
    caseStep,
    title: 'Create a Contact',
    actions: [
      { do: 'openNewFromRelatedList', parentRef: 'Account', relatedList: 'Contacts' },
      { do: 'fill', element: 'contact-new.lastName', value: name },
      { do: 'click', element: 'contact-new.saveButton' },
    ],
    assertions,
  });
  const withSteps = (steps: TestIR['steps']): TestIR => ({ ...structuredClone(GOOD_IR), steps });

  it("drops the model's toast / title / related-list checks of a create step and never lets 'as' shadow a recipe step", () => {
    const n = normalizeIr(
      withSteps([
        create(0, [
          { check: 'toast', contains: seedName, expect: ev },
          { check: 'relatedListHasRecord', parentRef: 'Account', relatedList: 'Contacts', name: seedName, expect: ev },
          { check: 'recordView', object: 'Contact', as: 'Contact', expect: ev },
          { check: 'recordTitle', contains: seedName, expect: ev },
          {
            check: 'soqlField',
            ref: 'Contact',
            object: 'Contact',
            field: 'Title',
            equals: { kind: 'literal', value: 'Director', evidenceIds: ['SF-219#AC2'] },
            expect: ev,
          },
        ]),
      ]),
      ctx,
      recipe,
      CASE,
    );
    const a = n.steps[0]!.assertions;
    expect(a.map((x) => x.check)).toEqual(['recordView', 'soqlField']);
    expect(a[0]).toMatchObject({ as: 'createdContact1' });
    expect(a[1]).toMatchObject({ ref: 'createdContact1' });
    expect(n.notes.join(' ')).toMatch(/3 toast \/ title \/ related-list check\(s\) replaced/);
    const text = renderSpec({ tc: CASE, ir: n, ctx, recipe, caseHash: 'h', irHash: 'h', model: 'm' });
    expect(text).not.toContain("data.value('Contact', 'LastName')");
  });

  it('a name reused after a record was created gets a suffix, also in a later "not saved" check', () => {
    const second = create(1, [
      { check: 'fieldError', element: 'contact-new.lastName', expect: ev1 },
      { check: 'soqlNoRecord', object: 'Contact', field: 'LastName', value: name, expect: ev1 },
    ]);
    const n = normalizeIr(
      withSteps([create(0, [{ check: 'recordView', object: 'Contact', expect: ev }]), second]),
      ctx,
      recipe,
      CASE,
    );
    expect(n.steps[0]!.actions[1]).toMatchObject({ value: { label: 'last-name' } });
    expect(n.steps[1]!.actions[1]).toMatchObject({ value: { label: 'last-name-2' } });
    expect(n.steps[1]!.assertions[1]).toMatchObject({ value: { label: 'last-name-2' } });
    // a Save that was rejected does not use the name up
    const rejectedFirst = normalizeIr(
      withSteps([create(0, [{ check: 'fieldError', element: 'contact-new.lastName', expect: ev }]), second]),
      ctx,
      recipe,
      CASE,
    );
    expect(rejectedFirst.steps[1]!.actions[1]).toMatchObject({ value: { label: 'last-name' } });
  });

  it('the only accepted message observed on a field without a validation rule is asserted', () => {
    const n = normalizeIr(
      withSteps([create(0, [{ check: 'fieldError', element: 'contact-new.lastName', expect: ev }])]),
      ctx,
      recipe,
      CASE,
    );
    expect(n.steps[0]!.assertions[0]).toMatchObject({ message: { observed: 'om-req' } });
    const none = normalizeIr(
      withSteps([create(0, [{ check: 'fieldError', element: 'contact-new.lastName', expect: ev }])]),
      ctx0,
      recipe,
      CASE,
    );
    expect(none.steps[0]!.assertions[0]).not.toHaveProperty('message');
  });

  it('a SOQL check on a recipe record of another object, or of a value against itself, targets the created record', () => {
    const later: TestIR['steps'][number] = {
      caseStep: 1,
      title: 'Verify by SOQL',
      actions: [],
      assertions: [
        {
          check: 'soqlField',
          ref: 'Account',
          object: 'Contact',
          field: 'Account.Name',
          equals: { kind: 'data', ref: 'Account', field: 'Name' },
          expect: ev1,
        },
        {
          check: 'soqlField',
          ref: 'Contact',
          object: 'Contact',
          field: 'LastName',
          equals: seedName,
          expect: ev1,
        },
      ],
    };
    const n = normalizeIr(
      withSteps([create(0, [{ check: 'recordView', object: 'Contact', expect: ev }]), later]),
      ctx,
      recipe,
      CASE,
    );
    expect(n.steps[1]!.assertions.map((a) => ('ref' in a ? a.ref : ''))).toEqual([
      'createdContact1',
      'createdContact1',
    ]);
    // without a created record it is refused
    expect(irProblems(CASE, withSteps([later]), ctx, recipe).join('\n')).toMatch(
      /Account is a Account record, not a Contact/,
    );
  });
});
