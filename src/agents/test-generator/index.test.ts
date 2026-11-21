import { describe, expect, it } from 'vitest';
import type { TestIR } from '../../core/schemas/generation.js';
import type { TestCase } from '../../core/schemas/testCase.js';
import { mockRouter } from '../../../tests/helpers/mockRouter.js';
import { CASE, GOOD_IR, generationContext } from '../../../tests/helpers/generationFixtures.js';
import { bindRecipe, derivableErrorCodes, irProblems } from './context.js';
import { caseHash, generateTests } from './graph.js';
import { renderSpec, specPath } from './render.js';

const clone = <T>(v: T): T => structuredClone(v);

describe('Test Generator: deterministic IR checks', () => {
  const ctx = generationContext();
  const recipe = bindRecipe(CASE, ctx);

  it('binds the approved recipe whose objects cover the case', () => {
    expect(recipe?.name).toBe('account-contact');
    expect(
      bindRecipe(
        {
          ...CASE,
          title: 'x',
          preconditions: [],
          steps: CASE.steps.map((s) => ({ ...s, action: 'y', expected: { ...s.expected, text: 'z' } })),
        },
        ctx,
      ),
    ).toBeUndefined();
  });

  it('accepts an IR that implements and asserts every step with the case evidence', () => {
    expect(irProblems(CASE, GOOD_IR, ctx, recipe)).toEqual([]);
  });

  it('flags a missing assertion, foreign evidence, unknown elements, invented literals and guessed error codes', () => {
    const ir = clone(GOOD_IR);
    ir.steps[1]!.assertions = [];
    expect(irProblems(CASE, ir, ctx, recipe).join('\n')).toMatch(/case step 2: expected result .* has no assertion/);

    const foreign = clone(GOOD_IR);
    foreign.steps[0]!.assertions[0]!.expect.evidenceIds = ['BRD-CON-012#BR-99'];
    expect(irProblems(CASE, foreign, ctx, recipe).join('\n')).toMatch(/evidence BRD-CON-012#BR-99 is not cited/);

    const raw = clone(GOOD_IR);
    raw.steps[0]!.actions[1] = { do: 'click', element: 'contact-new.saveAndNewButton' };
    expect(irProblems(CASE, raw, ctx, recipe).join('\n')).toMatch(/not a page-object member/);

    const invented = clone(GOOD_IR);
    invented.steps[0]!.assertions.push({
      check: 'toast',
      contains: {
        kind: 'literal',
        value: 'These required fields must be completed: Last Name',
        evidenceIds: ['SF-219#AC2'],
      },
      expect: { caseStep: 0, evidenceIds: ['SF-219#AC2'] },
    });
    expect(irProblems(CASE, invented, ctx, recipe).join('\n')).toMatch(/never invent values/);

    const guessed = clone(GOOD_IR);
    const a = guessed.steps[1]!.assertions[0]!;
    if (a.check === 'apiRejects') a.errorCodes = ['DUPLICATES_DETECTED'];
    expect(irProblems(CASE, guessed, ctx, recipe).join('\n')).toMatch(/not derivable from metadata/);

    const missingStep: TestIR = { ...clone(GOOD_IR), steps: [clone(GOOD_IR.steps[0]!)] };
    expect(irProblems(CASE, missingStep, ctx, recipe).join('\n')).toMatch(/case step 2 .* has no IR step/);
  });

  it('error codes for API oracles come from metadata only', () => {
    expect(derivableErrorCodes(ctx.facts, 'Contact', {}, ['LastName'])).toEqual(['REQUIRED_FIELD_MISSING']);
    expect(derivableErrorCodes(ctx.facts, 'Contact', { LastName: { length: 81 } }, [])).toEqual(['STRING_TOO_LONG']);
    expect(derivableErrorCodes(ctx.facts, 'Contact', { Phone: {} }, [])).toEqual(['FIELD_CUSTOM_VALIDATION_EXCEPTION']);
    expect(derivableErrorCodes(ctx.facts, 'Contact', {}, ['FirstName'])).toEqual([]);
  });

  it('a length must be stated in the case step (boundary values are never guessed)', () => {
    const boundary: TestCase = {
      ...CASE,
      steps: [
        {
          action: 'Enter a Last Name with exactly 80 characters (maximum length) and click Save',
          expected: {
            text: 'The Contact is successfully created',
            evidenceLevel: 'DECLARED_CONFIG',
            evidenceIds: ['Field:Contact.LastName'],
          },
        },
      ],
    };
    const ir = (n: number): TestIR => ({
      caseId: CASE.id,
      data: ['Account'],
      steps: [
        {
          caseStep: 0,
          title: 'Save with a long Last Name',
          actions: [
            { do: 'openNewFromRelatedList', parentRef: 'Account', relatedList: 'Contacts' },
            {
              do: 'fill',
              element: 'contact-new.lastName',
              value: { kind: 'length', length: n, evidenceIds: ['Field:Contact.LastName'] },
            },
          ],
          assertions: [
            {
              check: 'hidden',
              element: 'contact-new.root',
              expect: { caseStep: 0, evidenceIds: ['Field:Contact.LastName'] },
            },
          ],
        },
      ],
      notes: [],
    });
    expect(irProblems(boundary, ir(80), ctx, recipe)).toEqual([]);
    expect(irProblems(boundary, ir(81), ctx, recipe).join('\n')).toMatch(/length 81 is not stated/);
  });
});

describe('Test Generator: rendering', () => {
  const ctx = generationContext();
  it('renders the skill template: fixtures import, meta, tags, test.step per IR step, page objects, data + API oracle', () => {
    const text = renderSpec({
      tc: CASE,
      ir: GOOD_IR,
      ctx,
      recipe: bindRecipe(CASE, ctx),
      caseHash: caseHash(CASE),
      irHash: 'h',
      model: 'mock/x',
    });
    expect(text).toContain("import { test, expect } from '../../fixtures/index.js';");
    expect(text).toContain("import { meta } from 'reporting-labs';");
    expect(text).toContain("import { NewContactDialog } from '../../pages/NewContactDialog.js';");
    expect(text).toMatch(
      /meta\(\{ priority: 'P2', severity: 'minor', feature: 'Contact', story: 'SF-219', owner: 'qa-agent', testCase: 'TC-SF-219-003' \}\)/,
    );
    expect(text).toContain("tag: ['@negative', '@P2', '@SF-219', '@persona:system-admin', '@mandatory']");
    expect(text).toContain("await data.create('account-contact', ['Account']);");
    expect(text).toContain("await test.step('1. Save a new Contact without Last Name'");
    expect(text).toContain(
      'await showRelatedList(accountRecordPage.contactsRelatedList, accountRecordPage.relatedTab);',
    );
    expect(text).toContain('await expectFieldError(newContactDialog.lastName);');
    expect(text).toContain("const attempt = await data.attempt('Contact', {  }, ['LastName']);");
    expect(text).toMatch(/Expected \(DECLARED_CONFIG; OC-002, Field:Contact\.LastName\)/);
    expect(text).not.toMatch(/locator\(|xpath|waitForTimeout/);
    expect(specPath('SF-219', CASE)).toBe(
      'tests/generated/SF-219/TC-SF-219-003-last-name-is-required-when-creating-a-contact.spec.ts',
    );
  });
});

describe('Test Generator: model loop (mock coder, MOCK)', () => {
  const ctx = generationContext();

  it('generates from a valid IR, reflects deterministic problems, and records lineage + locators used', async () => {
    let calls = 0;
    const router = await mockRouter({
      coder: {
        responder: () => {
          calls++;
          if (calls === 1) {
            const bad = clone(GOOD_IR);
            bad.steps[1]!.assertions = []; // reflected: "case step 2 has no assertion"
            return JSON.stringify(bad);
          }
          return JSON.stringify(GOOD_IR);
        },
      },
    });
    const r = await generateTests(
      ctx,
      [CASE, { ...CASE, id: 'TC-SF-219-099', reviewStatus: 'REVIEW_REQUIRED' }],
      { router },
      'llm',
    );
    expect(calls).toBe(2);
    expect(r.environment).toBe('MOCK');
    expect(r.specs).toHaveLength(1); // only APPROVED cases are generated
    const s = r.specs[0]!;
    expect(s.artifact).toMatchObject({
      origin: 'generated',
      caseHash: caseHash(CASE),
      dataBindings: ['account-contact'],
    });
    expect(s.artifact.locatorsUsed).toEqual(
      expect.arrayContaining([
        'account-record.contactsNewButton',
        'contact-new.lastName',
        'contact-new.saveButton',
        'contact-new.root',
      ]),
    );
  });

  it('degrades to a labelled test.fixme skeleton when the model never produces a valid IR', async () => {
    const router = await mockRouter({ coder: { responder: () => '{"caseId":"TC-SF-219-003","steps":[]}' } });
    const r = await generateTests(ctx, [CASE], { router }, 'llm');
    expect(r.degraded).toHaveLength(1);
    expect(r.specs[0]?.artifact.origin).toBe('mechanical');
    expect(r.specs[0]?.text).toContain('test.fixme(');
    expect(r.specs[0]?.text).toContain('MECHANICAL skeleton');
  });
});

describe('Test Generator: fixes from the fixture demo (run-p4-fixture-1)', () => {
  const ctx = generationContext();
  const recipe = bindRecipe(CASE, ctx);

  it('an API-only test does not request the page fixture (unused args fail lint)', () => {
    const apiOnly: TestIR = {
      caseId: CASE.id,
      data: ['Account'],
      steps: [clone(GOOD_IR.steps[1]!), { ...clone(GOOD_IR.steps[1]!), caseStep: 0 }],
      notes: [],
    };
    const text = renderSpec({ tc: CASE, ir: apiOnly, ctx, recipe, caseHash: 'h', irHash: 'h', model: 'm' });
    expect(text).toMatch(/async \(\{ data \}\) =>/);
  });

  it('accepts a page class name for openRecord and a region member name for a related list', () => {
    const ir = clone(GOOD_IR);
    ir.steps[0]!.actions[0] = {
      do: 'openNewFromRelatedList',
      parentRef: 'Account',
      relatedList: 'contactsRelatedList',
    };
    ir.steps[0]!.actions.unshift({ do: 'openRecord', ref: 'Account', object: 'AccountRecordPage' });
    expect(irProblems(CASE, ir, ctx, recipe)).toEqual([]);
    expect(renderSpec({ tc: CASE, ir, ctx, recipe, caseHash: 'h', irHash: 'h', model: 'm' })).toContain(
      'await accountRecordPage.contactsNewButton.click();',
    );
  });

  it('adopt must use the unique value the test typed; a keyboard check must cover every field of its scope', () => {
    const ir = clone(GOOD_IR);
    ir.steps[0]!.actions.push(
      { do: 'fill', element: 'contact-new.lastName', value: { kind: 'unique', label: 'typed', format: 'text' } },
      {
        do: 'adopt',
        as: 'uiContact',
        object: 'Contact',
        field: 'LastName',
        value: { kind: 'unique', label: 'other', format: 'text' },
      },
    );
    expect(irProblems(CASE, ir, ctx, recipe).join('\n')).toMatch(/same unique value the test typed/);

    const kb = clone(GOOD_IR);
    kb.steps[0]!.assertions.push({
      check: 'tabOrder',
      scope: 'contact-new.root',
      elements: ['contact-new.lastName', 'contact-new.saveButton'],
      expect: { caseStep: 0, evidenceIds: ['SF-219#AC2'] },
    });
    expect(irProblems(CASE, kb, ctx, recipe).join('\n')).toMatch(
      /must cover every field of contact-new\.root; missing contact-new\.firstName/,
    );
  });
});

describe('Test Generator: page context of the flow (fixture run-p4-fixture-2, TC-002)', () => {
  const ctx = generationContext();
  const recipe = bindRecipe(CASE, ctx);

  it('rejects dialog fields used when the dialog is not open, and related-list buttons clicked directly', () => {
    const ir: TestIR = {
      caseId: CASE.id,
      data: ['Account', 'Contact'],
      steps: [
        {
          caseStep: 0,
          title: 'Open New from the list without bringing it into view',
          actions: [
            { do: 'openRecord', ref: 'Account', object: 'Account' },
            { do: 'click', element: 'account-record.contactsNewButton' },
          ],
          assertions: [
            { check: 'visible', element: 'contact-new.root', expect: { caseStep: 0, evidenceIds: ['SF-219#AC2'] } },
          ],
        },
        {
          caseStep: 1,
          title: 'Edit on the record page, then type into the New Contact dialog',
          actions: [
            { do: 'openRecord', ref: 'Contact', object: 'Contact' },
            {
              do: 'fill',
              element: 'contact-new.mailingCountry',
              value: { kind: 'unique', label: 'country', format: 'text' },
            },
          ],
          assertions: [
            {
              check: 'apiRejects',
              object: 'Contact',
              basedOn: 'Contact',
              fields: {},
              remove: ['LastName'],
              errorCodes: ['REQUIRED_FIELD_MISSING'],
              expect: { caseStep: 1, evidenceIds: ['OC-002'] },
            },
          ],
        },
      ],
      notes: [],
    };
    const p = irProblems(CASE, ir, ctx, recipe).join('\n');
    expect(p).toMatch(/contactsNewButton is inside the "Contacts" related list: use openNewFromRelatedList/);
    expect(p).toMatch(/contact-new\.root is on NewContactDialog, which is not open at this point/);
    expect(p).toMatch(
      /contact-new\.mailingCountry is on NewContactDialog, which is not open at this point \(.*on screen: contact-record\)/,
    );
    expect(irProblems(CASE, GOOD_IR, ctx, recipe)).toEqual([]);
  });
});
