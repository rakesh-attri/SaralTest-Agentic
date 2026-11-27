/// <reference lib="dom" />
// Accessibility helpers for @a11y tests (operator rule 2026-11-21, playwright-standards + visual-testing skills):
// - axe scans are scoped to one region (e.g. the New Contact dialog);
// - violations whose target path only holds Salesforce-owned markup are KNOWN BASELINE findings: recorded as an
//   annotation + attachment, never a failure (we cannot fix Salesforce's own components);
// - violations inside our own custom namespaces (config/execution.yaml a11y.customNamespaces) fail the test;
// - the keyboard check (reachability, focus trap, visual reading order) fails the test.
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { expectedTabOrder, type LayoutSection, type PlacedElement } from '../../src/visual/tabOrder.js';

export interface A11yNamespaces {
  customNamespaces: string[];
  standardNamespaces: string[];
}

export interface ClassifiedViolation {
  ruleId: string;
  impact: string | null;
  help: string;
  helpUrl: string;
  /** Selector path of each affected node (shadow-DOM hops joined with " >>> "). */
  targets: string[];
}

export interface A11yScanResult {
  /** Violations in our own custom components: these fail the test. */
  failing: ClassifiedViolation[];
  /** Violations in Salesforce-owned markup: known baseline findings, recorded only. */
  baseline: ClassifiedViolation[];
  passes: number;
}

/** Minimal shape of axe results used here (keeps the classifier testable without a browser). */
export interface AxeLikeResults {
  violations: {
    id: string;
    impact?: string | null;
    help: string;
    helpUrl: string;
    /** `ancestry` (axe option `ancestry: true`) holds the full element path used for classification. */
    nodes: { target: unknown[]; ancestry?: unknown[]; html?: string }[];
  }[];
  passes: unknown[];
}

const CUSTOM_TAG = /(?:^|[\s>~+(,])([a-z][a-z0-9_]*)-[a-z0-9-]+/g;

function targetText(target: unknown[]): string {
  return target.map((t) => (Array.isArray(t) ? t.map(String).join(' >>> ') : String(t))).join(' >>> ');
}

/** Namespaces of the custom elements (tags with a hyphen) on a node's selector path and in its own HTML tag. */
export function namespacesOf(target: string, html = ''): string[] {
  const ns = new Set<string>();
  for (const m of target.matchAll(CUSTOM_TAG)) if (m[1]) ns.add(m[1]);
  const own = /^<([a-z][a-z0-9_]*)-[a-z0-9-]+/.exec(html.trim());
  if (own?.[1]) ns.add(own[1]);
  return [...ns];
}

/** A node is ours when its path contains a custom-namespace element (e.g. `c-contact-banner`). */
export function isCustomNode(target: string, html: string, ns: A11yNamespaces): boolean {
  return namespacesOf(target, html).some((n) => ns.customNamespaces.includes(n));
}

export function classifyViolations(results: AxeLikeResults, ns: A11yNamespaces): A11yScanResult {
  const failing: ClassifiedViolation[] = [];
  const baseline: ClassifiedViolation[] = [];
  for (const v of results.violations) {
    const mine: string[] = [];
    const theirs: string[] = [];
    for (const n of v.nodes) {
      const t = targetText(n.target);
      const path = n.ancestry ? targetText(n.ancestry) : t;
      (isCustomNode(path, n.html ?? '', ns) ? mine : theirs).push(t);
    }
    const base = { ruleId: v.id, impact: v.impact ?? null, help: v.help, helpUrl: v.helpUrl };
    if (mine.length) failing.push({ ...base, targets: mine });
    if (theirs.length) baseline.push({ ...base, targets: theirs });
  }
  return { failing, baseline, passes: results.passes.length };
}

/** Run axe on exactly one region. The region is marked with a one-off attribute so `include` cannot over-match. */
export async function scanScoped(page: Page, scope: Locator, ns: A11yNamespaces): Promise<A11yScanResult> {
  const token = randomBytes(6).toString('hex');
  await scope.evaluate((el, t) => {
    el.setAttribute('data-qa-a11y-scope', t);
  }, token);
  try {
    const results = await new AxeBuilder({ page })
      .include(`[data-qa-a11y-scope="${token}"]`)
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .options({ ancestry: true })
      .analyze();
    return classifyViolations(results, ns);
  } finally {
    await scope.evaluate((el) => {
      el.removeAttribute('data-qa-a11y-scope');
    });
  }
}

/** Record Salesforce-owned violations as known baseline findings (annotation + JSON attachment), not failures. */
export async function recordBaseline(testInfo: TestInfo, scopeName: string, r: A11yScanResult): Promise<void> {
  for (const v of r.baseline) {
    testInfo.annotations.push({
      type: 'a11y-baseline',
      description: `${scopeName}: ${v.ruleId} (${v.impact ?? 'n/a'}) on ${v.targets.length} Salesforce-owned node(s) — ${v.help}`,
    });
  }
  await testInfo.attach('a11y-baseline.json', {
    body: JSON.stringify({ scope: scopeName, baseline: r.baseline, failing: r.failing }, null, 2),
    contentType: 'application/json',
  });
}

export interface TabOrderResult {
  /** Element names in the order focus first reached them. */
  visited: string[];
  /** Elements never reached by Tab. */
  missing: string[];
  /** Focus left the scope (no focus trap) before every element was reached. */
  leftScope: boolean;
  /** Expected order: from the layout sections' Tab direction when given, else visual reading order. */
  expectedOrder: string[];
  /** Where each element's expected position came from ("Contact Information (TopToBottom)" / "visual order"). */
  basis: Record<string, string>;
  /** The visited order follows the visual reading order. */
  inOrder: boolean;
}

/**
 * Keyboard check. Focus starts on the element that is first in document order; Tab is pressed until every element
 * was reached, focus leaves the scope, or a bound is hit. Order is measured against the elements' on-screen boxes at runtime (no stored order is asserted).
 */
export interface TabOrderOptions {
  rowTolerancePx?: number;
  /** Page layout sections of the org (src/visual/tabOrder.ts `layoutSections`): their Tab direction is expected. */
  sections?: readonly LayoutSection[];
  /** Element name → field API name it edits (FirstName, MailingStreet, AccountId …). */
  fields?: Record<string, string>;
}

export async function checkTabOrder(
  page: Page,
  scope: Locator,
  elements: Record<string, Locator>,
  o: TabOrderOptions = {},
): Promise<TabOrderResult> {
  const names = Object.keys(elements);
  const boxes: PlacedElement[] = [];
  for (const name of names) {
    const el = elements[name];
    const box = el ? await el.boundingBox() : null;
    const field = o.fields?.[name];
    if (box) boxes.push({ name, x: box.x, y: box.y, ...(field ? { field } : {}) });
  }
  const { order: expectedOrder, basis } = expectedTabOrder(boxes, o.sections ?? [], o.rowTolerancePx ?? 12);

  const isFocused = (loc: Locator): Promise<boolean> =>
    loc.evaluate((el) => {
      let a: Element | null = document.activeElement;
      while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
      return a === el || (a !== null && el.contains(a));
    });
  const focusInScope = (): Promise<boolean> =>
    scope.evaluate((root) => {
      let a: Element | null = document.activeElement;
      while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
      let n: Node | null = a;
      while (n) {
        if (n === root) return true;
        n = n.parentNode ?? (n instanceof ShadowRoot ? n.host : null);
      }
      return false;
    });

  // Start where the expected order starts. compareDocumentPosition is arbitrary across shadow roots (Lightning),
  // so "first in document order" started the dialog at First Name and Phone was only reached after wrapping (R1/R2).
  const first = expectedOrder[0];
  if (first) await elements[first]?.focus();
  const visited: string[] = [];
  let leftScope = false;
  const maxPresses = names.length * 4 + 10;
  for (let i = 0; i <= maxPresses && visited.length < names.length; i++) {
    for (const name of names) {
      const el = elements[name];
      if (el && !visited.includes(name) && (await isFocused(el))) visited.push(name);
    }
    if (visited.length === names.length) break;
    if (!(await focusInScope())) {
      leftScope = true;
      break;
    }
    await page.keyboard.press('Tab');
  }
  const missing = names.filter((n) => !visited.includes(n));
  const inOrder = expectedOrder.filter((n) => visited.includes(n)).every((n, i) => visited[i] === n);
  return { visited, missing, leftScope, expectedOrder, basis, inOrder };
}

const NAMED_ROLES = 'button|textbox|combobox|checkbox|radio|link|tab|searchbox|spinbutton|switch|menuitem|listbox';
const ARIA_LINE = new RegExp(String.raw`^\s*- (${NAMED_ROLES})(?: "((?:[^"\\]|\\.)*)")?(?=[\s:[]|$)`);

/**
 * Controls without an accessible name, from a Playwright ARIA snapshot (`locator.ariaSnapshot()`, the browser's own
 * accessible-name computation). Returns `<role> #<n>` (n = position among controls of that role); values are never read.
 */
export function unnamedControls(ariaSnapshot: string): string[] {
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (const line of ariaSnapshot.split(/\r?\n/)) {
    const m = ARIA_LINE.exec(line);
    if (!m?.[1]) continue;
    const n = (seen.get(m[1]) ?? 0) + 1;
    seen.set(m[1], n);
    if (!m[2]?.trim()) out.push(`${m[1]} #${String(n)}`);
  }
  return out;
}
