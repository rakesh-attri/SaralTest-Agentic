// Renders a checked test IR into a Playwright spec (playwright-standards skill template). Deterministic: the same
// IR + case + catalog always produce the same file. The mechanical degrade path renders a `test.fixme` skeleton.
import type { IrAction, IrAssertion, TestIR, ValueRef } from '../../core/schemas/generation.js';
import type { TestCase } from '../../core/schemas/testCase.js';
import {
  canonicalList,
  dialogForList,
  featureOf,
  fieldErrorRule,
  listRegion,
  picklistFact,
  recordPageOf,
  type GenerationContext,
  type RecipeView,
} from './context.js';
import { camel, findMember, relatedListNewButton, type CatalogPage, type PageCatalog } from './pageObjects.js';

export const A11Y_SCOPE_NOTE =
  'a11y scope rule (operator, 2026-11-21): the axe scan is limited to the dialog; violations in Salesforce-owned ' +
  'markup are recorded as known baseline findings (annotation + attachment), only violations in our own custom ' +
  'namespaces and the keyboard tab-order check fail the test.';

export interface RenderInput {
  tc: TestCase;
  ir: TestIR;
  ctx: GenerationContext;
  recipe: RecipeView | undefined;
  caseHash: string;
  irHash: string;
  model: string;
}

export function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
}

export const specPath = (storyKey: string, tc: Pick<TestCase, 'id' | 'title'>): string =>
  `tests/generated/${storyKey}/${tc.id}-${slug(tc.title.replace(new RegExp(`^${tc.id}\\s*`), ''))}.spec.ts`;

const q = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
const SEVERITY: Record<string, string> = { CRITICAL: 'critical', MAJOR: 'major', MINOR: 'minor', TRIVIAL: 'trivial' };
const varOf = (p: CatalogPage): string => p.className.charAt(0).toLowerCase() + p.className.slice(1);

class Imports {
  readonly lightning = new Set<string>();
  readonly api = new Set<string>();
  readonly a11y = new Set<string>();
  readonly pages = new Map<string, CatalogPage>();
}

/** Every `<pageId>.<member>` ref an IR touches (incl. related-list navigation) — the dry-run checks these. */
export function locatorsUsed(ir: TestIR, cat: PageCatalog, recipe: RecipeView | undefined): string[] {
  const out = new Set<string>();
  const parentPage = (ref: string): CatalogPage | undefined => {
    const obj = recipe?.plan.steps.find((s) => s.stepId === ref)?.object;
    return obj ? recordPageOf(cat, obj) : undefined;
  };
  for (const st of ir.steps) {
    for (const a of st.actions) {
      if ('element' in a) out.add(a.element);
      if (a.do === 'openNewFromRelatedList') {
        const page = parentPage(a.parentRef);
        const dlg = dialogForList(cat, a.relatedList);
        if (page) {
          const list = listRegion(page, a.relatedList);
          const btn = relatedListNewButton(page, canonicalList(cat, a.relatedList));
          const tab = page.members.find((m) => m.role === 'tab' && m.accessibleName === 'Related');
          for (const m of [list, btn?.name, tab?.name]) if (m) out.add(`${page.id}.${m}`);
        }
        if (dlg) out.add(`${dlg.id}.root`);
      }
    }
    for (const a of st.assertions) {
      if ('element' in a) out.add(a.element);
      if (a.check === 'a11yScan') out.add(a.scope);
      if (a.check === 'tabOrder') [a.scope, ...a.elements].forEach((e) => out.add(e));
      if (a.check === 'relatedListHasRecord') {
        const page = parentPage(a.parentRef);
        const list = page ? listRegion(page, a.relatedList) : undefined;
        if (page && list) out.add(`${page.id}.${list}`);
      }
    }
  }
  return [...out].sort();
}

export function renderSpec(i: RenderInput): string {
  const { tc, ir, ctx } = i;
  const cat = ctx.catalog;
  const imp = new Imports();
  const consts = new Map<string, string>(); // name → initializer
  const viewed = new Set<string>();
  const usesTestInfo = ir.steps.some((s) => s.assertions.some((a) => a.check === 'a11yScan'));
  const fixtures = new Set<string>();

  const page = (ref: string): { v: string; member: string } => {
    const m = findMember(cat, ref);
    if (!m) throw new Error(`unknown element ${ref}`);
    imp.pages.set(m.page.className, m.page);
    return { v: varOf(m.page), member: m.member.name };
  };
  const el = (ref: string): string => {
    const p = page(ref);
    return p.member === 'root' ? `${p.v}.root` : `${p.v}.${p.member}`;
  };
  const recordIdExpr = (ref: string): string => (viewed.has(ref) ? `viewed[${q(ref)}] ?? ''` : `data.id(${q(ref)})`);
  const val = (v: ValueRef): string => {
    switch (v.kind) {
      case 'data':
        return `data.value(${q(v.ref)}, ${q(v.field)})`;
      case 'recordId':
        return recordIdExpr(v.ref);
      case 'literal':
        return q(v.value);
      case 'length': {
        const name = `len${v.length}`;
        consts.set(name, `data.ofLength(${v.length})`);
        return name;
      }
      case 'unique': {
        const name = camel(`${v.label} ${v.format === 'text' ? '' : v.format}`);
        consts.set(name, `data.unique(${q(v.label)}${v.format === 'text' ? '' : `, ${q(v.format)}`})`);
        return name;
      }
    }
  };
  const objectOf = (ref: string): string => i.recipe?.plan.steps.find((s) => s.stepId === ref)?.object ?? ref;

  // Ref opened by the immediately preceding openRecord (an openNewFromRelatedList right after it skips the re-open).
  let lastOpened: string | undefined;
  const action = (a: IrAction): string[] => {
    const justOpened = lastOpened;
    lastOpened = undefined;
    switch (a.do) {
      case 'openRecord': {
        const p = recordPageOf(cat, a.object);
        if (!p) throw new Error(`no record page for ${a.object}`);
        imp.pages.set(p.className, p);
        lastOpened = a.ref;
        return [`await ${varOf(p)}.open(${recordIdExpr(a.ref)});`];
      }
      case 'openNewFromRelatedList': {
        const p = recordPageOf(cat, objectOf(a.parentRef));
        const dlg = dialogForList(cat, a.relatedList);
        const list = p ? listRegion(p, a.relatedList) : undefined;
        const btn = p ? relatedListNewButton(p, canonicalList(cat, a.relatedList)) : undefined;
        if (!p || !dlg || !list || !btn) throw new Error(`cannot open New from ${a.relatedList}`);
        imp.pages.set(p.className, p);
        imp.pages.set(dlg.className, dlg);
        imp.lightning.add('showRelatedList');
        const tab = p.members.find((m) => m.role === 'tab' && m.accessibleName === 'Related');
        return [
          ...(justOpened === a.parentRef ? [] : [`await ${varOf(p)}.open(${recordIdExpr(a.parentRef)});`]),
          `await showRelatedList(${varOf(p)}.${list}${tab ? `, ${varOf(p)}.${tab.name}` : ''});`,
          `await ${varOf(p)}.${btn.name}.click();`,
          `await expect(${varOf(dlg)}.root).toBeVisible();`,
        ];
      }
      case 'fill':
        return [`await ${el(a.element)}.fill(${val(a.value)});`];
      case 'select':
        imp.lightning.add('selectPicklist');
        return [`await selectPicklist(page, ${el(a.element)}, ${val(a.value)});`];
      case 'clear':
        return [`await ${el(a.element)}.clear();`];
      case 'click': {
        imp.lightning.add('waitForSpinners');
        const m = findMember(cat, a.element);
        if (m?.page.kind === 'dialog' && m.member.role === 'button' && m.member.accessibleName === 'Save') {
          pendingCreate = m.page.object; // the record view shown next is the record this Save created
        }
        return [`await ${el(a.element)}.click();`, 'await waitForSpinners(page);'];
      }
      case 'selectTab':
        imp.lightning.add('selectTab');
        return [`await selectTab(${el(a.element)});`];
      case 'apiUpdate': {
        const fields = Object.entries(a.fields)
          .map(([k, v]) => `${k}: ${val(v)}`)
          .join(', ');
        return [`await data.update(${q(a.ref)}, { ${fields} });`];
      }
      case 'adopt':
        return [`await data.adopt(${q(a.as)}, ${q(a.object)}, ${q(a.field)}, ${val(a.value)});`];
    }
  };

  let pendingCreate: string | undefined;
  let autoNamed = 0;
  const assertion = (a: IrAssertion): string[] => {
    switch (a.check) {
      case 'visible':
        return [`await expect(${el(a.element)}).toBeVisible();`];
      case 'hidden':
        return [`await expect(${el(a.element)}).toBeHidden();`];
      case 'inputValue': {
        // A picklist combobox is a button whose text is the value; textboxes and lookups hold it as the input value.
        const pick = picklistFact(ctx, a.element);
        return [`await expect(${el(a.element)}).${pick ? 'toContainText' : 'toHaveValue'}(${val(a.equals)});`];
      }
      case 'fieldError': {
        imp.lightning.add('expectFieldError');
        if (!a.message) return [`await expectFieldError(${el(a.element)});`];
        const r = fieldErrorRule(ctx, a.element, a.message.rule);
        if ('problem' in r) throw new Error(r.problem);
        return [
          `await expectFieldError(${el(a.element)}, ${q(r.message)}); // message of rule ${r.rule} (org snapshot)`,
        ];
      }
      case 'toast':
        imp.lightning.add('expectToast');
        return [`await expectToast(page, ${a.contains ? val(a.contains) : '/\\S/'});`];
      case 'recordView': {
        imp.lightning.add('recordIdFromView');
        // Code-owned cleanup: the record a create-dialog Save produced is registered (ownership-checked, tagged,
        // cleaned up in teardown) right after its id is known. The model never writes this.
        const created = pendingCreate === a.object;
        if (created) pendingCreate = undefined;
        const as = a.as ?? (created ? `created${a.object}${String(++autoNamed)}` : undefined);
        if (!as) return [`await recordIdFromView(page, ${q(a.object)});`];
        viewed.add(as);
        return [
          `viewed[${q(as)}] = await recordIdFromView(page, ${q(a.object)});`,
          ...(created ? [`await data.adoptCreated(${q(as)}, ${q(a.object)}, viewed[${q(as)}]);`] : []),
        ];
      }
      case 'recordField':
        return [`await expect(${el(a.element)}).toContainText(${val(a.contains)});`];
      case 'recordTitle':
        imp.lightning.add('expectRecordTitle');
        return [`await expectRecordTitle(page, ${val(a.contains)});`];
      case 'relatedListHasRecord': {
        const p = recordPageOf(cat, objectOf(a.parentRef));
        const list = p ? listRegion(p, a.relatedList) : undefined;
        if (!p || !list) throw new Error(`no related list ${a.relatedList}`);
        imp.pages.set(p.className, p);
        imp.lightning.add('relatedListRecord');
        return [`await expect(relatedListRecord(${varOf(p)}.${list}, ${val(a.name)})).toBeVisible();`];
      }
      case 'soqlField':
        fixtures.add('sf');
        imp.api.add('soqlValue');
        return [
          `await expect.poll(() => soqlValue(sf, ${q(a.object)}, ${recordIdExpr(a.ref)}, ${q(a.field)})).toBe(${val(a.equals)});`,
        ];
      case 'soqlNoRecord':
        fixtures.add('sf');
        imp.api.add('soqlCount');
        return [`expect(await soqlCount(sf, ${q(a.object)}, ${q(a.field)}, ${val(a.value)})).toBe(0);`];
      case 'apiRejects': {
        const set = Object.entries(a.fields)
          .map(([k, v]) => `${k}: ${val(v)}`)
          .join(', ');
        return [
          '{',
          `  const attempt = await data.attempt(${q(a.basedOn)}, { ${set} }, [${a.remove.map(q).join(', ')}]);`,
          `  expect(attempt.saved, 'Salesforce must reject this ${a.object}').toBe(false);`,
          `  expect(attempt.errorCodes).toEqual(expect.arrayContaining([expect.stringMatching(/^(${a.errorCodes.join('|')})$/)]));`,
          '}',
        ];
      }
      case 'historyTracked':
        fixtures.add('sf');
        imp.api.add('historyFields');
        return [
          `await expect`,
          `  .poll(() => historyFields(sf, ${q(a.object)}, ${recordIdExpr(a.ref)}), { timeout: 60_000 })`,
          `  .toEqual(expect.arrayContaining([${a.fields.map(q).join(', ')}]));`,
        ];
      case 'a11yScan': {
        fixtures.add('a11y');
        imp.a11y.add('scanScoped').add('recordBaseline');
        const scope = el(a.scope);
        const name = findMember(cat, a.scope)?.page.title ?? a.scope;
        return [
          '{',
          `  const scan = await scanScoped(page, ${scope}, a11y);`,
          `  await recordBaseline(testInfo, ${q(name)}, scan); // Salesforce-owned violations: known baseline, not failures`,
          `  expect(scan.failing, 'axe violations in our own custom components').toEqual([]);`,
          '}',
        ];
      }
      case 'tabOrder': {
        imp.a11y.add('checkTabOrder');
        const map = a.elements.map((e) => `${findMember(cat, e)?.member.name ?? e}: ${el(e)}`).join(', ');
        return [
          '{',
          `  const keyboard = await checkTabOrder(page, ${el(a.scope)}, { ${map} });`,
          `  expect(keyboard.missing, 'every field reachable by Tab').toEqual([]);`,
          `  expect(keyboard.leftScope, 'focus stays inside the dialog').toBe(false);`,
          `  expect(keyboard.inOrder, 'Tab follows the visual reading order').toBe(true);`,
          '}',
        ];
      }
    }
  };

  // Body first (collects imports/consts), then assemble the file.
  const body: string[] = [];
  if (ir.data.length && i.recipe) body.push(`await data.create(${q(i.recipe.name)}, [${ir.data.map(q).join(', ')}]);`);
  ir.steps.forEach((st, n) => {
    // An assertion line identical to one already in the step (e.g. the model's "dialog visible" after
    // openNewFromRelatedList, which already waits for the dialog) is dropped: web-first expects are side-effect free.
    const lines = [...st.actions.flatMap(action), ...st.assertions.flatMap(assertion)].filter(
      (l, k, all) => !l.startsWith('await expect(') || all.indexOf(l) === k,
    );
    const exp = tc.steps[st.caseStep]?.expected;
    body.push(
      `await test.step(${q(`${n + 1}. ${st.title}`)}, async () => {`,
      ...(exp
        ? [`  // Expected (${exp.evidenceLevel}; ${exp.evidenceIds.join(', ')}): ${exp.text.replace(/\s+/g, ' ')}`]
        : []),
      ...lines.map((l) => `  ${l}`),
      '});',
    );
  });

  const feature = featureOf(tc, ctx);
  const notes = [
    ...ir.notes,
    ...(ir.steps.some((s) => s.assertions.some((a) => a.check === 'a11yScan')) ? [A11Y_SCOPE_NOTE] : []),
  ];
  const code = [...body, ...consts.values()].join(' '); // imports and fixtures only for what the test uses
  const L: string[] = [];
  L.push(
    `// Generated by sf-qa-agent (Test Generator) from ${tc.id} — do not edit; regenerate with \`qa build\`.`,
    `// Case hash ${i.caseHash} · IR hash ${i.irHash} · design run ${ctx.designRunId} · case snapshot ${tc.snapshotId} · built on snapshot ${ctx.snapshotId}`,
    `// Org page objects: ${cat.orgAlias} (${cat.environment}) · model: ${i.model}`,
    `// Requirements: ${tc.requirementIds.join(', ')} · refs: ${tc.refs.join(', ') || '-'} · technique: ${tc.technique}`,
    ...(i.recipe
      ? [`// Data: approved recipe ${i.recipe.name} (steps ${ir.data.join(', ') || 'none'}), cleaned up after the test`]
      : []),
    ...notes.map((n) => `// Note: ${n.replace(/\s+/g, ' ')}`),
    `import { ${/\bexpect\b/.test(code) ? 'test, expect' : 'test'} } from '../../fixtures/index.js';`,
    `import { meta } from 'reporting-labs';`,
  );
  for (const p of [...imp.pages.values()].sort((a, b) => a.className.localeCompare(b.className))) {
    L.push(`import { ${p.className} } from '../../pages/${p.className}.js';`);
  }
  if (imp.lightning.size)
    L.push(`import { ${[...imp.lightning].sort().join(', ')} } from '../../support/lightning.js';`);
  if (imp.api.size) L.push(`import { ${[...imp.api].sort().join(', ')} } from '../../support/api.js';`);
  if (imp.a11y.size) L.push(`import { ${[...imp.a11y].sort().join(', ')} } from '../../support/a11y.js';`);
  L.push(
    '',
    `test.describe(${q(`${ctx.storyKey} ${tc.title}`)}, () => {`,
    `  test.describe.configure({ mode: 'parallel' });`,
    '',
  );
  const tags = [...new Set([...tc.tags, `@${tc.type}`, `@persona:${tc.persona}`])];
  // Request only the fixtures the test uses (an unused `page` / `data` would fail lint).
  if (imp.pages.size || /\bpage\b/.test(code)) fixtures.add('page');
  if (/\bdata\./.test(code)) fixtures.add('data');
  const args = [...fixtures].sort((a, b) => (a === 'page' ? -1 : b === 'page' ? 1 : a.localeCompare(b)));
  L.push(
    `  test(${q(`${tc.id} ${tc.title}`)}, { tag: [${tags.map(q).join(', ')}] }, async ({ ${args.join(', ')} }${usesTestInfo ? ', testInfo' : ''}) => {`,
    `    meta({ priority: ${q(tc.priority)}, severity: ${q(SEVERITY[tc.severity] ?? 'minor')}, feature: ${q(feature)}, story: ${q(ctx.storyKey)}, owner: 'qa-agent', testCase: ${q(tc.id)} });`,
  );
  for (const p of [...imp.pages.values()].sort((a, b) => a.className.localeCompare(b.className))) {
    L.push(`    const ${varOf(p)} = new ${p.className}(page);`);
  }
  for (const [name, init] of consts) L.push(`    const ${name} = ${init};`);
  if (viewed.size) L.push('    const viewed: Record<string, string> = {};');
  L.push(...body.map((l) => `    ${l}`), '  });', '});', '');
  return L.join('\n');
}

/** Degrade path (no model / invalid output): a skeleton that never passes silently — the steps are listed for a human. */
export function renderSkeleton(tc: TestCase, ctx: GenerationContext, reason: string, caseHash: string): string {
  const tags = [...new Set([...tc.tags, `@${tc.type}`, `@persona:${tc.persona}`, '@mechanical'])];
  const L = [
    `// MECHANICAL skeleton for ${tc.id} — the Test Generator could not produce a checked test (${reason.replace(/\s+/g, ' ').slice(0, 200)}).`,
    `// Case hash ${caseHash} · design run ${ctx.designRunId}. REVIEW_REQUIRED: a human must implement it; it is skipped (fixme).`,
    `import { test } from '../../fixtures/index.js';`,
    `import { meta } from 'reporting-labs';`,
    '',
    `test.describe(${q(`${ctx.storyKey} ${tc.title}`)}, () => {`,
    `  test.fixme(${q(`${tc.id} ${tc.title}`)}, { tag: [${tags.map(q).join(', ')}] }, async () => {`,
    `    meta({ priority: ${q(tc.priority)}, severity: ${q(SEVERITY[tc.severity] ?? 'minor')}, feature: ${q(featureOf(tc, ctx))}, story: ${q(ctx.storyKey)}, owner: 'qa-agent', testCase: ${q(tc.id)} });`,
    ...tc.steps.flatMap((s, n) => [
      `    await test.step(${q(`${n + 1}. ${s.action}`)}, async () => {`,
      `      // Expected (${s.expected.evidenceLevel}): ${s.expected.text.replace(/\s+/g, ' ')}`,
      '    });',
    ]),
    '  });',
    '});',
    '',
  ];
  return L.join('\n');
}
