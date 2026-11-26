/// <reference lib="dom" />
// Lightning + a11y helpers against the offline fixture pages (real Chromium, FIXTURE).
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../src/fixture/server.js';
import { REPO_ROOT } from '../helpers/tempProject.js';
import {
  expectFieldError,
  expectToast,
  openRecord,
  pageError,
  recordIdFromView,
  relatedList,
  relatedListRecord,
  selectTab,
  waitForSpinners,
} from '../support/lightning.js';
import { checkTabOrder, classifyViolations, namespacesOf, scanScoped } from '../support/a11y.js';

const ACCOUNT = '001FX0000000001AAA';
const NS = {
  customNamespaces: ['c'],
  standardNamespaces: ['lightning', 'force', 'records', 'one', 'forcegenerated', 'runtime_', 'flexipage', 'slds'],
};

describe('a11y classification (pure)', () => {
  it('splits violations into our custom components (failing) and Salesforce-owned markup (baseline)', () => {
    const r = classifyViolations(
      {
        violations: [
          {
            id: 'label',
            impact: 'critical',
            help: 'Form elements must have labels',
            helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/label',
            nodes: [
              { target: ['c-contact-banner > input'], html: '<input type="text">' },
              { target: [['records-record-layout-item', 'lightning-input', 'input']], html: '<input>' },
            ],
          },
          {
            id: 'color-contrast',
            impact: 'serious',
            help: 'contrast',
            helpUrl: 'u',
            nodes: [{ target: ['.slds-button'], html: '<button class="slds-button">' }],
          },
        ],
        passes: [{}, {}],
      },
      NS,
    );
    expect(r.failing).toEqual([expect.objectContaining({ ruleId: 'label', targets: ['c-contact-banner > input'] })]);
    expect(r.baseline.map((v) => v.ruleId)).toEqual(['label', 'color-contrast']);
    expect(r.baseline[0]?.targets).toEqual(['records-record-layout-item >>> lightning-input >>> input']);
    expect(r.passes).toBe(2);
  });

  it('reads namespaces from the selector path and the node tag', () => {
    expect(namespacesOf('div > lightning-input input')).toEqual(['lightning']);
    expect(namespacesOf('section', '<c-banner class="x">')).toEqual(['c']);
    expect(namespacesOf('#x')).toEqual([]);
  });
});

describe('Lightning + a11y helpers on the offline fixture (real Chromium, FIXTURE)', () => {
  let server: FixtureServer;
  let browser: Browser;
  let context: BrowserContext | undefined;
  let page: Page;

  beforeAll(async () => {
    server = await startFixtureServer({ fixtureDir: join(REPO_ROOT, 'examples', 'fixture'), port: 0 });
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser.close();
    await server.close();
  });
  beforeEach(async () => {
    await context?.close();
    const ctx = await browser.newContext({ baseURL: server.url });
    context = ctx;
    page = await ctx.newPage();
    await page.goto(`/secur/frontdoor.jsp?sid=fixture-admin-token&retURL=/lightning/page/home`);
  });

  const openDialog = async (): Promise<ReturnType<Page['getByRole']>> => {
    const main = await openRecord(page, 'Account', ACCOUNT);
    await selectTab(main.getByRole('tab', { name: 'Related', exact: true }));
    await relatedList(main, 'Contacts').getByRole('button', { name: 'New', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New Contact' });
    await dialog.waitFor();
    return dialog;
  };

  it('opens a record by id, switches tabs, shows field + page errors, toasts and the new related-list row', async () => {
    const dialog = await openDialog();
    // BR-05 as implemented by the fixture: Mailing Country defaults from the Account's Billing Country.
    expect(await dialog.getByRole('textbox', { name: 'Mailing Country', exact: true }).inputValue()).toBe('India');
    const lastName = dialog.getByRole('textbox', { name: 'Last Name', exact: true });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await waitForSpinners(page);
    await expectFieldError(lastName);
    await expectFieldError(lastName, 'Complete this field.'); // the fixture's own error text (FIXTURE)
    await expect(expectFieldError(lastName, 'Some other message')).rejects.toThrow();
    expect(await pageError(dialog).textContent()).toContain('We hit a snag');

    const name = `QA-helpers-${Date.now().toString(36)}`;
    await lastName.fill(name);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await waitForSpinners(page);
    await expectToast(page, /was created/);
    const list = relatedList(page.getByRole('main'), 'Contacts');
    await relatedListRecord(list, name).waitFor();
    expect(await relatedListRecord(list, name).count()).toBe(1);
  });

  it('recordIdFromView extracts the id from a record URL', async () => {
    await openRecord(page, 'Account', ACCOUNT);
    expect(await recordIdFromView(page, 'Account')).toBe(ACCOUNT);
  });

  it('scanScoped: a seeded custom-component violation fails, a Salesforce-owned one is baseline only', async () => {
    const dialog = await openDialog();
    await dialog.evaluate((el) => {
      const form = el.querySelector('form');
      const custom = document.createElement('c-qa-banner');
      custom.innerHTML = '<input type="text" name="unlabelledCustom">';
      const std = document.createElement('lightning-input');
      std.innerHTML = '<input type="text" name="unlabelledStandard">';
      form?.append(custom, std);
    });
    const r = await scanScoped(page, dialog, NS);
    expect(r.failing.map((v) => v.ruleId)).toContain('label');
    expect(r.failing.flatMap((v) => v.targets).join(' ')).toMatch(/unlabelledCustom/);
    expect(r.failing.flatMap((v) => v.targets).join(' ')).not.toMatch(/unlabelledStandard/);
    expect(r.baseline.flatMap((v) => v.targets).join(' ')).toMatch(/unlabelledStandard/);
    // The scope marker is removed again.
    expect(await page.locator('[data-qa-a11y-scope]').count()).toBe(0);
  });

  it('checkTabOrder: all reachable in visual order; an unreachable field or a visual reorder fails', async () => {
    const dialog = await openDialog();
    const els = {
      firstName: dialog.getByRole('textbox', { name: 'First Name', exact: true }),
      lastName: dialog.getByRole('textbox', { name: 'Last Name', exact: true }),
      email: dialog.getByRole('textbox', { name: 'Email', exact: true }),
      mailingCountry: dialog.getByRole('textbox', { name: 'Mailing Country', exact: true }),
      cancel: dialog.getByRole('button', { name: 'Cancel', exact: true }),
      save: dialog.getByRole('button', { name: 'Save', exact: true }),
    };
    const ok = await checkTabOrder(page, dialog, els);
    expect(ok.missing).toEqual([]);
    expect(ok.leftScope).toBe(false);
    expect(ok.inOrder).toBe(true);
    expect(ok.expectedOrder[0]).toBe('firstName');

    await els.cancel.evaluate((b) => {
      b.setAttribute('style', 'position: fixed; top: 0; left: 0');
    });
    const reordered = await checkTabOrder(page, dialog, els);
    expect(reordered.expectedOrder[0]).toBe('cancel');
    expect(reordered.inOrder).toBe(false);

    await els.email.evaluate((i) => {
      i.setAttribute('tabindex', '-1');
    });
    const unreachable = await checkTabOrder(page, dialog, els);
    expect(unreachable.missing).toEqual(['email']);
  });
});
