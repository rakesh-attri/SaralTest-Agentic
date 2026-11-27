// Phase 6 visual suite (PLAN.md §7g, visual-testing skill): baselines of three regions per persona × viewport —
// the New Contact dialog (opened from the Account's Contacts related list), the Contact record Details panel and the
// Account record page — with masks for names, dates, IDs, PII, spinners and counters, plus local layout checks.
// A difference is a candidate for the visual-diff report; it is never judged a defect here.
import { test } from '../fixtures/index.js';
import { AccountRecordPage } from '../pages/AccountRecordPage.js';
import { ContactRecordPage } from '../pages/ContactRecordPage.js';
import { NewContactDialog } from '../pages/NewContactDialog.js';
import { selectTab, showRelatedList, waitForSpinners } from '../support/lightning.js';
import { observeLayoutShift } from '../support/layout.js';
import { expect } from '@playwright/test';
import { captureRegion, runPrefix } from './support.js';

test.describe('Visual baselines: Account → Contact pages', () => {
  test(
    'VIS-001 Account record page, Contact Details panel and New Contact dialog',
    { tag: ['@visual', '@ui'] },
    async ({ page, data }, testInfo) => {
      await observeLayoutShift(page);
      await data.create('account-contact', ['Account', 'Contact']);
      const account = new AccountRecordPage(page);
      const contact = new ContactRecordPage(page);
      const dialog = new NewContactDialog(page);

      await test.step('Account record page (Details tab)', async () => {
        await account.open(data.id('Account'));
        await selectTab(account.detailsTab);
        await waitForSpinners(page);
        await captureRegion(page, testInfo, 'account-record', account.root, runPrefix());
      });

      await test.step('New Contact dialog from the Contacts related list', async () => {
        await showRelatedList(account.contactsRelatedList, account.relatedTab);
        await account.contactsNewButton.click();
        await expect(dialog.root).toBeVisible();
        await waitForSpinners(dialog.root);
        await captureRegion(page, testInfo, 'new-contact-dialog', dialog.root, runPrefix());
        await dialog.cancelButton.click(); // nothing is saved
        await expect(dialog.root).toBeHidden();
      });

      await test.step('Contact record Details panel', async () => {
        await contact.open(data.id('Contact'));
        await selectTab(contact.detailsTab);
        await waitForSpinners(page);
        await captureRegion(page, testInfo, 'contact-details', contact.detailsPanel, runPrefix());
      });
    },
  );
});
