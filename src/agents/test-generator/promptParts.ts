// Compact, per-case prompt parts for the Test Generator. Measured 2026-11-21 (TC-SF-219-004): the full prompt was
// ~9.6k tokens — 18.9k chars of JSON Schema + 8.9k chars of catalog — over Groq's on-demand per-minute limits
// (gpt-oss-120b 8,000 TPM; qwen3.8-27b 7,000 input TPM). These parts keep the same information the case needs.
import type { TestCase } from '../../core/schemas/testCase.js';
import { caseCorpus, caseObjects, FIELD_ROLES, type GenerationContext, type RecipeView } from './context.js';
import type { CatalogMember, CatalogPage } from './pageObjects.js';

/**
 * Typed contract of the test IR (replaces the 18.9k-char JSON Schema in the prompt; the reply is still validated
 * against the Zod schema). `contract.test.ts` checks every action / assertion kind of the schema appears here.
 */
export const IR_CONTRACT = `Reply with ONE JSON object of this TypeScript type (no prose):
type IR = { caseId: string; data: StepId[]; steps: Step[]; notes: string[] };
type StepId = string; // a recipe step id from "Recipe steps", e.g. "Account" — not an element ref
type Ref = string; // a catalog element ref as listed, e.g. "contact-new.lastName"
type Step = { caseStep: number /* 0-based index of the case step */; title: string; actions: Action[]; assertions: Assertion[] };
type Value =
  | { kind: "data"; ref: StepId; field: string }                 // a recipe field value
  | { kind: "recordId"; ref: StepId | string /* a recordView.as name */ }
  | { kind: "literal"; value: string; evidenceIds: string[] }    // must appear verbatim in the case text / recipe / UI labels
  | { kind: "length"; length: number; evidenceIds: string[] }    // a string of exactly N chars; N must be stated in the case step
  | { kind: "unique"; label: string /* lowercase-kebab */; format?: "text" | "email" | "phone" };
type Expect = { caseStep: number; evidenceIds: string[] /* subset of that case step's evidence ids */ };
type Action =
  | { do: "openRecord"; ref: StepId; object: string /* e.g. "Account" */ }
  | { do: "openNewFromRelatedList"; parentRef: StepId; relatedList: string /* e.g. "Contacts" */ }
  | { do: "fill"; element: Ref; value: Value }      // textbox / spinbutton only
  | { do: "select"; element: Ref; value: Value }             // picklist combobox: value = option label (literal)
  | { do: "clear"; element: Ref }
  | { do: "click"; element: Ref }
  | { do: "selectTab"; element: Ref }
  | { do: "apiUpdate"; ref: StepId; fields: Record<string, Value> }
// NEVER assert URLs or record ids. After a successful create-dialog Save assert recordView ("as"); code checks
// toast, related list, header and SOQL by run tag, and cleans up. Its name field: a "unique" value.
// Preconditions come from the recipe ("data" refs). Never write cleanup or adopt.
// One "unique" per created record; never a QA-run-… value.
type Assertion =
  | { check: "visible" | "hidden"; element: Ref; expect: Expect }
  // message: a "rule ..." or "observed ..." id from the org facts (code supplies the text); else omit it
  | { check: "fieldError"; element: Ref; message?: { rule: string } | { observed: string }; expect: Expect }
  // save warning popover (duplicate alert): an "observed ..." alert id
  | { check: "saveWarning"; observed: string; expect: Expect }
  // a field's current value: textboxes, lookups (e.g. a pre-filled Account Name) and picklists
  | { check: "inputValue"; element: Ref; equals: Value; expect: Expect }
  | { check: "toast"; contains?: Value; expect: Expect }
  | { check: "recordView"; object: string; as?: string; expect: Expect }
  | { check: "recordTitle"; contains: Value; expect: Expect }
  // what the record page shows for a field: element = a "<field>Field" member of the record page (text, email,
  // picklist, lookup name). Phone / date / number values are locale-formatted there: check those with soqlField.
  | { check: "recordField"; element: Ref; contains: Value; expect: Expect }
  | { check: "relatedListHasRecord"; parentRef: StepId; relatedList: string; name: Value; expect: Expect }
  // field may be "Account.Name" (compare a parent by name, never ids)
  | { check: "soqlField"; ref: StepId | string; object: string; field: string; equals: Value; expect: Expect }
  | { check: "soqlNoRecord"; object: string; field: string; value: Value; expect: Expect }
  | { check: "recordExists"; ref: StepId; object: string; exists: boolean; expect: Expect }
  | { check: "apiRejects"; object: string; basedOn: StepId; fields?: Record<string, Value>; remove?: string[]; errorCodes: string[]; expect: Expect }
  | { check: "historyTracked"; ref: StepId | string; object: string; fields: string[]; expect: Expect }
  | { check: "a11yScan"; scope: Ref; expect: Expect }
  | { check: "tabOrder"; scope: Ref; elements: Ref[]; expect: Expect };
Only these "do" and "check" values exist.`;

const mentioned = (text: string, m: CatalogMember): boolean => {
  const names = [m.accessibleName, m.fieldApiName?.split('.')[1]].filter((x): x is string => Boolean(x));
  return names.some((n) =>
    new RegExp(`(^|[^A-Za-z])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z]|$)`, 'i').test(text),
  );
};

/** Pages + members a case can need (the full catalog is still what the checks validate against). */
export function relevantCatalog(ctx: GenerationContext, tc: TestCase, recipe: RecipeView | undefined): CatalogPage[] {
  const text = caseCorpus(tc);
  const objects = new Set([...caseObjects(tc, ctx), ...(recipe?.plan.steps.map((s) => s.object) ?? [])]);
  const allFields = tc.type === 'a11y' || /\ball fields\b|keyboard|tab through/i.test(text);
  const recipeFields = new Set(
    recipe?.plan.steps.flatMap((s) => Object.keys(s.fields).map((f) => `${s.object}.${f}`)) ?? [],
  );
  return (
    ctx.catalog.pages
      // Edit forms have no IR action that opens them yet (openEdit is a follow-up): never offered to the model.
      .filter((p) => objects.has(p.object) && p.kind !== 'edit')
      .map((p) => ({
        ...p,
        members: p.members.filter((m) => {
          if (m.kind === 'region' || m.role === 'tab') return true;
          if (m.role && FIELD_ROLES.has(m.role)) {
            if (p.kind === 'dialog' && allFields) return true;
            return (
              mentioned(text, m) ||
              (m.fieldApiName !== undefined &&
                (recipeFields.has(m.fieldApiName) ||
                  ctx.facts.field(p.object, m.fieldApiName.split('.')[1] ?? '')?.required === true))
            );
          }
          if (m.role === 'button') {
            const n = m.accessibleName ?? '';
            if (/^(New|Save|Cancel|Edit|Delete)$/.test(n)) return true;
            return mentioned(text, m);
          }
          return mentioned(text, m);
        }),
      }))
  );
}

export function catalogText(pages: readonly CatalogPage[]): string {
  return pages
    .map(
      (p) =>
        `${p.id} (${p.kind}${p.kind === 'record' ? ` of ${p.object}` : ''}):\n` +
        p.members
          .map(
            (m) =>
              `  ${m.ref} ${m.role ?? m.kind} "${m.accessibleName ?? ''}"${m.scopeName ? ` in "${m.scopeName}"` : ''}${m.status === 'RE_VERIFY' ? ' RE_VERIFY' : ''}`,
          )
          .join('\n'),
    )
    .join('\n');
}

/** Field facts for the fields the case can touch (recipe fields + catalog fields shown) and rules on them. */
export function factsText(
  ctx: GenerationContext,
  pages: readonly CatalogPage[],
  recipe: RecipeView | undefined,
): string {
  const byObject = new Map<string, Set<string>>();
  const add = (o: string, f: string): void => {
    const set = byObject.get(o) ?? new Set<string>();
    set.add(f);
    byObject.set(o, set);
  };
  for (const s of recipe?.plan.steps ?? []) for (const f of Object.keys(s.fields)) add(s.object, f);
  for (const p of pages)
    for (const m of p.members) if (m.fieldApiName) add(p.object, m.fieldApiName.split('.')[1] ?? '');
  const lines: string[] = [];
  for (const [o, fields] of byObject) {
    for (const f of [...fields].sort()) {
      const fact = ctx.facts.field(o, f);
      if (fact)
        lines.push(`${o}.${f} ${fact.type}${fact.length ? ` ${fact.length}` : ''}${fact.required ? ' required' : ''}`);
    }
    for (const vr of ctx.facts.activeValidationRules(o)) {
      const formula = typeof vr.body?.['errorConditionFormula'] === 'string' ? vr.body['errorConditionFormula'] : '';
      if (![...fields].some((f) => formula.includes(f))) continue;
      const msg = typeof vr.body?.['errorMessage'] === 'string' ? vr.body['errorMessage'] : '';
      lines.push(`${o} rule ${vr.apiName}: "${msg}" when ${formula}`);
    }
    // Accepted UI-observed messages (Explorer, Phase 5): referenced by id, the text is supplied by code.
    for (const m of ctx.observedMessages ?? []) {
      if (!m.accepted || !m.field?.startsWith(`${o}.`) || m.placement === 'page') continue;
      lines.push(
        `${o} observed ${m.id}: ${m.kind} ${m.placement === 'alert' ? 'save warning (saveWarning)' : `message on ${m.field} (fieldError)`} "${m.accepted.text ?? m.text}"`,
      );
    }
  }
  return lines.join('\n');
}
