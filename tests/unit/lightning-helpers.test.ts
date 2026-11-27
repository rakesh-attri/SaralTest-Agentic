/// <reference lib="dom" />
// Lightning + a11y helpers against the offline fixture pages (real Chromium, FIXTURE).
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expect as pwExpect } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from '../../src/fixture/server.js';
import { parseSoql } from '../../src/fixture/soql.js';
import { REPO_ROOT } from '../helpers/tempProject.js';
import {
  expectFieldError,
  expectSavePopover,
  expectToast,
  openRecord,
  pageError,
  recordIdFromView,
  relatedList,
  relatedListRecord,
  selectPicklist,
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
    // As on live Lightning (qa-prod run-p5-live-1): Save from the related list stays on the Account page.
    await expectToast(page, /was created/);
    expect(await recordIdFromView(page, 'Account')).toBe(ACCOUNT);
    const list = relatedList(page.getByRole('main'), 'Contacts');
    await relatedListRecord(list, name).waitFor();
    expect(await relatedListRecord(list, name).count()).toBe(1);
  });

  it('validation rules (FIXTURE copies of qa-prod rules): picklist select, field error with the rule message, no record', async () => {
    const dialog = await openDialog();
    const name = `QA-web-${Date.now().toString(36)}`;
    await dialog.getByRole('textbox', { name: 'Last Name', exact: true }).fill(name);
    const leadSource = dialog.getByRole('combobox', { name: 'Lead Source', exact: true });
    await selectPicklist(page, leadSource, 'Web');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await waitForSpinners(page);
    const phone = dialog.getByRole('textbox', { name: 'Phone', exact: true });
    await expectFieldError(phone, 'Phone is required when Lead Source is Web.');
    // an invalid phone and an unapproved title fail together (every failing rule is reported)
    await phone.fill('12345');
    await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill('Intern');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await waitForSpinners(page);
    await expectFieldError(phone, 'Phone must be exactly 10 digits.');
    await expectFieldError(
      dialog.getByRole('textbox', { name: 'Title', exact: true }),
      'Title must be an approved title.',
    );
    expect(server.store.query(parseSoql(`SELECT Id FROM Contact WHERE LastName = '${name}'`)).totalSize).toBe(0);
    // Billing → Mailing defaults (BR-05 as implemented by the fixture)
    expect(await dialog.getByRole('textbox', { name: 'Mailing City', exact: true }).inputValue()).toBe('Bengaluru');
  });

  it('expectSavePopover: Lightning rendering the popover twice is one warning; every copy is closed, topmost first (qa-prod run-p5-live-6/7)', async () => {
    await page.setContent(
      [1, 2]
        .map(
          (n) =>
            `<div role="dialog" aria-label="Similar Records Exist" id="p${String(n)}" style="position:fixed;top:0;left:0;width:320px;height:120px;background:#fff"><button aria-label="Close error dialog" onclick="document.getElementById('p${String(n)}').remove()">x</button><h2>Similar Records Exist</h2><p>This record looks like an existing record.</p></div>`,
        )
        .join(''),
    );
    await expectSavePopover(page, 'Similar Records Exist', 'This record looks like an existing record.');
    await pwExpect(page.getByRole('dialog', { name: 'Similar Records Exist' })).toHaveCount(0);
    // the text is still checked: a popover with other text is not this warning
    await page.setContent(
      '<div role="dialog" aria-label="Similar Records Exist"><h2>Similar Records Exist</h2><p>Other text</p></div>',
    );
    await expect(
      Promise.race([
        expectSavePopover(page, 'Similar Records Exist', 'This record looks like an existing record.'),
        new Promise((_, rej) => {
          setTimeout(() => {
            rej(new Error('not shown'));
          }, 3_000);
        }),
      ]),
    ).rejects.toThrow();
  });

  it('selectPicklist falls back to the keyboard when the option is covered (docked footer on live Lightning)', async () => {
    const dialog = await openDialog();
    const leadSource = dialog.getByRole('combobox', { name: 'Lead Source', exact: true });
    // Options cannot receive the click, as when Lightning's docked form footer covers them.
    await dialog.evaluate((el) => {
      const style = document.createElement('style');
      style.textContent = '[role="option"] { pointer-events: none; }';
      el.appendChild(style);
    });
    await selectPicklist(page, leadSource, 'Word of mouth');
    await pwExpect(leadSource).toContainText('Word of mouth');
  });

  it('Contact Edit dialog: pre-filled from the record, Save PATCHes it and the record page shows the change', async () => {
    const dialog = await openDialog();
    const name = `QA-edit-${Date.now().toString(36)}`;
    await dialog.getByRole('textbox', { name: 'Last Name', exact: true }).fill(name);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expectToast(page, /was created/);
    const row = server.store.query(parseSoql(`SELECT Id FROM Contact WHERE LastName = '${name}'`)).records[0];
    const id = typeof row?.['Id'] === 'string' ? row['Id'] : '';
    await openRecord(page, 'Contact', id);
    await page.getByRole('main').getByRole('button', { name: 'Edit', exact: true }).click();
    const edit = page.getByRole('dialog', { name: /^Edit / });
    await pwExpect(edit.getByRole('textbox', { name: 'Last Name', exact: true })).toHaveValue(name);
    await pwExpect(edit.getByRole('textbox', { name: 'Mailing City', exact: true })).toHaveValue('Bengaluru');
    await edit.getByRole('textbox', { name: 'Mailing Street', exact: true }).fill('7 Changed Road');
    await edit.getByRole('button', { name: 'Save', exact: true }).click();
    await pwExpect(page.getByRole('main')).toContainText('7 Changed Road');
    expect(server.store.get('Contact', id)['MailingStreet']).toBe('7 Changed Road');
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
