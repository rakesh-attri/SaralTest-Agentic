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
export function maskLocators(page: Page, region: Locator, plan: MaskPlan): RegionMasks {
  const hide: Locator[] = plan.text.map((re) => region.getByText(re));
  if (plan.links) hide.push(region.getByRole('link'));
  if (plan.title) hide.push(page.getByRole('main').getByRole('heading', { level: 1 }));
  return { hide, mask: plan.status ? [page.getByRole('status')] : [] };
}

/** Attribute + stylesheet that hide volatile values during a screenshot (the style pierces shadow DOM). */
export const VOLATILE_ATTR = 'data-qa-volatile';
export const VOLATILE_STYLE = `[${VOLATILE_ATTR}] { visibility: hidden !important; }`;
/** The same rule as a file: `toHaveScreenshot` takes `stylePath` (only `locator.screenshot` takes `style`). */
export const VOLATILE_STYLE_PATH = join(import.meta.dirname, 'visual-volatile.css');

/** Mark the elements of `locators` as volatile; returns how many were marked. */
export async function markVolatile(locators: readonly Locator[]): Promise<number> {
  let n = 0;
  for (const l of locators) {
    n += await l.evaluateAll((els, attr) => {
      for (const e of els) e.setAttribute(attr, '');
      return els.length;
    }, VOLATILE_ATTR);
  }
  return n;
}

/** Make the page still before a screenshot: spinners gone, fonts loaded, no hover or focus ring. */
export async function settle(page: Page): Promise<void> {
  await waitForSpinners(page);
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
  o: RegionShotOptions & { clip?: Clip },
): Promise<void> {
  await settle(page);
  if (o.clip) await expect.soft(page).toHaveScreenshot(`${name}.png`, { ...shotOptions(o), clip: o.clip });
  else await expect.soft(region).toHaveScreenshot(`${name}.png`, shotOptions(o));
}

/** The same masked image, as bytes (attached to the run so a matching region can still be re-approved). */
export async function regionShot(page: Page, region: Locator, o: RegionShotOptions & { clip?: Clip }): Promise<Buffer> {
  const x = shotOptions(o);
  const opts = {
    mask: x.mask,
    maskColor: x.maskColor,
    animations: x.animations,
    caret: x.caret,
    scale: x.scale,
    style: VOLATILE_STYLE,
  };
  return o.clip ? page.screenshot({ ...opts, clip: o.clip }) : region.screenshot(opts);
}
