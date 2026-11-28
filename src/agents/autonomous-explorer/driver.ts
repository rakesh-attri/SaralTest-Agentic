// Playwright driver of the Contact-creation charter (library, like the Application Explorer; MCP is optional for ad-hoc
// exploration). Role-based locators only (salesforce-lightning-locators skill). Observes: invalid fields, visible
// messages (field-level via aria-describedby, page error / save popovers, toasts), required markers, URL. Console errors
// are collected for findings. Screenshots stay local in the run folder (never sent to a model).
import { mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { describedText, popoverTexts, closePopovers, POPOVER } from '../app-explorer/messages.js';
import type { ExplorerDriver, SaveOutcome } from './index.js';
import type { Observation } from './stateMap.js';

export interface DriverInput {
  browser: Browser;
  storageStatePath: string;
  baseUrl: string;
  accountId: string;
  evidenceDir: string;
  root: string;
  redact: (s: string) => string;
}

const LABELS = ['Last Name', 'Email', 'Phone', 'Title'];

export async function playwrightDriver(i: DriverInput): Promise<ExplorerDriver> {
  const context: BrowserContext = await i.browser.newContext({
    storageState: i.storageStatePath,
    viewport: { width: 1440, height: 900 },
  });
  const page: Page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(i.redact(m.text()).slice(0, 300));
  });
  mkdirSync(i.evidenceDir, { recursive: true });
  // The form dialog = the New Contact dialog with a Save button; Lightning's "We hit a snag" popover is a dialog too
  // (explore-p7-live-1: two matches made isVisible() fail and the dialog looked closed).
  const dialog = (): Locator =>
    page
      .getByRole('dialog', { name: /New Contact/ })
      .filter({ has: page.getByRole('button', { name: 'Save', exact: true }) });
  const field = (label: string): Locator => dialog().getByRole('textbox', { name: label, exact: true });
  const spinnersGone = async (): Promise<void> => {
    await page
      .getByRole('status', { name: /^Loading/ })
      .first()
      .waitFor({ state: 'hidden', timeout: 30_000 })
      .catch(() => undefined);
  };

  return {
    async open() {
      await page.goto(`${i.baseUrl}/lightning/r/Account/${i.accountId}/view`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      const main = page.getByRole('main');
      await main.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 60_000 });
      const contacts = main.getByRole('article', { name: 'Contacts', exact: true });
      if ((await contacts.count()) === 0 || !(await contacts.isVisible()))
        await main.getByRole('tab', { name: 'Related', exact: true }).click();
      await contacts.getByRole('button', { name: 'New', exact: true }).click();
      await dialog().waitFor({ state: 'visible', timeout: 60_000 });
      await field('Last Name').waitFor({ state: 'visible', timeout: 60_000 });
    },
    async fill(label, value) {
      const f = field(label);
      await f.fill(value);
      return f.inputValue();
    },
    async clear(label) {
      await field(label).fill('');
    },
    async select(label, value) {
      const combo = dialog().getByRole('combobox', { name: label, exact: true });
      await combo.click();
      await page.getByRole('option', { name: value, exact: true }).click({ timeout: 10_000 });
    },
    async tab() {
      await page.keyboard.press('Tab');
    },
    async cancel() {
      const d = dialog();
      if (!(await d.isVisible().catch(() => false))) return;
      await closePopovers(page);
      const btn = d.getByRole('button', { name: 'Cancel', exact: true });
      if ((await btn.count()) === 1) await btn.click();
      else await page.keyboard.press('Escape');
      await d.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined);
    },
    async escape() {
      await page.keyboard.press('Escape');
      await dialog()
        .waitFor({ state: 'hidden', timeout: 5_000 })
        .catch(() => undefined);
    },
    async save(): Promise<SaveOutcome> {
      const d = dialog();
      await d.getByRole('button', { name: 'Save', exact: true }).click();
      await spinnersGone();
      await d
        .getByRole('alert')
        .or(page.getByRole('dialog', { name: POPOVER }))
        .or(d.locator('[aria-invalid="true"]'))
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 })
        .catch(() => undefined);
      const closed = await d.waitFor({ state: 'hidden', timeout: 2_000 }).then(
        () => true,
        () => false,
      );
      const messages: string[] = [];
      if (!closed) {
        for (const l of LABELS) {
          const f = field(l);
          if ((await f.count()) === 1 && (await f.getAttribute('aria-invalid')) === 'true') {
            const t = await describedText(f);
            if (t) messages.push(`${l}: ${t}`);
          }
        }
        for (const t of await popoverTexts(page, d, /^\s*(We hit a snag|Similar Records Exist)/)) messages.push(t);
      }
      return { closed, messages: messages.map((m) => i.redact(m).slice(0, 300)) };
    },
    async observe(): Promise<Observation> {
      const d = dialog();
      const open = await d.isVisible().catch(() => false);
      const invalid: string[] = [];
      const required: string[] = [];
      const messages: string[] = [];
      if (open) {
        for (const l of LABELS) {
          const f = field(l);
          if ((await f.count()) !== 1) continue;
          if ((await f.getAttribute('aria-invalid')) === 'true') {
            invalid.push(l);
            const t = await describedText(f);
            if (t) messages.push(t);
          }
          if ((await f.getAttribute('aria-required')) === 'true' || (await f.getAttribute('required')) !== null)
            required.push(l);
        }
      }
      const toast = page.getByRole('status').filter({ hasText: /was (created|saved)/ });
      if ((await toast.count()) > 0) messages.push('toast: record saved');
      return {
        page: new URL(page.url()).pathname.replace(/\/[A-Za-z0-9]{15,18}\//, '/<id>/'),
        ...(open ? { dialog: 'New Contact' } : {}),
        invalidFields: invalid,
        messages: messages.map((m) => i.redact(m)),
        requiredMarked: required,
        url: page.url(),
      };
    },
    takeConsoleErrors() {
      return consoleErrors.splice(0);
    },
    async screenshot(name) {
      const file = join(i.evidenceDir, `${name}.png`);
      await page.screenshot({ path: file }).catch(() => undefined);
      return relative(i.root, file).split('\\').join('/');
    },
    async close() {
      await context.close().catch(() => undefined);
    },
  };
}
