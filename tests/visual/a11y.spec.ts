// Phase 6 accessibility suite (PLAN.md §7g), building on TC-SF-219-053 (which replaced TC-022) and its operator
// rule (2026-11-21): axe scans are scoped to one region; violations in our own custom namespaces and keyboard
// (tab-order / focus) breaks FAIL; Salesforce-owned violations are recorded and compared by the runner with the
// accepted list in baselines.json (new ones become review candidates). Controls without an accessible name (from
// the browser's ARIA snapshot) are recorded as candidates. Runs per persona × visual viewport.
import { test, expect } from '../fixtures/index.js';
import type { Locator, Page, TestInfo } from '@playwright/test';
import type { VisualRegion } from '../../src/core/schemas/visual.js';
import { AccountRecordPage } from '../pages/AccountRecordPage.js';
import { ContactRecordPage } from '../pages/ContactRecordPage.js';
import { NewContactDialog } from '../pages/NewContactDialog.js';
import {
  checkTabOrder,
  scanScoped,
  unnamedControls,
  type A11yNamespaces,
  type TabOrderResult,
} from '../support/a11y.js';
import { selectTab, showRelatedList, waitForSpinners } from '../support/lightning.js';
import { visualProject } from './support.js';

async function scanRegion(
  page: Page,
  testInfo: TestInfo,
  ns: A11yNamespaces,
  region: VisualRegion,
  scope: Locator,
  tabOrder?: TabOrderResult,
): Promise<void> {
  const { viewport } = visualProject(testInfo);
  const scan = await scanScoped(page, scope, ns);
  const unnamed = unnamedControls(await scope.ariaSnapshot());
  await testInfo.attach(`visual-a11y-${region}.json`, {
    body: JSON.stringify(
      {
        region,
        viewport,
        failing: scan.failing.map((v) => ({
          ruleId: v.ruleId,
          impact: v.impact,
          targets: v.targets.length,
          help: v.help,
        })),
        baseline: scan.baseline.map((v) => ({
          ruleId: v.ruleId,
          impact: v.impact,
          targets: v.targets.length,
          help: v.help,
        })),
        unnamed,
        tabOrder: tabOrder
          ? { inOrder: tabOrder.inOrder, missing: tabOrder.missing, leftScope: tabOrder.leftScope }
          : null,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
  expect.soft(scan.failing, `${region}: axe violations in our own custom components`).toEqual([]);
  if (tabOrder) {
    expect.soft(tabOrder.missing, `${region}: every control reachable by Tab`).toEqual([]);
    expect.soft(tabOrder.leftScope, `${region}: focus stays inside the region`).toBe(false);
    expect.soft(tabOrder.inOrder, `${region}: Tab follows the visual reading order`).toBe(true);
  }
}

test.describe('Accessibility: Account → Contact pages', () => {
  test(
    'A11Y-001 Account record page, New Contact dialog and Contact Details panel',
    { tag: ['@a11y'] },
    async ({ page, a11y, data }, testInfo) => {
      await data.create('account-contact', ['Account', 'Contact']);
      const account = new AccountRecordPage(page);
      const contact = new ContactRecordPage(page);
      const dialog = new NewContactDialog(page);

      await test.step('Account record page', async () => {
        await account.open(data.id('Account'));
        await selectTab(account.detailsTab);
        await waitForSpinners(page);
        const keys = await checkTabOrder(page, account.root, {
          detailsTab: account.detailsTab,
          relatedTab: account.relatedTab,
        });
        await scanRegion(page, testInfo, a11y, 'account-record', account.root, keys);
      });

      await test.step('New Contact dialog: scan, keyboard order of the fields both pages share', async () => {
        await showRelatedList(account.contactsRelatedList, account.relatedTab);
        await account.contactsNewButton.click();
        await expect(dialog.root).toBeVisible();
        await waitForSpinners(dialog.root);
        const keys = await checkTabOrder(page, dialog.root, {
          firstName: dialog.firstName,
          lastName: dialog.lastName,
          title: dialog.title,
          email: dialog.email,
          phone: dialog.phone,
          leadSource: dialog.leadSource,
          mailingStreet: dialog.mailingStreet,
          mailingCity: dialog.mailingCity,
          mailingPostalCode: dialog.mailingPostalCode,
          mailingCountry: dialog.mailingCountry,
          accountId: dialog.accountId,
          cancelButton: dialog.cancelButton,
          saveButton: dialog.saveButton,
        });
        await scanRegion(page, testInfo, a11y, 'new-contact-dialog', dialog.root, keys);
        await dialog.cancelButton.click(); // nothing is saved
        await expect(dialog.root).toBeHidden();
      });

      await test.step('Contact record Details panel', async () => {
        await contact.open(data.id('Contact'));
        await selectTab(contact.detailsTab);
        await waitForSpinners(page);
        const keys = await checkTabOrder(page, contact.root, {
          detailsTab: contact.detailsTab,
          relatedTab: contact.relatedTab,
        });
        await scanRegion(page, testInfo, a11y, 'contact-details', contact.detailsPanel, keys);
      });
    },
  );
});
