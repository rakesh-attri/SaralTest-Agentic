// Spec ↔ org dependencies (operator 2026-11-26: a changed Phone rule message left stale specs unnoticed). Every
// generated spec records the snapshot components and locators it depends on, with their hashes; a later snapshot
// or registry change to any of them makes the spec STALE (never executed until rebuilt).
import type { SpecDependency, TestIR } from '../../core/schemas/generation.js';
import type { SnapshotFacts } from '../../sf/data/plan.js';
import { fieldErrorRule, relationshipOf, type GenerationContext, type RecipeView } from './context.js';
import { findMember, hashText, type PageCatalog } from './pageObjects.js';
import { locatorsUsed } from './render.js';

/** Hash of a locator as the spec saw it: registry expression + status (a later RE_VERIFY or edit changes it). */
export const locatorHash = (expression: string, status: string): string => hashText(`${expression}|${status}`);

const mentions = (formula: string, field: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9_])${field}(?![A-Za-z0-9_])`).test(formula);

/**
 * Components a spec built from `ir` depends on:
 * - fields it types into, selects, reads or queries (`Field:<Obj.Field>`; picklist values live in the field);
 * - active validation rules whose message it asserts, or whose formula reads one of those fields
 *   (`ValidationRule:<Obj.Rule>`);
 * - every page-object locator it uses (`Locator:<page>/<registry element>`).
 */
export function specDependencies(ir: TestIR, ctx: GenerationContext, recipe: RecipeView | undefined): SpecDependency[] {
  const fields = new Set<string>(); // Obj.Field
  const rules = new Set<string>(); // Obj.Rule
  const objectOf = (ref: string): string | undefined => recipe?.plan.steps.find((s) => s.stepId === ref)?.object;
  const addField = (object: string | undefined, field: string | undefined): void => {
    if (!object || !field) return;
    const [rel, parentField] = field.split('.');
    if (!parentField) {
      fields.add(`${object}.${field}`);
      return;
    }
    // `Account.Name` through a lookup: depend on the lookup field and on the parent's field.
    const lookup = ctx.facts.fields(object).find((f) => relationshipOf(f.apiName.split('.').pop() ?? '') === rel);
    if (lookup) fields.add(lookup.apiName);
    const target = lookup?.referenceTo[0];
    if (target) fields.add(`${target}.${parentField}`);
  };
  const valueFields = (v: unknown): void => {
    if (v && typeof v === 'object' && 'kind' in v && v.kind === 'data' && 'ref' in v && 'field' in v)
      addField(objectOf(String(v.ref)), String(v.field));
  };
  const elements = locatorsUsed(ir, ctx.catalog, recipe);
  for (const ref of elements) {
    const f = findMember(ctx.catalog, ref)?.member.fieldApiName;
    if (f) fields.add(f);
  }
  for (const st of ir.steps) {
    for (const a of st.actions) {
      if ('value' in a) valueFields(a.value);
      if (a.do === 'apiUpdate')
        for (const [f, v] of Object.entries(a.fields)) {
          addField(objectOf(a.ref), f);
          valueFields(v);
        }
    }
    for (const a of st.assertions) {
      if (a.check === 'fieldError' && a.message && 'rule' in a.message) {
        const r = fieldErrorRule(ctx, a.element, a.message.rule);
        if ('rule' in r) rules.add(r.rule);
      }
      if (a.check === 'soqlField' || a.check === 'soqlNoRecord') addField(a.object, a.field);
      if (a.check === 'historyTracked') for (const f of a.fields) addField(a.object, f);
      if (a.check === 'apiRejects') {
        for (const f of [...Object.keys(a.fields), ...a.remove]) addField(a.object, f);
      }
      for (const v of Object.values(a)) valueFields(v);
    }
  }
  // Rules that read a field the spec touches can change what the test sees (e.g. Phone_Required_For_Web).
  const objects = new Set([...fields].map((f) => f.split('.')[0] ?? ''));
  for (const o of objects) {
    for (const vr of ctx.facts.activeValidationRules(o)) {
      const formula = typeof vr.body?.['errorConditionFormula'] === 'string' ? vr.body['errorConditionFormula'] : '';
      if ([...fields].some((f) => f.startsWith(`${o}.`) && mentions(formula, f.split('.')[1] ?? '')))
        rules.add(vr.apiName);
    }
  }
  const out: SpecDependency[] = [];
  for (const f of [...fields].sort()) {
    const [o, n] = f.split('.');
    const h = o && n ? ctx.facts.hashOf('Field', f) : undefined;
    if (h) out.push({ component: `Field:${f}`, hash: h });
  }
  for (const r of [...rules].sort()) {
    const h = ctx.facts.hashOf('ValidationRule', r);
    if (h) out.push({ component: `ValidationRule:${r}`, hash: h });
  }
  for (const ref of [...elements].sort()) {
    const m = findMember(ctx.catalog, ref);
    if (m?.member.registryElement)
      out.push({
        component: `Locator:${m.page.id}/${m.member.registryElement}`,
        hash: locatorHash(
          registryExpression(ctx.catalog, m.page.id, m.member.registryElement) ?? m.member.expression,
          m.member.status,
        ),
      });
  }
  // de-duplicate (derived record-field members share their edit button's registry row)
  return out.filter((d, i) => out.findIndex((x) => x.component === d.component) === i);
}

/** The registry expression of a page's registry element (the edit button behind a derived field member, too). */
function registryExpression(cat: PageCatalog, pageId: string, element: string): string | undefined {
  return cat.pages
    .find((p) => p.id === pageId)
    ?.members.find((m) => m.registryElement === element && m.role !== 'listitem')?.expression;
}

/** What a current registry row looks like, for staleness (`undefined` = no longer in the registry). */
export type LocatorLookup = (page: string, element: string) => { expression: string; status: string } | undefined;

/**
 * Dependencies that no longer match the org: a changed or removed snapshot component, or a locator that changed,
 * left the registry, or is marked RE_VERIFY. Returns `<component> <changed|removed|RE_VERIFY>` lines.
 */
export function staleDependencies(
  deps: readonly SpecDependency[],
  facts: SnapshotFacts,
  locator: LocatorLookup,
): string[] {
  const out: string[] = [];
  for (const d of deps) {
    const i = d.component.indexOf(':');
    const type = d.component.slice(0, i);
    const name = d.component.slice(i + 1);
    if (type === 'Locator') {
      const slash = name.indexOf('/');
      const row = locator(name.slice(0, slash), name.slice(slash + 1));
      if (!row || row.status === 'RETIRED') out.push(`${d.component} removed`);
      else if (locatorHash(row.expression, row.status) !== d.hash)
        out.push(`${d.component} ${row.status === 'RE_VERIFY' ? 'RE_VERIFY' : 'changed'}`);
      continue;
    }
    const now = facts.hashOf(type, name);
    if (now === undefined) out.push(`${d.component} removed`);
    else if (now !== d.hash) out.push(`${d.component} changed`);
  }
  return out;
}
