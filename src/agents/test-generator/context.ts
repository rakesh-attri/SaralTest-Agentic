// Generation context + deterministic IR checks (the Test Generator reflects these back to the model; Test Reviewer
// pass 2 re-runs them on the stored IR). Code decides what is allowed; the model only maps case steps to the IR.
import type { ObservedMessage } from '../../core/schemas/execution.js';
import type { DataPlan, DataPlanStep } from '../../core/schemas/data.js';
import type { IrAction, IrAssertion, TestIR, ValueRef } from '../../core/schemas/generation.js';
import { isAssertable, type TestCase } from '../../core/schemas/testCase.js';
import type { FieldFact, SnapshotFacts } from '../../sf/data/plan.js';
import { findMember, relatedListNewButton, type CatalogPage, type PageCatalog } from './pageObjects.js';

export interface RecipeView {
  name: string;
  /** Plan preview for this build (synthetic values are examples; tests get their own per-run values). */
  plan: DataPlan;
}

export interface GenerationContext {
  storyKey: string;
  designRunId: string;
  snapshotId: string;
  orgAlias: string;
  environment: 'LIVE' | 'FIXTURE';
  catalog: PageCatalog;
  recipes: RecipeView[];
  facts: SnapshotFacts;
  /** Personas with a configured test user. */
  personas: string[];
  /** Message texts the Explorer observed in the UI for this org (OBSERVED evidence; Phase 5). */
  observedMessages?: ObservedMessage[];
}

const norm = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ').trim();

/** Objects a case talks about (catalog page objects named in its text). */
export function caseObjects(tc: TestCase, ctx: Pick<GenerationContext, 'catalog'>): string[] {
  const text = caseCorpus(tc);
  const objects = [...new Set(ctx.catalog.pages.map((p) => p.object))];
  return objects.filter((o) => new RegExp(`\\b${o}s?\\b`, 'i').test(text));
}

/** All human text of a case (title, preconditions, actions, expectations). */
export function caseCorpus(tc: TestCase): string {
  return [tc.title, ...tc.preconditions, ...tc.steps.flatMap((s) => [s.action, s.expected.text])].join(' \n ');
}

/** The approved recipe for a case: an explicit dataRecipe, else the recipe whose objects cover the case's objects. */
export function bindRecipe(tc: TestCase, ctx: Pick<GenerationContext, 'catalog' | 'recipes'>): RecipeView | undefined {
  if (tc.dataRecipe) return ctx.recipes.find((r) => r.name === tc.dataRecipe);
  const objs = caseObjects(tc, ctx);
  if (!objs.length) return undefined;
  return ctx.recipes.find((r) => objs.every((o) => r.plan.steps.some((s) => s.object === o)));
}

export function featureOf(tc: TestCase, ctx: Pick<GenerationContext, 'catalog' | 'storyKey'>): string {
  const objs = caseObjects(tc, ctx);
  return objs.find((o) => new RegExp(`\\b${o}\\b`, 'i').test(tc.title)) ?? objs[0] ?? ctx.storyKey;
}

/** Record page of an object; also accepts the page's class name or id (models use either). */
export const recordPageOf = (cat: PageCatalog, object: string): CatalogPage | undefined =>
  cat.pages.find((p) => p.kind === 'record' && (p.object === object || p.className === object || p.id === object));

/** A related list's accessible name ("Contacts"); also accepts its region member name or ref (contactsRelatedList). */
export function canonicalList(cat: PageCatalog, list: string): string {
  const name = list.includes('.') ? list.slice(list.indexOf('.') + 1) : list;
  for (const p of cat.pages) {
    const m = p.members.find((x) => x.kind === 'region' && x.role === 'article' && x.name === name);
    if (m?.accessibleName) return m.accessibleName;
  }
  return list;
}

/** The "New <Object>" dialog for a related list named like "Contacts". */
export function dialogForList(cat: PageCatalog, list: string): CatalogPage | undefined {
  const child = canonicalList(cat, list).replace(/ies$/, 'y').replace(/s$/, '');
  return cat.pages.find((p) => p.kind === 'dialog' && p.object === child);
}

export function listRegion(page: CatalogPage, list: string): string | undefined {
  const name = list.includes('.') ? list.slice(list.indexOf('.') + 1) : list;
  return page.members.find(
    (m) => m.kind === 'region' && m.role === 'article' && (m.accessibleName === list || m.name === name),
  )?.name;
}

/** Field-like roles a keyboard check must reach ("all fields are reachable by keyboard"). */
export const FIELD_ROLES = new Set(['textbox', 'combobox', 'spinbutton', 'checkbox', 'searchbox']);

/** Error codes Salesforce can return for an API variant, derived only from metadata (never guessed). */
export function derivableErrorCodes(
  facts: SnapshotFacts,
  object: string,
  set: Record<string, { length?: number }>,
  remove: string[],
): string[] {
  const codes = new Set<string>();
  for (const r of remove) if (facts.field(object, r)?.required) codes.add('REQUIRED_FIELD_MISSING');
  for (const [f, v] of Object.entries(set)) {
    const len = facts.field(object, f)?.length;
    if (v.length !== undefined && len !== undefined && v.length > len) codes.add('STRING_TOO_LONG');
  }
  const touched = [...remove, ...Object.keys(set)];
  for (const vr of facts.activeValidationRules(object)) {
    const formula = typeof vr.body?.['errorConditionFormula'] === 'string' ? vr.body['errorConditionFormula'] : '';
    if (touched.some((f) => new RegExp(`(?<![A-Za-z0-9_])${f}(?![A-Za-z0-9_])`).test(formula))) {
      codes.add('FIELD_CUSTOM_VALIDATION_EXCEPTION');
    }
  }
  return [...codes];
}

const FILLABLE = new Set(['textbox', 'spinbutton', 'searchbox']);
const VALUED = new Set([...FILLABLE, 'combobox']);
/** Field types the record page displays exactly as stored (others are locale-formatted: phone, dates, numbers). */
const DISPLAYED_AS_ENTERED = new Set(['string', 'textarea', 'email', 'picklist', 'reference', 'url', 'id']);

/**
 * The error message a field must show for a validation rule — taken only from the org snapshot (DECLARED
 * metadata): the rule must be active, on the field's object, and display its error on that field.
 */
export function fieldErrorRule(
  ctx: GenerationContext,
  element: string,
  rule: string,
): { rule: string; message: string } | { problem: string } {
  const m = findMember(ctx.catalog, element);
  const [object, field] = m?.member.fieldApiName?.split('.') ?? [];
  if (!object || !field) return { problem: `${element} is not bound to a field, so no rule message applies` };
  const name = rule.includes('.') ? rule : `${object}.${rule}`;
  const vr = ctx.facts.activeValidationRules(object).find((c) => c.apiName === name);
  if (!vr) return { problem: `${name} is not an active validation rule on ${object} in the snapshot (omit message)` };
  const msg = vr.body?.['errorMessage'];
  if (typeof msg !== 'string' || !msg.trim()) return { problem: `${name} has no error message in the snapshot` };
  if (vr.body?.['errorDisplayField'] !== field)
    return { problem: `${name} shows its message at the top of the form, not on ${field} (omit message)` };
  return { rule: name, message: msg };
}

/** The snapshot field behind a picklist combobox member, if it is one. */
export function picklistFact(ctx: GenerationContext, ref: string): FieldFact | undefined {
  const m = findMember(ctx.catalog, ref);
  const [object, field] = m?.member.fieldApiName?.split('.') ?? [];
  const fact = object && field ? ctx.facts.field(object, field) : undefined;
  return fact && (fact.type === 'picklist' || fact.type === 'multipicklist') ? fact : undefined;
}
const CLICKABLE = new Set(['button', 'tab', 'link', 'menuitem', 'checkbox', 'radio', 'option']);

/**
 * Deterministic problems of an IR for a case (empty = acceptable). Covers: every case step implemented; every
 * assertable expectation asserted; assertions cite only the step's evidence; elements exist in the catalog;
 * data refs exist; literals and lengths grounded in the case text / recipe / UI labels; API error codes derivable.
 */
export function irProblems(tc: TestCase, ir: TestIR, ctx: GenerationContext, recipe: RecipeView | undefined): string[] {
  const p: string[] = [];
  if (ir.caseId !== tc.id) p.push(`caseId must be ${tc.id}`);
  const steps: DataPlanStep[] = recipe?.plan.steps ?? [];
  for (const d of ir.data) if (!steps.some((s) => s.stepId === d)) p.push(`data step ${d} is not in the bound recipe`);
  const created = new Set(ir.data);
  const corpus = norm(
    [caseCorpus(tc), ...steps.flatMap((s) => Object.values(s.fields).map(String)), ...labels(ctx.catalog)].join(' \n '),
  );
  const caseEvidence = new Set(tc.steps.flatMap((s) => s.expected.evidenceIds));

  // Page context of the flow: which page objects are on screen at this point (CLAUDE.md: tests must be runnable,
  // not only resolvable — the dry-run checks each locator in its own page state, this checks the order of use).
  let onScreen: string[] = [];
  const member = (ref: string, roles?: Set<string>, interact = false): CatalogPage | undefined => {
    const m = findMember(ctx.catalog, ref);
    if (!m) {
      const page = ctx.catalog.pages.find((x) => x.id === ref.slice(0, ref.indexOf('.')));
      p.push(
        `element ${ref} is not a page-object member (use only refs from the catalog)` +
          (page?.kind === 'record'
            ? `. The catalog has no edit-form fields on ${page.className}: to change field values of an existing record use {"do":"apiUpdate","ref":"<recipe step>","fields":{...}} and note the substitution in notes`
            : ''),
      );
      return undefined;
    }
    if (roles && (!m.member.role || !roles.has(m.member.role))) {
      const fields = m.page.members
        .filter(
          (x) =>
            x.kind === 'element' &&
            x.role &&
            roles.has(x.role) &&
            (x.scopeName === m.member.accessibleName || !x.scopeName),
        )
        .slice(0, 6)
        .map((x) => x.ref);
      p.push(
        `element ${ref} has role ${m.member.role ?? '?'}; this action needs ${[...roles].join('/')}${fields.length ? ` (e.g. ${fields.join(', ')})` : ''}`,
      );
    }
    if (!onScreen.includes(m.page.id)) {
      p.push(
        `element ${ref} is on ${m.page.className}, which is not open at this point (open it first with openRecord / openNewFromRelatedList / recordView; on screen: ${onScreen.join(', ') || 'nothing'})`,
      );
    }
    const scope = m.member.scopeName;
    if (
      interact &&
      scope &&
      m.page.members.some((x) => x.kind === 'region' && x.role === 'article' && x.accessibleName === scope)
    ) {
      p.push(
        `element ${ref} is inside the "${scope}" related list: use openNewFromRelatedList (it brings the list into view)`,
      );
    }
    return m.page;
  };
  const recordRef = (ref: string, where: string): void => {
    if (!created.has(ref))
      p.push(`${where}: record ${ref} is not created (data) or captured (recordView as / adopt) earlier`);
  };
  const value = (v: ValueRef, where: string, caseStep: number): void => {
    switch (v.kind) {
      case 'data': {
        const s = steps.find((x) => x.stepId === v.ref);
        if (!s || !created.has(v.ref)) p.push(`${where}: data ${v.ref} is not created by this test`);
        else if (!(v.field in s.fields)) p.push(`${where}: ${v.ref}.${v.field} is not a recipe field`);
        break;
      }
      case 'recordId':
        recordRef(v.ref, where);
        break;
      case 'literal':
        if (!v.evidenceIds.length) p.push(`${where}: literal "${v.value}" cites no evidence`);
        if (!corpus.includes(norm(v.value))) {
          p.push(`${where}: literal "${v.value}" is not in the case text, recipe or UI labels (never invent values)`);
        }
        for (const e of v.evidenceIds)
          if (!caseEvidence.has(e)) p.push(`${where}: evidence ${e} is not cited by the case`);
        break;
      case 'length': {
        const stepText = tc.steps[caseStep] ? `${tc.steps[caseStep].action} ${tc.steps[caseStep].expected.text}` : '';
        if (!new RegExp(`(?<![\\d])${v.length}(?![\\d])`).test(`${stepText} ${tc.title}`)) {
          p.push(`${where}: length ${v.length} is not stated in case step ${caseStep + 1} or the title`);
        }
        for (const e of v.evidenceIds)
          if (!caseEvidence.has(e)) p.push(`${where}: evidence ${e} is not cited by the case`);
        break;
      }
      case 'unique':
        break;
    }
  };

  const typedUniques = new Set<string>();
  const typedLengths = new Set<number>(); // data.ofLength(n) values are run-unique too (they start with QA-<runId>-)
  const apiUpdated = new Set<string>(); // recipe records the test changed itself through the API
  const covered = new Set<number>();
  ir.steps.forEach((st, si) => {
    const where = `step ${si + 1}`;
    if (st.caseStep >= tc.steps.length)
      p.push(`${where}: caseStep ${st.caseStep} does not exist (case has ${tc.steps.length})`);
    if (!st.actions.length && !st.assertions.length) p.push(`${where}: no action and no assertion`);
    for (const a of st.actions) action(a, `${where} ${a.do}`, st.caseStep);
    // Cleanup of UI-created records is code-owned (render.ts registers the record shown after a create-dialog
    // Save). The model's part is the assertion: a Save the case expects to succeed must be followed by recordView —
    // without it the new record cannot be registered and would stay in the org.
    const createSave = st.actions.some((x) => x.do === 'click' && isCreateSave(ctx, x.element));
    const rejected = st.assertions.some(
      (x) =>
        x.check === 'fieldError' ||
        x.check === 'soqlNoRecord' ||
        x.check === 'apiRejects' ||
        (x.check === 'visible' && findMember(ctx.catalog, x.element)?.page.kind === 'dialog'),
    );
    if (createSave && !rejected && !st.assertions.some((x) => x.check === 'recordView')) {
      p.push(
        `${where}: after Save in the create dialog assert {"check":"recordView","object":"<Object>","as":"<name>"} (the saved record) — or assert the rejection (fieldError / visible dialog / soqlNoRecord). Cleanup is automatic; never write adopt`,
      );
    }
    for (const a of st.assertions) {
      assertion(a, `${where} ${a.check}`);
      if (a.expect.caseStep !== st.caseStep) p.push(`${where} ${a.check}: expect.caseStep must be ${st.caseStep}`);
      if (!a.expect.evidenceIds.length) p.push(`${where} ${a.check}: expect cites no evidence`);
      const exp = tc.steps[a.expect.caseStep]?.expected;
      if (exp) {
        if (!isAssertable(exp.evidenceLevel))
          p.push(`${where} ${a.check}: case step ${a.expect.caseStep + 1} is ${exp.evidenceLevel}, not assertable`);
        for (const e of a.expect.evidenceIds) {
          if (!exp.evidenceIds.includes(e))
            p.push(`${where} ${a.check}: evidence ${e} is not cited by case step ${a.expect.caseStep + 1}`);
        }
        covered.add(a.expect.caseStep);
      }
    }
  });
  tc.steps.forEach((s, i) => {
    if (!ir.steps.some((st) => st.caseStep === i)) p.push(`case step ${i + 1} ("${s.action}") has no IR step`);
    else if (isAssertable(s.expected.evidenceLevel) && !covered.has(i)) {
      p.push(`case step ${i + 1}: expected result "${s.expected.text}" has no assertion`);
    }
  });
  return [...new Set(p)];

  function action(a: IrAction, where: string, caseStep: number): void {
    switch (a.do) {
      case 'openRecord': {
        recordRef(a.ref, where);
        const page = recordPageOf(ctx.catalog, a.object);
        if (!page) p.push(`${where}: no record page object for ${a.object}`);
        onScreen = page ? [page.id] : [];
        break;
      }
      case 'openNewFromRelatedList': {
        recordRef(a.parentRef, where);
        const parent = steps.find((s) => s.stepId === a.parentRef)?.object;
        const page = parent ? recordPageOf(ctx.catalog, parent) : undefined;
        if (!page) p.push(`${where}: no record page for ${a.parentRef}`);
        else {
          if (!listRegion(page, a.relatedList))
            p.push(`${where}: ${page.className} has no related list "${a.relatedList}"`);
          if (!relatedListNewButton(page, canonicalList(ctx.catalog, a.relatedList))) {
            p.push(`${where}: no New button for "${a.relatedList}"`);
          }
        }
        const dialog = dialogForList(ctx.catalog, a.relatedList);
        if (!dialog) p.push(`${where}: no dialog page object for "${a.relatedList}"`);
        onScreen = [...(dialog ? [dialog.id] : []), ...(page ? [page.id] : [])];
        break;
      }
      case 'fill':
        member(a.element, FILLABLE, true);
        value(a.value, where, caseStep);
        if (a.value.kind === 'unique') typedUniques.add(a.value.label);
        if (a.value.kind === 'length') typedLengths.add(a.value.length);
        break;
      case 'select': {
        member(a.element, new Set(['combobox']), true);
        const fact = picklistFact(ctx, a.element);
        if (!fact) {
          p.push(`${where}: ${a.element} is not a picklist field in the snapshot (select is for picklists only)`);
        } else if (a.value.kind === 'literal' && fact.picklistValues?.includes(a.value.value)) {
          // grounded by the org: an active value of this picklist in the snapshot (DECLARED_CONFIG)
        } else if (a.value.kind === 'literal') {
          p.push(
            `${where}: "${a.value.value}" is not an active value of ${fact.apiName} (values: ${(fact.picklistValues ?? []).join(', ')})`,
          );
        } else {
          value(a.value, where, caseStep);
        }
        break;
      }
      case 'clear':
        member(a.element, FILLABLE, true);
        break;
      case 'click':
        member(a.element, CLICKABLE, true);
        break;
      case 'selectTab':
        member(a.element, new Set(['tab']), true);
        break;
      case 'apiUpdate': {
        recordRef(a.ref, where);
        apiUpdated.add(a.ref);
        const obj = steps.find((s) => s.stepId === a.ref)?.object;
        for (const [f, v] of Object.entries(a.fields)) {
          const fact = obj ? ctx.facts.field(obj, f) : undefined;
          if (!fact) {
            p.push(
              obj
                ? `${where}: ${obj}.${f} is not in the snapshot`
                : `${where}: ${a.ref} is not a recipe step (use one of: ${steps.map((x) => x.stepId).join(', ')})`,
            );
          }
          if (v.kind === 'unique' && v.format === 'phone' && fact && fact.type !== 'phone')
            p.push(`${where}: ${f} is not a phone field`);
          if (v.kind === 'unique' && v.format === 'email' && fact && fact.type !== 'email')
            p.push(`${where}: ${f} is not an email field`);
          value(v, `${where} ${f}`, caseStep);
        }
        break;
      }
      case 'adopt':
        // Legacy IR: normalizeIr removes model-written adopts (cleanup is code-owned since run-p4-build-decided-3).
        p.push(`${where}: adopt is written by code — remove it (assert recordView after Save instead)`);
        created.add(a.as);
        break;
    }
  }

  function assertion(a: IrAssertion, where: string): void {
    const cs = a.expect.caseStep;
    switch (a.check) {
      case 'visible':
      case 'hidden':
        member(a.element);
        break;
      case 'fieldError':
        member(a.element);
        if (a.message) {
          const r = fieldErrorRule(ctx, a.element, a.message.rule);
          if ('problem' in r) p.push(`${where}: ${r.problem}`);
        }
        break;
      case 'inputValue':
        // comboboxes too: a pre-filled lookup (Account Name) or a picklist's current value
        member(a.element, VALUED);
        value(a.equals, where, cs);
        break;
      case 'toast':
        if (a.contains) value(a.contains, where, cs);
        break;
      case 'recordView': {
        const page = recordPageOf(ctx.catalog, a.object);
        if (!page) p.push(`${where}: no record page for ${a.object}`);
        if (a.as) created.add(a.as);
        onScreen = page ? [page.id] : [];
        break;
      }
      case 'recordTitle':
        value(a.contains, where, cs);
        break;
      case 'recordField': {
        const pg = member(a.element, new Set(['listitem']));
        const m = findMember(ctx.catalog, a.element);
        if (pg && pg.kind !== 'record') p.push(`${where}: recordField needs a record-page field member`);
        const [obj, f] = m?.member.fieldApiName?.split('.') ?? [];
        const t = obj && f ? ctx.facts.field(obj, f)?.type : undefined;
        if (t && !DISPLAYED_AS_ENTERED.has(t))
          p.push(
            `${where}: ${obj ?? ''}.${f ?? ''} is a ${t} field; the record page shows it locale-formatted — check it with soqlField instead`,
          );
        value(a.contains, where, cs);
        break;
      }
      case 'relatedListHasRecord': {
        recordRef(a.parentRef, where);
        const parent = steps.find((s) => s.stepId === a.parentRef)?.object;
        const page = parent ? recordPageOf(ctx.catalog, parent) : undefined;
        if (!page || !listRegion(page, a.relatedList))
          p.push(`${where}: no related list "${a.relatedList}" on ${parent ?? '?'}`);
        value(a.name, where, cs);
        break;
      }
      case 'soqlField':
        recordRef(a.ref, where);
        if (!ctx.facts.field(a.object, a.field)) p.push(`${where}: ${a.object}.${a.field} is not in the snapshot`);
        value(a.equals, where, cs);
        // A value the test typed (unique / length) lives on the record the test created in the UI, not on a recipe
        // record the data factory created (run-p4-coder-nim-4, TC-004: the check read the recipe Contact).
        if (
          (a.equals.kind === 'unique' || a.equals.kind === 'length') &&
          steps.some((x) => x.stepId === a.ref) &&
          !apiUpdated.has(a.ref)
        ) {
          p.push(
            `${where}: ${a.ref} is a recipe record; the value the test typed is on the record it created — capture it with {"check":"recordView","as":"<name>"} (or adopt) and query that name`,
          );
        }
        break;
      case 'soqlNoRecord': {
        if (!ctx.facts.field(a.object, a.field)) p.push(`${where}: ${a.object}.${a.field} is not in the snapshot`);
        value(a.value, where, cs);
        // Only a run-unique value the test typed can prove "not saved": recipe / literal values may already exist
        // (run-p4-coder-nim-4, TC-003: FirstName of the recipe Contact always counted 1).
        const typed =
          (a.value.kind === 'unique' && typedUniques.has(a.value.label)) ||
          (a.value.kind === 'length' && a.value.length >= 20 && typedLengths.has(a.value.length));
        if (!typed) {
          p.push(
            `${where}: soqlNoRecord must look for a run-unique value this test typed into the form (a unique value, or a length value of 20+ characters, filled first and reused here)`,
          );
        }
        break;
      }
      case 'apiRejects': {
        const base = steps.find((s) => s.stepId === a.basedOn);
        if (!base) p.push(`${where}: basedOn ${a.basedOn} is not a recipe step`);
        else if (base.parent && !created.has(base.parent.stepId)) {
          p.push(`${where}: ${a.basedOn} needs its parent ${base.parent.stepId} in data`);
        }
        if (base && base.object !== a.object)
          p.push(`${where}: basedOn ${a.basedOn} is a ${base.object}, not ${a.object}`);
        const set: Record<string, { length?: number }> = {};
        for (const [f, v] of Object.entries(a.fields)) {
          set[f] = v.kind === 'length' ? { length: v.length } : {};
          value(v, `${where} ${f}`, cs);
        }
        const allowed = base ? derivableErrorCodes(ctx.facts, a.object, set, a.remove) : [];
        if (!allowed.length) p.push(`${where}: no metadata says this variant is rejected (cannot assert a rejection)`);
        const extra = a.errorCodes.filter((c) => !allowed.includes(c));
        if (extra.length)
          p.push(
            `${where}: error codes ${extra.join(', ')} are not derivable from metadata (allowed: ${allowed.join(', ') || 'none'})`,
          );
        break;
      }
      case 'historyTracked':
        recordRef(a.ref, where);
        for (const f of a.fields)
          if (!ctx.facts.field(a.object, f)) p.push(`${where}: ${a.object}.${f} is not in the snapshot`);
        break;
      case 'a11yScan':
        member(a.scope);
        break;
      case 'tabOrder': {
        const scope = member(a.scope);
        for (const e of a.elements) member(e);
        const fields = scope?.members.filter((m) => m.kind === 'element' && m.role && FIELD_ROLES.has(m.role)) ?? [];
        const missing = fields.filter((m) => !a.elements.includes(m.ref)).map((m) => m.ref);
        if (missing.length)
          p.push(`${where}: the keyboard check must cover every field of ${a.scope}; missing ${missing.join(', ')}`);
        break;
      }
    }
  }
}

function labels(cat: PageCatalog): string[] {
  return cat.pages.flatMap((p) => p.members.map((m) => m.accessibleName ?? '')).filter(Boolean);
}

/**
 * Meaning-preserving clean-up of a parsed IR before the checks (seen with the NIM coder, run-p4-coder-nim-1): record
 * refs given as a page id / page ref / class / object name (`account-record.root`, `AccountRecordPage`, `account`)
 * become the recipe step id of that object (`Account`) — only when exactly one recipe step has that object.
 * Omitted evidence ids (a literal / length value or an assertion's `expect`) are filled with the evidence the case
 * step itself cites — the same rule the Test Planner uses for omitted evidence; nothing new is cited.
 * Anything ambiguous is left as is, so the checks still reject it.
 */
export function normalizeIr(ir: TestIR, ctx: GenerationContext, recipe: RecipeView | undefined, tc?: TestCase): TestIR {
  const steps = recipe?.plan.steps ?? [];
  const named = new Set<string>(); // names the IR itself introduces (adopt / recordView `as`)
  for (const st of ir.steps) {
    for (const a of st.actions) if (a.do === 'adopt') named.add(a.as);
    for (const a of st.assertions) if (a.check === 'recordView' && a.as) named.add(a.as);
  }
  const objectOf = (v: string): string | undefined => {
    const base = v.includes('.') ? v.slice(0, v.indexOf('.')) : v;
    const page = ctx.catalog.pages.find((p) => p.id === base || p.className === base || p.id === v);
    if (page) return page.object;
    return steps.find((s) => s.object.toLowerCase() === v.toLowerCase())?.object;
  };
  const ref = (v: string): string => {
    if (named.has(v) || steps.some((s) => s.stepId === v)) return v;
    const obj = objectOf(v);
    const matches = obj ? steps.filter((s) => s.object === obj) : [];
    return matches.length === 1 && matches[0] ? matches[0].stepId : v;
  };
  let caseStep = 0; // the IR step being normalised (for omitted evidence ids)
  const stepEvidence = (): string[] => tc?.steps[caseStep]?.expected.evidenceIds ?? [];
  // A literal equal to a synthetic recipe value (e.g. the build-preview Account name `QA-<run>-…`) is that recipe
  // field: the value differs per run, so it must be read from the data plan at run time (run-p4-build-decided-3).
  const runId = recipe?.plan.runId;
  const recipeField = (v: string): ValueRef | undefined => {
    for (const st of steps) {
      for (const [field, fv] of Object.entries(st.fields)) {
        if (typeof fv === 'string' && fv === v && runId && fv.includes(runId)) {
          return { kind: 'data', ref: st.stepId, field };
        }
      }
    }
    return undefined;
  };
  const val = (x: ValueRef): ValueRef => {
    if (x.kind === 'data' || x.kind === 'recordId') return { ...x, ref: ref(x.ref) };
    if (x.kind === 'literal') {
      const d = recipeField(x.value);
      if (d) return d;
    }
    if ((x.kind === 'literal' || x.kind === 'length') && !x.evidenceIds.length)
      return { ...x, evidenceIds: stepEvidence() };
    return x;
  };
  const fields = (f: Record<string, ValueRef>): Record<string, ValueRef> =>
    Object.fromEntries(Object.entries(f).map(([k, x]) => [k, val(x)]));
  const action = (a: IrAction): IrAction => {
    switch (a.do) {
      case 'openRecord':
        return { ...a, ref: ref(a.ref), object: objectOf(a.object) ?? a.object };
      case 'openNewFromRelatedList':
        return { ...a, parentRef: ref(a.parentRef), relatedList: canonicalList(ctx.catalog, a.relatedList) };
      case 'fill':
        // `fill` on a picklist combobox means choosing that option (same intent; the renderer needs `select`)
        return picklistFact(ctx, a.element)
          ? { do: 'select', element: a.element, value: val(a.value) }
          : { ...a, value: val(a.value) };
      case 'select':
        return { ...a, value: val(a.value) };
      case 'apiUpdate':
        return { ...a, ref: ref(a.ref), fields: fields(a.fields) };
      case 'adopt':
        return { ...a, object: objectOf(a.object) ?? a.object, value: val(a.value) };
      default:
        return a;
    }
  };
  const assertion = (a0: IrAssertion): IrAssertion => {
    const ev = tc?.steps[a0.expect.caseStep]?.expected.evidenceIds ?? [];
    const a = a0.expect.evidenceIds.length ? a0 : { ...a0, expect: { ...a0.expect, evidenceIds: ev } };
    switch (a.check) {
      case 'inputValue':
        return { ...a, equals: val(a.equals) };
      case 'toast':
        return a.contains ? { ...a, contains: val(a.contains) } : a;
      case 'recordTitle':
        return { ...a, contains: val(a.contains) };
      case 'relatedListHasRecord':
        return {
          ...a,
          parentRef: ref(a.parentRef),
          relatedList: canonicalList(ctx.catalog, a.relatedList),
          name: val(a.name),
        };
      case 'soqlField':
        return { ...a, ref: ref(a.ref), equals: val(a.equals) };
      case 'soqlNoRecord':
        return { ...a, value: val(a.value) };
      case 'apiRejects':
        return { ...a, basedOn: ref(a.basedOn), fields: fields(a.fields) };
      case 'historyTracked':
        return { ...a, ref: ref(a.ref) };
      default:
        return a;
    }
  };
  const data = [...new Set(ir.data.map(ref))];
  const notes = [...ir.notes];
  const nav = {
    record: undefined as { ref: string; object: string } | undefined,
    parent: undefined as { ref: string; object: string } | undefined,
  };
  let unnamed = 0;
  const out = ir.steps.map((st) => {
    caseStep = st.caseStep;
    const actions = navigationShorthand(st.actions.map(action), ctx, nav, notes);
    const dropped = actions.filter((a) => a.do === 'adopt');
    if (dropped.length) notes.push(`cleanup: ${dropped.length} model-written adopt(s) removed — cleanup is code-owned`);
    const saves = actions.some((a) => a.do === 'click' && isCreateSave(ctx, a.element));
    const assertions = st.assertions
      .map(assertion)
      .map((a) =>
        a.check === 'recordView' && !a.as && saves ? { ...a, as: `created${a.object}${String(++unnamed)}` } : a,
      );
    const n = { ...st, actions: actions.filter((a) => a.do !== 'adopt'), assertions };
    for (const a of n.assertions) if (a.check === 'recordView' && a.as) nav.record = { ref: a.as, object: a.object };
    return n;
  });
  return { ...ir, data, notes, steps: out };
}

/**
 * Navigation shorthand the coder keeps writing (run-p4-build-decided-1: 12 of 20 cases fell back to skeletons on it),
 * rewritten to the equivalent IR. The test's meaning is unchanged:
 * - `click` on a related list's "New" button of the record just opened = `openNewFromRelatedList` on that record;
 * - in a dialog opened that way, `fill` of the lookup to the parent with the parent's own record (its id or a field
 *   of it) is dropped: Salesforce pre-fills that lookup with the parent (the dialog shows "Clear <lookup> Selection").
 * Anything else is left to the checks.
 */
function navigationShorthand(
  actions: IrAction[],
  ctx: GenerationContext,
  nav: { record: { ref: string; object: string } | undefined; parent: { ref: string; object: string } | undefined },
  notes: string[],
): IrAction[] {
  const out: IrAction[] = [];
  for (const a of actions) {
    if (a.do === 'openRecord') {
      nav.record = { ref: a.ref, object: a.object };
      nav.parent = undefined;
    } else if (a.do === 'openNewFromRelatedList') {
      nav.parent = { ref: a.parentRef, object: nav.record?.ref === a.parentRef ? nav.record.object : '' };
    } else if (a.do === 'click') {
      const m = findMember(ctx.catalog, a.element);
      const list = m?.member.scopeName;
      if (
        m?.page.kind === 'record' &&
        m.member.role === 'button' &&
        m.member.accessibleName === 'New' &&
        list &&
        nav.record?.object === m.page.object
      ) {
        const relatedList = canonicalList(ctx.catalog, list);
        out.push({ do: 'openNewFromRelatedList', parentRef: nav.record.ref, relatedList });
        nav.parent = { ...nav.record };
        notes.push(
          `navigation: click on ${a.element} written as openNewFromRelatedList(${nav.record.ref}, ${relatedList}) (by code)`,
        );
        continue;
      }
    } else if (a.do === 'fill' && nav.parent?.object) {
      const m = findMember(ctx.catalog, a.element);
      const field = m?.member.fieldApiName?.split('.')[1];
      const v = a.value;
      const sameParent = (v.kind === 'data' || v.kind === 'recordId') && v.ref === nav.parent.ref;
      if (m?.page.kind === 'dialog' && field === `${nav.parent.object}Id` && sameParent) {
        notes.push(
          `navigation: fill of ${a.element} with ${nav.parent.ref} dropped — Salesforce pre-fills it when New is opened from ${nav.parent.ref}'s related list (by code)`,
        );
        continue;
      }
    }
    out.push(a);
  }
  return out;
}

/** A click on the Save button of a create dialog (the only UI action that creates a record). */
export function isCreateSave(ctx: GenerationContext, ref: string): boolean {
  const m = findMember(ctx.catalog, ref);
  return m?.page.kind === 'dialog' && m.member.role === 'button' && m.member.accessibleName === 'Save';
}
