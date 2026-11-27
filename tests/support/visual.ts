/// <reference lib="dom" />
// Visual helpers for @visual tests (visual-testing skill, PLAN.md §7g):
// - screenshots are taken of one region (dialog, tab panel, record page main), never the whole browser window;
// - values that change per run or per user are masked: record/user names, dates, record IDs, PII, spinners,
//   counters. Labels are NOT masked, so a moved or renamed field still shows as a difference;
// - capture is stabilised (spinners settled, fonts loaded, animations off, caret hidden, no hover/focus ring).
import { expect, type Locator, type Page } from '@playwright/test';
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

/** Locators to mask inside `region` (and page-level spinners / the record title, which may sit outside it). */
export function maskLocators(page: Page, region: Locator, plan: MaskPlan): Locator[] {
  const out: Locator[] = plan.text.map((re) => region.getByText(re));
  if (plan.links) out.push(region.getByRole('link'));
  if (plan.title) out.push(page.getByRole('main').getByRole('heading', { level: 1 }));
  if (plan.status) out.push(page.getByRole('status'));
  return out;
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
  maxDiffPixelRatio: number;
} {
  return {
    mask: o.mask,
    maskColor: '#FF00FF',
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
    maxDiffPixelRatio: o.maxDiffPixelRatio,
  };
}

/**
 * Soft screenshot assertion of one region against `<name>.png` (a mismatch is recorded, the test continues so layout
 * and a11y checks still run). The runner turns failures into candidates; nothing here judges them as defects.
 */
export async function expectRegionScreenshot(
  page: Page,
  region: Locator,
  name: string,
  o: RegionShotOptions,
): Promise<void> {
  await settle(page);
  await expect.soft(region).toHaveScreenshot(`${name}.png`, shotOptions(o));
}
