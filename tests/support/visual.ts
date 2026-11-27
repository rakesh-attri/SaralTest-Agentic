/// <reference lib="dom" />
// Visual helpers for @visual tests (visual-testing skill, PLAN.md §7g):
// - screenshots are taken of one region (dialog, tab panel, record page main), never the whole browser window;
// - values that change per run or per user are masked: record/user names, dates, record IDs, PII, spinners,
//   counters. Labels are NOT masked, so a moved or renamed field still shows as a difference;
// - capture is stabilised (spinners settled, fonts loaded, animations off, caret hidden, no hover/focus ring).
import { expect, type Locator, type Page } from '@playwright/test';
import { join } from 'node:path';
import { waitForSpinners } from './lightning.js';

/** Mask categories from `config/execution.yaml` `visual.mask` (+ `names`, `counters`). */
export type MaskCategory = 'dates' | 'recordIds' | 'spinners' | 'userNames' | 'names' | 'pii' | 'counters';

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Dates and times as Salesforce renders them for common locales (11/27/2026, 27/11/2026, 2026-11-27, 10:05 AM). */
export const DATE_PATTERNS: readonly RegExp[] = [
  /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM|am|pm)?\b/,
];
/** 15/18-character Salesforce IDs (alphanumeric, at least one digit, starting with a key prefix). */
export const RECORD_ID_PATTERN = /\b(?=[A-Za-z0-9]{0,17}\d)[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?\b/;
export const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/;
export const PHONE_PATTERN = /(?:\+?\d[\d ()-]{7,}\d)/;
/** Related-list / tab counters such as "Contacts (1)" or "(10+)". */
export const COUNTER_PATTERN = /\(\d+\+?\)/;

export interface MaskPlan {
  /** Text patterns: the smallest element whose text matches is masked. */
  text: RegExp[];
  /** Mask every link in the region (lookup / owner / user / mailto / tel values render as links). */
  links: boolean;
  /** Mask the record page title (h1: the record name). */
  title: boolean;
  /** Mask role=status elements (spinners, toasts). */
  status: boolean;
}

/**
 * Pure: which locators a set of mask categories needs. `runPrefix` (the run id) masks every synthetic value of this
 * run, e.g. `QA-<run>-Acme …`, wherever it appears (names, emails, the run-tag field).
 */
export function maskPlan(categories: readonly string[], runPrefix?: string): MaskPlan {
  const has = (c: MaskCategory): boolean => categories.includes(c);
  const text: RegExp[] = [];
  if (has('dates')) text.push(...DATE_PATTERNS);
  if (has('recordIds')) text.push(RECORD_ID_PATTERN);
  if (has('pii')) text.push(EMAIL_PATTERN, PHONE_PATTERN);
  if (has('counters')) text.push(COUNTER_PATTERN);
  const names = has('userNames') || has('names');
  if ((names || has('pii')) && runPrefix) text.push(new RegExp(escapeRegExp(runPrefix)));
  return { text, links: names || has('pii'), title: names, status: has('spinners') };
}

export interface RegionMasks {
  /** Elements whose text varies per run: hidden at their own size (no box whose width follows the text length). */
  hide: Locator[];
  /** Painted over by Playwright (fixed-size controls such as a pre-filled lookup input, spinners). */
  mask: Locator[];
}

/**
 * What to hide / mask inside `region` (and page-level spinners / the record title, which may sit outside it).
 * Text values are hidden with `visibility: hidden` instead of a painted mask: a painted box takes the width of the
 * run-unique text (run-p6-fixture-6: 85 px of noise per region from mask widths), a hidden one leaves the same blank
 * space every run while labels and layout stay visible.
 */
/**
 * Text pattern of a `getByText` hide locator. Only the elements whose OWN text matches are hidden, not the matched
 * element: on Lightning `getByText` can return the whole field item (label + value) when the value sits in a nested
 * shadow root — qa-prod run-p6-live-5/6 hid the "Account Name" label with the run-tagged record name.
 */
const TEXT_PATTERN = new WeakMap<Locator, RegExp>();

export function maskLocators(page: Page, region: Locator, plan: MaskPlan): RegionMasks {
  const hide: Locator[] = plan.text.map((re) => {
    const l = region.getByText(re);
    TEXT_PATTERN.set(l, re);
    return l;
  });
  if (plan.links) hide.push(region.getByRole('link'));
  if (plan.title) hide.push(page.getByRole('main').getByRole('heading', { level: 1 }));
  return { hide, mask: plan.status ? [page.getByRole('status')] : [] };
}

/** Attribute + stylesheet that hide volatile values during a screenshot (the style pierces shadow DOM). */
export const VOLATILE_ATTR = 'data-qa-volatile';
export const VOLATILE_STYLE = `[${VOLATILE_ATTR}] { visibility: hidden !important; }`;
/** The same rule as a file: `toHaveScreenshot` takes `stylePath` (only `locator.screenshot` takes `style`). */
export const VOLATILE_STYLE_PATH = join(import.meta.dirname, 'visual-volatile.css');

/** Serializable form of a text pattern (passed into the page). */
const patternArg = (l: Locator): { source: string; flags: string } | null => {
  const re = TEXT_PATTERN.get(l);
  return re ? { source: re.source, flags: re.flags.replace('g', '') } : null;
};

/**
 * Mark the elements of `locators` as volatile; returns how many were marked. For a text pattern, the parent element
 * of every matching text node inside the match is marked (open shadow roots included); when the text is split over
 * several nodes, the matched element itself.
 */
export async function markVolatile(locators: readonly Locator[]): Promise<number> {
  let n = 0;
  for (const l of locators) {
    n += await l.evaluateAll(
      (els, a) => {
        const re = a.pattern ? new RegExp(a.pattern.source, a.pattern.flags) : null;
        const textParents = (e: Element): Element[] => {
          const out: Element[] = [];
          const walk = (x: Element): void => {
            for (const c of Array.from(x.childNodes)) {
              if (c.nodeType === Node.TEXT_NODE && re?.test(c.textContent ?? '')) out.push(x);
            }
            for (const k of [...Array.from(x.shadowRoot?.children ?? []), ...Array.from(x.children)]) walk(k);
          };
          walk(e);
          return out;
        };
        const kids = (x: Element): Element[] => [
          ...Array.from(x.shadowRoot?.children ?? []),
          ...Array.from(x.children),
        ];
        const text = (x: Element): string =>
          Array.from(x.childNodes)
            .filter((c) => c.nodeType === Node.TEXT_NODE)
            .map((c) => c.textContent ?? '')
            .join('') + kids(x).map(text).join('');
        /** Text split over several nodes: the smallest element (across shadow roots) whose text still matches. */
        const deepest = (x: Element): Element => {
          const k = kids(x).find((c) => re?.test(text(c)));
          return k ? deepest(k) : x;
        };
        let count = 0;
        for (const e of els) {
          const targets = re ? textParents(e) : [];
          for (const t of targets.length ? targets : [re ? deepest(e) : e]) {
            t.setAttribute(a.attr, '');
            count++;
          }
        }
        return count;
      },
      { attr: VOLATILE_ATTR, pattern: patternArg(l) },
    );
  }
  return n;
}

/**
 * Lightning's loading placeholders (grey bars drawn before a record layout arrives). run-p6-live-1: the Details panel
 * was captured while `force-placeholder2` was still shown (tablet), and the real fields replaced the marked nodes
 * after masking, so their values showed unmasked. CSS selectors pierce open shadow roots.
 */
export const LOADING_PLACEHOLDERS = 'force-placeholder2, force-placeholder, lightning-skeleton, [aria-busy="true"]';

/**
 * The region is ready: no spinner, no loading placeholder, and its text and size are the same on two reads in a row
 * (Lightning renders fields in several passes). Same check on every viewport.
 */
export async function waitForRegionReady(page: Page, region: Locator, timeout = 30_000): Promise<void> {
  await waitForSpinners(page, timeout);
  // Visible ones only: the Account highlights panel keeps an empty 0×0 force-placeholder2 after load (run-p6-live-2).
  await expect(region.locator(LOADING_PLACEHOLDERS).filter({ visible: true })).toHaveCount(0, { timeout });
  let previous = '';
  await expect
    .poll(
      async () => {
        const now = await region.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return `${(el as HTMLElement).innerText.length}:${Math.round(r.width)}x${Math.round(r.height)}`;
        });
        const stable = now === previous && !now.startsWith('0:');
        previous = now;
        return stable;
      },
      { timeout, intervals: [250, 250, 500, 500, 1000] },
    )
    .toBe(true);
}

/**
 * Record-page fields whose value is always hidden (operator, Phase 6 live): the record name, owners and the system
 * fields. Matched by the field label (exact), so the label and the field position stay in the image.
 */
export const VOLATILE_FIELD_LABELS: readonly string[] = [
  'Name',
  'Account Name',
  'Contact Owner',
  'Account Owner',
  'Owner',
  'Created By',
  'Last Modified By',
];

/**
 * Mark the value part of the fields with these labels as volatile (Lightning record layout items and the fixture's
 * dt/dd pairs; open shadow roots included). Returns how many values were marked.
 */
export async function markFieldValues(region: Locator, labels: readonly string[]): Promise<number> {
  return region.evaluate(
    (root, a) => {
      const wanted = new Set(a.labels);
      const kids = (n: Element): Element[] => [...Array.from(n.shadowRoot?.children ?? []), ...Array.from(n.children)];
      const parentOf = (n: Element): Element | null =>
        n.parentElement ??
        ((n.getRootNode() as ShadowRoot | Document) instanceof ShadowRoot
          ? (n.getRootNode() as ShadowRoot).host
          : null);
      const find = (n: Element, sel: string): Element | null => {
        if (n.matches(sel)) return n;
        for (const k of kids(n)) {
          const f = find(k, sel);
          if (f) return f;
        }
        return null;
      };
      const ownText = (n: Element): string =>
        Array.from(n.childNodes)
          .filter((x) => x.nodeType === Node.TEXT_NODE)
          .map((x) => x.textContent ?? '')
          .join('')
          .trim();
      let marked = 0;
      const visit = (n: Element): void => {
        if (wanted.has(ownText(n))) {
          let value: Element | null = null;
          if (n.tagName === 'DT') value = n.nextElementSibling;
          else {
            // Climb to the layout item that holds both the label and the value, never past it, and never mark an
            // element that contains the label: qa-prod run-p6-live-5 hid the "Account Name" label with its value.
            const holdsLabel = (v: Element): boolean => {
              for (let x: Element | null = n; x; x = parentOf(x)) if (x === v) return true;
              return false;
            };
            for (let p = parentOf(n), d = 0; p && d < 8 && !value; p = parentOf(p), d++) {
              const found = find(p, '.slds-form-element__control, [class*="field-value"]');
              if (found && !holdsLabel(found)) value = found;
              if (/^records-record-layout-item$|^lightning-input-field$/i.test(p.tagName)) break;
            }
          }
          if (value) {
            value.setAttribute(a.attr, '');
            marked++;
          }
        }
        for (const k of kids(n)) visit(k);
      };
      visit(root);
      return marked;
    },
    { labels: [...labels], attr: VOLATILE_ATTR },
  );
}

/**
 * How many elements matched by `locators` are NOT hidden (0 = every volatile value is hidden). An element counts as
 * hidden when it or a (shadow-crossing) ancestor is marked, or — for a text pattern — every matching text inside it is.
 */
export async function unmarkedVolatile(locators: readonly Locator[]): Promise<number> {
  let n = 0;
  for (const l of locators) {
    n += await l.evaluateAll(
      (els, a) => {
        const re = a.pattern ? new RegExp(a.pattern.source, a.pattern.flags) : null;
        const up = (x: Element): Element | null => {
          if (x.parentElement) return x.parentElement;
          const r = x.getRootNode();
          return r instanceof ShadowRoot ? r.host : null;
        };
        const hidden = (x: Element): boolean => {
          for (let p: Element | null = x; p; p = up(p)) if (p.hasAttribute(a.attr)) return true;
          return false;
        };
        const textParents = (e: Element): Element[] => {
          const out: Element[] = [];
          const walk = (x: Element): void => {
            for (const c of Array.from(x.childNodes)) {
              if (c.nodeType === Node.TEXT_NODE && re?.test(c.textContent ?? '')) out.push(x);
            }
            for (const k of [...Array.from(x.shadowRoot?.children ?? []), ...Array.from(x.children)]) walk(k);
          };
          walk(e);
          return out;
        };
        const kids = (x: Element): Element[] => [
          ...Array.from(x.shadowRoot?.children ?? []),
          ...Array.from(x.children),
        ];
        const text = (x: Element): string =>
          Array.from(x.childNodes)
            .filter((c) => c.nodeType === Node.TEXT_NODE)
            .map((c) => c.textContent ?? '')
            .join('') + kids(x).map(text).join('');
        const deepest = (x: Element): Element => {
          const k = kids(x).find((c) => re?.test(text(c)));
          return k ? deepest(k) : x;
        };
        return els.filter((e) => {
          if (hidden(e)) return false;
          const parts = re ? textParents(e) : [];
          if (parts.length) return !parts.every(hidden);
          return !(re && hidden(deepest(e)));
        }).length;
      },
      { attr: VOLATILE_ATTR, pattern: patternArg(l) },
    );
  }
  return n;
}

/**
 * Clip of a page region in document coordinates, taken at the top of the page. A region taller than the viewport is
 * captured with `fullPage` + this clip instead of an element screenshot: an element screenshot scrolls the page,
 * Lightning then pins the record header (fixed, 80 px) over the top row of the Details panel (run-p6-live-1).
 */
export async function pageClip(page: Page, region: Locator): Promise<Clip> {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  return region.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x + window.scrollX),
      y: Math.round(r.y + window.scrollY),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  });
}

/** Make the page still before a screenshot: region ready, fonts loaded, no hover or focus ring. */
export async function settle(page: Page, region?: Locator): Promise<void> {
  if (region) await waitForRegionReady(page, region);
  else await waitForSpinners(page);
  await page.evaluate(async () => {
    await document.fonts.ready;
    let a: Element | null = document.activeElement;
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    if (a instanceof HTMLElement) a.blur();
  });
  await page.mouse.move(0, 0);
}

export interface RegionShotOptions {
  maxDiffPixelRatio: number;
  mask: Locator[];
}

/** Screenshot options used for every baseline (same for capture and comparison). */
export function shotOptions(o: RegionShotOptions): {
  mask: Locator[];
  maskColor: string;
  animations: 'disabled';
  caret: 'hide';
  scale: 'css';
  stylePath: string;
  maxDiffPixelRatio: number;
} {
  return {
    mask: o.mask,
    stylePath: VOLATILE_STYLE_PATH,
    maskColor: '#FF00FF',
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
    maxDiffPixelRatio: o.maxDiffPixelRatio,
  };
}

export interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The visible content box of an overlay region. Lightning (and the fixture) render a modal dialog as a fixed,
 * full-viewport element with the content in one inner container; screenshotting the dialog element would capture the
 * page behind the backdrop (other run data). Descends while exactly one child holds all of the text, and returns that
 * child's box (clamped to the viewport); undefined when the region itself is already the content.
 */
export async function contentClip(region: Locator): Promise<Clip | undefined> {
  return region.evaluate((root) => {
    const kidsOf = (el: Element): Element[] => [
      ...Array.from(el.shadowRoot?.children ?? []),
      ...Array.from(el.children),
    ];
    const text = (el: Element): number => (el instanceof HTMLElement ? el.innerText.trim().length : 0);
    let el: Element = root;
    for (let depth = 0; depth < 12; depth++) {
      const r = el.getBoundingClientRect();
      const withText = kidsOf(el).filter((k) => {
        const kr = k.getBoundingClientRect();
        return kr.width > 0 && kr.height > 0 && text(k) > 0;
      });
      const only = withText[0];
      if (withText.length !== 1 || !only) break;
      const kr = only.getBoundingClientRect();
      if (kr.width * kr.height > 0.9 * r.width * r.height && only.children.length === 0) break;
      el = only;
    }
    if (el === root) return undefined;
    const r = el.getBoundingClientRect();
    const x = Math.max(0, r.x);
    const y = Math.max(0, r.y);
    const width = Math.min(window.innerWidth, r.x + r.width) - x;
    const height = Math.min(window.innerHeight, r.y + r.height) - y;
    const rootBox = root.getBoundingClientRect();
    if (width * height > 0.9 * rootBox.width * rootBox.height) return undefined;
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  });
}

/**
 * Soft screenshot assertion of one region against `<name>.png` (a mismatch is recorded, the test continues so layout
 * and a11y checks still run). With `clip`, the page is captured inside that box (overlay content, see contentClip).
 * The runner turns failures into candidates; nothing here judges them as defects.
 */
export async function expectRegionScreenshot(
  page: Page,
  region: Locator,
  name: string,
  o: RegionShotOptions & { clip?: Clip; fullPage?: boolean },
): Promise<void> {
  if (o.clip) {
    const full = o.fullPage ? { fullPage: true } : {};
    await expect.soft(page).toHaveScreenshot(`${name}.png`, { ...shotOptions(o), clip: o.clip, ...full });
  } else await expect.soft(region).toHaveScreenshot(`${name}.png`, shotOptions(o));
}

/** The same masked image, as bytes (attached to the run so a matching region can still be re-approved). */
export async function regionShot(
  page: Page,
  region: Locator,
  o: RegionShotOptions & { clip?: Clip; fullPage?: boolean },
): Promise<Buffer> {
  const x = shotOptions(o);
  const opts = {
    mask: x.mask,
    maskColor: x.maskColor,
    animations: x.animations,
    caret: x.caret,
    scale: x.scale,
    style: VOLATILE_STYLE,
  };
  if (o.clip) return page.screenshot({ ...opts, clip: o.clip, ...(o.fullPage ? { fullPage: true } : {}) });
  return region.screenshot(opts);
}
