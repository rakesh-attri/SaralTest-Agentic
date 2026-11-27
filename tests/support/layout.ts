/// <reference lib="dom" />
// Local layout checks (visual-testing skill, PLAN.md §7g): deterministic, read-only, no AI.
// Element boxes are collected in the browser (shadow DOM included); the analysis is a pure function so it is unit
// tested without a browser. Every finding is a review candidate in the visual-diff report, never a defect by itself.
import type { Locator, Page } from '@playwright/test';
import { layoutFindingFails, type LayoutFinding, type VisualRegion } from '../../src/core/schemas/visual.js';

export interface ElementBox {
  /** Index in the snapshot; `parent` is the index of the nearest collected ancestor (or -1). */
  index: number;
  parent: number;
  name: string;
  role: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  required: boolean;
  interactive: boolean;
  /** Fixed-text element (label, button, tab) whose text is cut off: scrollWidth − clientWidth in px. */
  overflowPx: number;
  /** Component owner from the nearest namespaced ancestor (custom namespace → ours, standard → salesforce). */
  owner?: 'salesforce' | 'ours';
  /** Inside a fixed / sticky container (Lightning's pinned record header, a modal's sticky footer). */
  pinned?: boolean;
  /** A field control (textbox, combobox, checkbox, …), not a button or link. */
  field?: boolean;
}

export interface LayoutSnapshot {
  viewport: { width: number; height: number };
  boxes: ElementBox[];
  /** Owner of the page itself (Lightning → salesforce): used for page-level findings such as layout shift. */
  pageOwner?: 'salesforce' | 'ours';
}

export interface PageStateSnapshot {
  bodyTextLength: number;
  hasMain: boolean;
  spinnersVisible: number;
  errorTexts: string[];
}

export interface LayoutOptions {
  region: VisualRegion;
  viewport: string;
  /** Overlap below this area (px²) is ignored (borders / focus outlines touching). */
  minOverlapPx2?: number;
  layoutShift?: number;
  layoutShiftThreshold?: number;
  /** a11y namespaces from config/execution.yaml: custom = ours, standard = Salesforce-owned. */
  customNamespaces?: readonly string[];
  standardNamespaces?: readonly string[];
}

const area = (a: ElementBox, b: ElementBox): number => {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

function isAncestor(boxes: ElementBox[], anc: number, node: number): boolean {
  let p = boxes[node]?.parent ?? -1;
  while (p >= 0) {
    if (p === anc) return true;
    p = boxes[p]?.parent ?? -1;
  }
  return false;
}

/** Ours when any element involved is ours (or unknown); Salesforce-owned only when every one is. */
const ownerOf = (...boxes: ElementBox[]): 'salesforce' | 'ours' =>
  boxes.every((b) => b.owner === 'salesforce') ? 'salesforce' : 'ours';

/** The findings that fail the test (ours, a real field overlap, or a broken page state). */
export function layoutFails(findings: readonly LayoutFinding[]): LayoutFinding[] {
  return findings.filter((f) => layoutFindingFails(f));
}

/** Pure analysis of one region's element boxes. */
export function analyzeLayout(snap: LayoutSnapshot, o: LayoutOptions): LayoutFinding[] {
  const out: LayoutFinding[] = [];
  const base = { region: o.region, viewport: o.viewport, elements: [] as string[] };
  const minOverlap = o.minOverlapPx2 ?? 16;
  const shown = snap.boxes.filter((b) => b.visible && b.width > 0 && b.height > 0);
  const interactive = shown.filter((b) => b.interactive);
  for (let i = 0; i < interactive.length; i++) {
    for (let j = i + 1; j < interactive.length; j++) {
      const a = interactive[i];
      const b = interactive[j];
      if (!a || !b || isAncestor(snap.boxes, a.index, b.index) || isAncestor(snap.boxes, b.index, a.index)) continue;
      const ov = area(a, b);
      if (ov >= minOverlap) {
        out.push({
          ...base,
          kind: 'overlap',
          elements: [a.name, b.name],
          detail: `"${a.name}" (${a.role}) and "${b.name}" (${b.role}) overlap by ${Math.round(ov)} px²`,
          value: Math.round(ov),
          owner: ownerOf(a, b),
          fieldOverlap: Boolean(a.field && b.field && !a.pinned && !b.pinned),
        });
      }
    }
  }
  for (const b of shown) {
    if (b.overflowPx > 1) {
      out.push({
        ...base,
        kind: 'clipped-text',
        elements: [b.name],
        detail: `"${b.name}" (${b.role}) text is cut off by ${Math.round(b.overflowPx)} px`,
        value: Math.round(b.overflowPx),
        owner: ownerOf(b),
        fieldOverlap: false,
      });
    }
    if (b.interactive && (b.x + b.width > snap.viewport.width + 1 || b.x < -1)) {
      out.push({
        ...base,
        kind: 'off-screen',
        elements: [b.name],
        detail: `"${b.name}" (${b.role}) extends outside the ${snap.viewport.width}px-wide viewport (x ${Math.round(b.x)}, width ${Math.round(b.width)})`,
        owner: ownerOf(b),
        fieldOverlap: false,
      });
    }
  }
  for (const b of snap.boxes) {
    if (b.required && (!b.visible || b.width === 0 || b.height === 0)) {
      out.push({
        ...base,
        kind: 'hidden-required',
        elements: [b.name],
        detail: `required control "${b.name}" (${b.role}) is not visible`,
        owner: ownerOf(b),
        fieldOverlap: false,
      });
    }
  }
  if (o.layoutShift !== undefined && o.layoutShift > (o.layoutShiftThreshold ?? 0.1)) {
    out.push({
      ...base,
      kind: 'layout-shift',
      detail: `cumulative layout shift ${o.layoutShift.toFixed(3)} > ${String(o.layoutShiftThreshold ?? 0.1)}`,
      value: Number(o.layoutShift.toFixed(4)),
      // load-time shift of the page: Salesforce's on a Lightning page, ours on a page we render
      owner: snap.pageOwner ?? 'ours',
      fieldOverlap: false,
    });
  }
  return out;
}

/** Pure: blank page, loading that never finished, or an error banner. */
export function analyzePageState(s: PageStateSnapshot, o: Pick<LayoutOptions, 'region' | 'viewport'>): LayoutFinding[] {
  const out: LayoutFinding[] = [];
  const base = { region: o.region, viewport: o.viewport, elements: [] as string[] };
  if (!s.hasMain || s.bodyTextLength < 20) {
    out.push({
      ...base,
      kind: 'blank-page',
      detail: `page looks blank (main region ${s.hasMain ? 'present' : 'missing'}, ${s.bodyTextLength} chars of text)`,
      owner: 'ours',
      fieldOverlap: false,
    });
  }
  if (s.spinnersVisible > 0) {
    out.push({
      ...base,
      kind: 'loading-not-finished',
      detail: `${s.spinnersVisible} loading indicator(s) still visible`,
      owner: 'ours',
      fieldOverlap: false,
    });
  }
  for (const t of s.errorTexts)
    out.push({ ...base, kind: 'error-banner', detail: `error shown: ${t}`, owner: 'ours', fieldOverlap: false });
  return out;
}

/** Installs a `PerformanceObserver` that sums layout-shift entries (call before navigation). */
export async function observeLayoutShift(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __qaLayoutShift: number };
    w.__qaLayoutShift = 0;
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
          if (!e.hadRecentInput) w.__qaLayoutShift += e.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {
      // layout-shift entries not supported by this browser: the score stays 0
    }
  });
}

export async function readLayoutShift(page: Page): Promise<number | undefined> {
  return page.evaluate(() => (window as unknown as { __qaLayoutShift?: number }).__qaLayoutShift);
}

/** Collect element boxes of one region (open shadow roots included). Names are accessible names, never values. */
export async function collectLayout(
  region: Locator,
  ns: { custom: readonly string[]; standard: readonly string[] } = { custom: [], standard: [] },
): Promise<LayoutSnapshot> {
  return region.evaluate(
    (root, nsArg) => {
      const custom = nsArg.custom;
      const standard = nsArg.standard;
      const parentOf = (n: Element): Element | null => {
        if (n.parentElement) return n.parentElement;
        const r = n.getRootNode();
        return r instanceof ShadowRoot ? r.host : null;
      };
      const nsOwner = (tag: string): 'salesforce' | 'ours' | undefined => {
        const t = tag.toLowerCase();
        if (!t.includes('-')) return undefined;
        if (custom.some((c) => t.startsWith(`${c}-`))) return 'ours';
        if (standard.some((x) => t.startsWith(x.endsWith('_') ? x : `${x}-`))) return 'salesforce';
        return undefined;
      };
      /** Nearest namespaced ancestor decides (a custom component inside a Lightning page is ours). */
      const ownerOfEl = (el: Element): 'salesforce' | 'ours' => {
        for (let p: Element | null = el; p; p = parentOf(p)) {
          const o = nsOwner(p.tagName);
          if (o) return o;
        }
        return 'ours';
      };
      const pinnedEl = (el: Element): boolean => {
        for (let p: Element | null = el; p; p = parentOf(p)) {
          const pos = getComputedStyle(p).position;
          if (pos === 'fixed' || pos === 'sticky') return true;
        }
        return false;
      };
      const FIELD = new Set(['textbox', 'combobox', 'checkbox', 'radio', 'searchbox', 'spinbutton', 'switch']);
      const INTERACTIVE = new Set([
        'button',
        'link',
        'textbox',
        'combobox',
        'checkbox',
        'radio',
        'tab',
        'searchbox',
        'spinbutton',
        'menuitem',
        'switch',
      ]);
      const FIXED_TEXT = new Set(['label', 'button', 'tab', 'heading']);
      const roleOf = (el: Element): string => {
        const r = el.getAttribute('role');
        if (r) return r;
        const tag = el.tagName.toLowerCase();
        if (tag === 'button') return 'button';
        if (tag === 'a' && el.hasAttribute('href')) return 'link';
        if (tag === 'select') return 'combobox';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'label') return 'label';
        if (/^h[1-6]$/.test(tag)) return 'heading';
        if (tag === 'input') {
          const t = (el as HTMLInputElement).type;
          if (t === 'hidden') return '';
          if (t === 'checkbox' || t === 'radio') return t;
          if (t === 'button' || t === 'submit') return 'button';
          return 'textbox';
        }
        return '';
      };
      const rootNode = (el: Element): Document | ShadowRoot => el.getRootNode() as Document | ShadowRoot;
      /**
       * Lookup inside the element's own tree. Lightning Locker forbids ShadowRoot.getElementById (qa-prod
       * run-p6-live-4); querySelector is tried next, and a blocked lookup just yields no name.
       */
      const inRoot = (el: Element, selector: string, id?: string): Element | null => {
        const root = rootNode(el);
        try {
          if (id !== undefined && root instanceof Document) return root.getElementById(id);
          return root.querySelector(selector);
        } catch {
          return null;
        }
      };
      /** Text without aria-hidden parts (e.g. the required "*"), as an accessible name would read. */
      const textOf = (el: Element): string => {
        let t = '';
        for (const n of Array.from(el.childNodes)) {
          if (n.nodeType === Node.TEXT_NODE) t += n.textContent ?? '';
          else if (n instanceof Element && n.getAttribute('aria-hidden') !== 'true') t += textOf(n);
        }
        return t.replace(/\s+/g, ' ').trim();
      };
      const nameOf = (el: Element): string => {
        const aria = el.getAttribute('aria-label');
        if (aria) return aria.trim().slice(0, 60);
        const by = el.getAttribute('aria-labelledby');
        if (by) {
          const t = by
            .split(/\s+/)
            .map((id) => {
              const r = inRoot(el, `[id="${CSS.escape(id)}"]`, id);
              return r ? textOf(r) : '';
            })
            .join(' ')
            .trim();
          if (t) return t.slice(0, 60);
        }
        if (el.id) {
          const lab = inRoot(el, `label[for="${CSS.escape(el.id)}"]`);
          if (lab && textOf(lab)) return textOf(lab).slice(0, 60);
        }
        const role = roleOf(el);
        // field values (textbox content, link text of record names) are never collected
        if (role === 'textbox' || role === 'combobox' || role === 'link')
          return el.getAttribute('title')?.slice(0, 60) ?? role;
        return textOf(el).slice(0, 60) || role;
      };
      const boxes: {
        index: number;
        parent: number;
        name: string;
        role: string;
        x: number;
        y: number;
        width: number;
        height: number;
        visible: boolean;
        required: boolean;
        interactive: boolean;
        overflowPx: number;
        owner: 'salesforce' | 'ours';
        pinned: boolean;
        field: boolean;
      }[] = [];
      const walk = (node: Element, parent: number): void => {
        let me = parent;
        const role = roleOf(node);
        if (role && (INTERACTIVE.has(role) || FIXED_TEXT.has(role))) {
          const r = node.getBoundingClientRect();
          const cs = getComputedStyle(node);
          const visible =
            cs.display !== 'none' &&
            cs.visibility !== 'hidden' &&
            Number(cs.opacity) > 0 &&
            r.width > 0 &&
            r.height > 0;
          const required = node.hasAttribute('required') || node.getAttribute('aria-required') === 'true';
          const he = node as HTMLElement;
          const overflowPx =
            FIXED_TEXT.has(role) && cs.overflow !== 'visible' ? Math.max(0, he.scrollWidth - he.clientWidth) : 0;
          me = boxes.length;
          boxes.push({
            index: me,
            parent,
            name: nameOf(node),
            role,
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            visible,
            required,
            interactive: INTERACTIVE.has(role),
            overflowPx,
            owner: ownerOfEl(node),
            pinned: pinnedEl(node),
            field: FIELD.has(role),
          });
        }
        if (node.shadowRoot) for (const c of Array.from(node.shadowRoot.children)) walk(c, me);
        for (const c of Array.from(node.children)) walk(c, me);
      };
      walk(root, -1);
      const lightning =
        standard.length > 0 && document.querySelector('one-app-nav-bar, one-appnav, force-aloha-page') !== null;
      const pageOwner: 'salesforce' | 'ours' = lightning || ownerOfEl(root) === 'salesforce' ? 'salesforce' : 'ours';
      return { viewport: { width: window.innerWidth, height: window.innerHeight }, boxes, pageOwner };
    },
    { custom: [...ns.custom], standard: [...ns.standard] },
  );
}

const ERROR_TEXT = /Sorry to interrupt|Looks like there's a problem|Something went wrong|An unexpected error/i;

/** Page-level state for blank / loading / error-banner checks. */
export async function collectPageState(page: Page, region?: Locator): Promise<PageStateSnapshot> {
  const spinnersVisible = await page.getByRole('status', { name: /^Loading/ }).count();
  // A modal dialog hides the page's main landmark from the accessibility tree (aria-hidden): the dialog is the page
  // content then (run-p6-live-1 reported the open New Contact dialog as "blank").
  const isDialog = region
    ? await region.evaluate((el) => el.tagName === 'DIALOG' || el.getAttribute('role') === 'dialog')
    : false;
  const hasMain = isDialog || (await page.getByRole('main').count()) > 0;
  const bodyText = await page.evaluate(() => document.body.innerText);
  const bodyTextLength = bodyText.trim().length;
  const alerts = await page.getByRole('alert').allInnerTexts();
  const errorTexts = alerts.map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => ERROR_TEXT.test(t));
  const m = ERROR_TEXT.exec(bodyText);
  if (m && !errorTexts.length) errorTexts.push(m[0]);
  return { bodyTextLength, hasMain, spinnersVisible, errorTexts };
}

/** All layout + page-state findings for one region (read-only). */
export async function checkLayout(page: Page, region: Locator, o: LayoutOptions): Promise<LayoutFinding[]> {
  const layoutShift = o.layoutShift ?? (await readLayoutShift(page));
  return [
    ...analyzePageState(await collectPageState(page, region), o),
    ...analyzeLayout(
      await collectLayout(region, { custom: o.customNamespaces ?? [], standard: o.standardNamespaces ?? [] }),
      { ...o, ...(layoutShift === undefined ? {} : { layoutShift }) },
    ),
  ];
}
