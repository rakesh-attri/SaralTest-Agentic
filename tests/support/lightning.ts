// Shared Lightning helpers (salesforce-lightning-locators skill, "Component patterns"). Generated tests and page
// objects use these; they never re-implement waits, toasts, tabs or related lists per test.
import { expect, type Locator, type Page } from '@playwright/test';

type Scope = Page | Locator;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Wait until no visible spinner (role=status named "Loading…") remains inside the scope. */
export async function waitForSpinners(scope: Scope, timeout = 30_000): Promise<void> {
  await expect(scope.getByRole('status', { name: /^Loading/ })).toHaveCount(0, { timeout });
}

/**
 * A toast whose text matches. Lightning renders toasts as role=alert or role=status depending on the variant and
 * release (verified per org by the Explorer), so both roles are accepted.
 */
export async function expectToast(page: Page, text: string | RegExp, timeout = 20_000): Promise<void> {
  const toasts = page.getByRole('alert').or(page.getByRole('status')).filter({ hasText: text });
  await expect(toasts).not.toHaveCount(0, { timeout });
}

/** Navigate to a record by id (from the data ledger, never from a hard-coded value) and wait for it to render. */
export async function openRecord(page: Page, object: string, recordId: string): Promise<Locator> {
  await page.goto(`/lightning/r/${object}/${recordId}/view`, { waitUntil: 'domcontentloaded' });
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 60_000 });
  await waitForSpinners(page);
  return main;
}

/** Select a record-page tab (Details / Related / …) when it is not already selected. */
export async function selectTab(tab: Locator): Promise<void> {
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/** The record page header (h1) shows the text (e.g. the new Contact's name). */
export async function expectRecordTitle(page: Page, text: string): Promise<void> {
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toContainText(text);
}

/**
 * Bring a related list into view: Lightning shows related lists on the default tab or on a "Related" tab,
 * depending on the page layout. Navigation only — the list itself is asserted by the caller.
 */
export async function showRelatedList(list: Locator, relatedTab?: Locator): Promise<void> {
  await waitForSpinners(list.page());
  if (!(await list.isVisible()) && relatedTab) await selectTab(relatedTab);
  await expect(list).toBeVisible();
}

/** A related-list card (`article` named like the list, e.g. "Contacts"). */
export function relatedList(scope: Scope, name: string): Locator {
  return scope.getByRole('article', { name, exact: true });
}

/** The link to a record inside a related list, by the record's (run-unique) display name. */
export function relatedListRecord(list: Locator, name: string): Locator {
  return list.getByRole('link', { name: new RegExp(`(^|\\s)${escapeRegExp(name)}$`) });
}

/**
 * Lightning shows a failed save as a popover ("We hit a snag." / "Similar Records Exist") that is its own modal
 * dialog: while it is open the record form is hidden from the accessibility tree, so field checks and further typing
 * cannot reach it (qa-prod, Phase 5). Close it — it is a notice, closing it saves nothing and changes no field.
 */
export async function closeSavePopover(page: Page, timeout = 10_000): Promise<void> {
  const popover = page.getByRole('dialog', { name: /^(We hit a snag|Similar Records Exist)/ });
  // The popover can render a moment after the field turns invalid (qa-prod run-p5-live-2): retry close + check.
  await expect(async () => {
    for (const b of await popover.getByRole('button', { name: 'Close error dialog' }).all()) {
      if (await b.isVisible().catch(() => false)) await b.click();
    }
    await expect(popover).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout });
}

/**
 * Field-level save error: the input is marked invalid (Lightning sets aria-invalid on the inner input). With a
 * message (generated tests take it from the org's validation rule), the field's error text — linked to the input
 * through aria-describedby — must contain it.
 */
export async function expectFieldError(field: Locator, message?: string): Promise<void> {
  const page = field.page();
  // Whichever the failed save shows first: Lightning's error popover (form hidden), or the field marked invalid.
  const popoverClose = page
    .getByRole('dialog', { name: /^(We hit a snag|Similar Records Exist)/ })
    .getByRole('button', { name: 'Close error dialog' });
  await expect(popoverClose.or(field.and(page.locator('[aria-invalid="true"]'))))
    .not.toHaveCount(0, { timeout: 15_000 })
    .catch(() => undefined);
  // The field can turn invalid a moment before Lightning's popover renders: give it a short window, then close it.
  await expect(popoverClose)
    .not.toHaveCount(0, { timeout: 3_000 })
    .catch(() => undefined);
  await closeSavePopover(page);
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  if (message !== undefined) await expect(field).toHaveAccessibleDescription(new RegExp(escapeRegExp(message)));
}

/** The page-level error summary of a form ("We hit a snag." etc.). */
export function pageError(scope: Locator): Locator {
  return scope.getByRole('alert');
}

/** Picklist (lightning-combobox): open, then pick the exact option. */
export async function selectPicklist(page: Page, combobox: Locator, value: string): Promise<void> {
  await combobox.click();
  await page.getByRole('option', { name: value, exact: true }).click();
  await expect(combobox).toContainText(value);
}

/** Lookup: type a run-unique name and pick the matching option. */
export async function fillLookup(page: Page, combobox: Locator, uniqueName: string): Promise<void> {
  await combobox.fill(uniqueName);
  const option = page.getByRole('option', { name: new RegExp(escapeRegExp(uniqueName)) });
  await expect(option).toHaveCount(1);
  await option.click();
}

/** After Save: the record view URL of `object`; returns the new record id. */
export async function recordIdFromView(page: Page, object: string, timeout = 60_000): Promise<string> {
  const re = new RegExp(`/lightning/r/${object}/([a-zA-Z0-9]{15,18})/view`);
  await expect(page).toHaveURL(re, { timeout });
  const id = re.exec(page.url())?.[1];
  if (!id) throw new Error(`no ${object} record id in ${page.url()}`);
  return id;
}
