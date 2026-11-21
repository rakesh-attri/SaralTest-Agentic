import { Linter, RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
import tseslint from 'typescript-eslint';
import plugin, { fragileReason, noFragileLocators } from '../../packages/eslint-plugin-sf-locators/index.js';

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 2023, sourceType: 'module' },
});

describe('sf-locators/no-fragile-locators', () => {
  tester.run('no-fragile-locators', noFragileLocators, {
    valid: [
      "page.getByRole('dialog', { name: 'New Contact' }).getByRole('textbox', { name: 'Last Name', exact: true });",
      "dialog.getByLabel('Email', { exact: true });",
      "page.locator('article').filter({ has: page.getByRole('heading', { name: /^Contacts/ }) });",
      'await page.goto(`/lightning/r/Contact/${id}/view`);',
      "await page.goto('https://example.my.salesforce.com/lightning/page/home');",
      "// unique-test-data: name contains the runId\nawait list.getByRole('option', { name }).first().click();",
      'rows.nth(0); // order: header row is always first',
      'page.locator(\'[data-testid="save"]\');',
    ],
    invalid: [
      { code: 'page.locator(\'//div[@title="Save"]\');', errors: [{ messageId: 'fragile' }] },
      { code: "page.locator('xpath=//button');", errors: [{ messageId: 'fragile' }] },
      { code: "page.locator('#input-123');", errors: [{ messageId: 'fragile' }] },
      { code: 'page.locator(\'[id^="combobox-button-"]\');', errors: [{ messageId: 'fragile' }] },
      { code: 'page.locator(\'[aria-labelledby="label-42"]\');', errors: [{ messageId: 'fragile' }] },
      { code: 'page.locator(\'[data-aura-rendered-by="1:2;a"]\');', errors: [{ messageId: 'fragile' }] },
      { code: "page.locator('li:nth-child(2)');", errors: [{ messageId: 'fragile' }] },
      { code: "page.locator('.slds-form-element .slds-input');", errors: [{ messageId: 'fragile' }] },
      { code: "page.locator('force-record-layout lightning-input');", errors: [{ messageId: 'fragile' }] },
      { code: "await page.goto('/lightning/r/Account/001FX0000000001AAA/view');", errors: [{ messageId: 'fragile' }] },
      { code: 'page.locator(`[aria-labelledby="x-${n}1"]`);', errors: [{ messageId: 'fragile' }] },
      { code: "page.getByRole('row').nth(2);", errors: [{ messageId: 'nth' }] },
      { code: "page.getByRole('option').first();", errors: [{ messageId: 'firstLast' }] },
      { code: "page.getByRole('option').last();", errors: [{ messageId: 'firstLast' }] },
      { code: 'await page.waitForTimeout(1000);', errors: [{ messageId: 'sleep' }] },
    ],
  });

  it('exposes the rule under the plugin name used in eslint.config.js', () => {
    expect(Object.keys(plugin.rules)).toEqual(['no-fragile-locators']);
    const linter = new Linter({ configType: 'flat' });
    const messages = linter.verify("page.locator('.slds-button');", {
      plugins: { 'sf-locators': plugin },
      rules: { 'sf-locators/no-fragile-locators': 'error' },
    });
    expect(messages.map((m) => m.ruleId)).toEqual(['sf-locators/no-fragile-locators']);
  });

  it('fragileReason only checks record ids for navigation URLs', () => {
    expect(fragileReason('https://x.my.salesforce.com//lightning', true)).toBeUndefined();
    expect(fragileReason('/lightning/r/Contact/003FX0000000001AAA/view', true)).toMatch(/record ids/);
    expect(fragileReason("getByRole('button')")).toBeUndefined();
  });
});
