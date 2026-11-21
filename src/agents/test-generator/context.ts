// Generation context + deterministic IR checks (the Test Generator reflects these back to the model; Test Reviewer
// pass 2 re-runs them on the stored IR). Code decides what is allowed; the model only maps case steps to the IR.
import type { DataPlan, DataPlanStep } from '../../core/schemas/data.js';
import type { IrAction, IrAssertion, TestIR, ValueRef } from '../../core/schemas/generation.js';
import { isAssertable, type TestCase } from '../../core/schemas/testCase.js';
import type { SnapshotFacts } from '../../sf/data/plan.js';
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
      p.push(`element ${ref} is not a page-object member (use only refs from the catalog)`);
      return undefined;
    }
    if (roles && (!m.member.role || !roles.has(m.member.role))) {
      p.push(`element ${ref} has role ${m.member.role ?? '?'}; this action needs ${[...roles].join('/')}`);
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
  const covered = new Set<number>();
  ir.steps.forEach((st, si) => {
    const where = `step ${si + 1}`;
    if (st.caseStep >= tc.steps.length)
      p.push(`${where}: caseStep ${st.caseStep} does not exist (case has ${tc.steps.length})`);
    if (!st.actions.length && !st.assertions.length) p.push(`${where}: no action and no assertion`);
    for (const a of st.actions) action(a, `${where} ${a.do}`, st.caseStep);
    for (const a of st.assertions) {
      assertion(a, `${where} ${a.check}`);
      if (a.expect.caseStep !== st.caseStep) p.push(`${where} ${a.check}: expect.caseStep must be ${st.caseStep}`);
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
        break;
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
        const obj = steps.find((s) => s.stepId === a.ref)?.object;
        for (const [f, v] of Object.entries(a.fields)) {
          const fact = obj ? ctx.facts.field(obj, f) : undefined;
          if (!fact) p.push(`${where}: ${obj ?? '?'}.${f} is not in the snapshot`);
          if (v.kind === 'unique' && v.format === 'phone' && fact && fact.type !== 'phone')
            p.push(`${where}: ${f} is not a phone field`);
          if (v.kind === 'unique' && v.format === 'email' && fact && fact.type !== 'email')
            p.push(`${where}: ${f} is not an email field`);
          value(v, `${where} ${f}`, caseStep);
        }
        break;
      }
      case 'adopt':
        if (a.value.kind !== 'unique' || a.value.format !== 'text') {
          p.push(`${where}: adopt needs a run-unique text value (kind unique, format text) — never foreign data`);
        } else if (!typedUniques.has(a.value.label)) {
          p.push(
            `${where}: adopt must use the same unique value the test typed into the record (a fill with unique label "${a.value.label}" before it)`,
          );
        }
        if (!ctx.facts.field(a.object, a.field)) p.push(`${where}: ${a.object}.${a.field} is not in the snapshot`);
        created.add(a.as);
        break;
    }
  }

  function assertion(a: IrAssertion, where: string): void {
    const cs = a.expect.caseStep;
    switch (a.check) {
      case 'visible':
      case 'hidden':
      case 'fieldError':
        member(a.element);
        break;
      case 'inputValue':
        member(a.element, FILLABLE);
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
        break;
      case 'soqlNoRecord':
        if (!ctx.facts.field(a.object, a.field)) p.push(`${where}: ${a.object}.${a.field} is not in the snapshot`);
        value(a.value, where, cs);
        break;
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
