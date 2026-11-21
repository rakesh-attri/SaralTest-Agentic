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

/** A related-list card (`article` named like the list, e.g. "Contacts"). */
export function relatedList(scope: Scope, name: string): Locator {
  return scope.getByRole('article', { name, exact: true });
}

/** The link to a record inside a related list, by the record's (run-unique) display name. */
export function relatedListRecord(list: Locator, name: string): Locator {
  return list.getByRole('link', { name: new RegExp(`(^|\\s)${escapeRegExp(name)}$`) });
}

/** Field-level save error: the input is marked invalid (Lightning sets aria-invalid on the inner input). */
export async function expectFieldError(field: Locator): Promise<void> {
  await expect(field).toHaveAttribute('aria-invalid', 'true');
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
