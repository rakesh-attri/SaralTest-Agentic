---
name: salesforce-lightning-locators
description: Rules and patterns for stable, role-based Playwright locators in Salesforce Lightning Experience (record pages, comboboxes, lookups, datatables, modals, toasts, spinners, related lists). Use whenever writing, reviewing, discovering or healing a locator for a Salesforce UI test.
---

# Salesforce Lightning locators

Goal: locators that survive Salesforce seasonal releases, layout changes and data changes.
Playwright pierces open shadow DOM automatically, so role-based locators work on Lightning base components
and most LWCs. **Never** reach into shadow roots with CSS chains.

## Locator priority (use the first that works and is unique)

1. `getByRole(role, { name, exact: true })` — **scoped** to a region (dialog, form section, card, tab panel).
2. `getByLabel('Field Label', { exact: true })` — for inputs, textareas, checkboxes, date fields.
3. `getByText('Static text', { exact: true })` — scoped; only for static, non-translated-at-runtime text.
4. `getByTestId('...')` — only if the custom LWC has `data-testid` (config: `testIdAttribute`).
5. Stable semantic attribute CSS — last resort, must be recorded in the locator registry with a reason
   (e.g. a field container attribute that carries the field API name, proven by the Explorer in this org).

## Banned (lint rule `sf-locators/no-fragile-locators` fails the build)

- XPath of any kind (`xpath=`, `//`).
- Generated IDs: `#input-123`, `[id^="combobox-button-"]`, `[aria-labelledby="..."]` with numeric ids,
  `[data-aura-rendered-by]`, `[data-aura-class]` chains.
- Positional chains: `nth-child`, `:nth-of-type`, `.nth(n)` without a comment proving order is semantic,
  `.first()` / `.last()` used to hide non-unique matches.
- `.slds-*` structural chains (`.slds-form-element .slds-input`), `force-*` / `lightning-*` tag chains deeper than 1.
- `page.waitForTimeout()` and fixed sleeps. Use web-first assertions and the helpers below.
- Record IDs or record names that come from data in a locator for navigation — open a record the data factory
  created by its ledger id (`openRecord`), and a record the test created in the UI **from the related list** by its
  run-unique name.
- **Assertions on URLs or record IDs** (`toHaveURL`, `page.url()`, `recordIdFromView`, id comparisons, hard-coded ids):
  they are dynamic (operator rule 2026-11-26). Test Reviewer pass 2 rejects them (`dynamic-assertion`).

## Scoping (do this always)

```ts
const modal = page.getByRole('dialog', { name: /New Opportunity/ });
const details = page.getByRole('tabpanel', { name: 'Details' });
const contacts = page.locator('article').filter({ has: page.getByRole('heading', { name: /^Contacts/ }) });
await modal.getByRole('button', { name: 'Save', exact: true }).click();
```

## Component patterns (put these in `tests/support/lightning.ts`, never re-invent per test)

| Component | Pattern |
|---|---|
| Text / number / date input | `scope.getByLabel('Amount', { exact: true }).fill('5000')` |
| Picklist (lightning-combobox) | `scope.getByRole('combobox', { name: 'Stage' }).click(); page.getByRole('option', { name: 'Closed Won', exact: true }).click()` |
| Lookup | `scope.getByRole('combobox', { name: 'Account Name' }).fill('Acme'); page.getByRole('option', { name: /Acme/ }).first()` — `.first()` allowed **only** with a unique test-data name |
| Checkbox | `scope.getByRole('checkbox', { name: 'Active' }).check()` |
| Buttons | `getByRole('button', { name: 'Save', exact: true })` — note `Save` vs `Save & New` |
| Tabs (record page) | `page.getByRole('tab', { name: 'Related' }).click()` |
| App / nav item | App Launcher → `getByRole('button', { name: 'App Launcher' })`, then search box `getByPlaceholder('Search apps and items...')` / prefer direct URL `/lightning/o/<Object>/list` |
| Record header fields | Read via API in assertions when possible; UI check: `page.getByRole('heading', { name: recordName })` |
| Detail field value (read mode) | Scope to Details tabpanel; find label text then the sibling value through the registry's verified pattern for this org |
| Datatable / list view | `page.getByRole('grid')`, rows `getByRole('row', { name: /Acme/ })`, cells `getByRole('gridcell')` |
| Row action menu | `row.getByRole('button', { name: /Show Actions|Show more actions/ }).click(); page.getByRole('menuitem', { name: 'Edit' })` |
| Modal | `page.getByRole('dialog', { name })` — always scope fields to it |
| Toast | `expectToast(page, /was created|was saved/)` — helper uses the toast container's role (verify `alert`/`status` per org via Explorer) and auto-dismiss handling |
| Spinner | `waitForSpinners(page)` — waits until no visible `lightning-spinner` / `[role="status"]` spinner inside the scope |
| Inline edit | `getByRole('button', { name: /^Edit Amount/ })` then field by label inside the edit panel |
| Errors on save | field: `expectFieldError(field, text)`; page: Lightning's "We hit a snag." / "Similar Records Exist" popover is its **own modal dialog** that hides the form from the accessibility tree — `closeSavePopover(page)` / `expectSavePopover(page, heading, text)` |
| Picklist near the bottom of a modal | the docked form footer can cover its options — `selectPicklist` falls back to the keyboard (same value) |

Labels may differ per profile/record type and are translatable: keep label strings in page objects, never in tests,
and use the label the Application Explorer captured for that persona.

## Waiting strategy

- Use `await expect(locator).toBeVisible()` / `toHaveValue` / `toHaveText` (auto-retrying).
- After a create Save (a related-list Save **stays on the parent record** in Lightning) — never wait for a URL:
  1. the success toast contains the name we entered (`expectToast(page, name)`);
  2. the record appears in the related list with that exact name (`relatedListRecord(list, name)` visible);
  3. open it from the related list and assert the record header shows the same name (`expectRecordTitle`);
  4. verify with SOQL **by the run tag** that the stored values match what we entered
     (`data.tagged(object, { LastName: name }, [...fields])` → exactly 1 record, `toMatchObject` the typed values;
     a parent is compared by name, e.g. `Account.Name`, never by id).
- After navigation: `await waitForSpinners(page)`.
- Async automation (flows, queueables): **do not** poll the UI — poll via API (see salesforce-api-testing).

## Discovery workflow (Application Explorer)

1. Open the page as the persona (storageState). Take an ARIA snapshot (`browser_snapshot`).
2. For each needed element, propose candidates in priority order.
3. Verify: `count() === 1`, visible, enabled, and the accessible name matches the label from metadata.
4. Save to the registry with `strategyRank`, `persona`, `recordType`, `lastVerifiedAt`.

## Healing rules (Self-Healer)

- Allowed: replace a locator with a higher- or equal-priority verified one; add scoping; add a helper wait.
- Forbidden: change assertions, expected values, test data meaning, or remove steps. Never downgrade to banned patterns.
- Prove the fix: re-run the test; record the old → new locator as a learning candidate.

## Enforcement

- ESLint `sf-locators/no-fragile-locators` on `tests/**`.
- Locator dry-run validator before execution.
- Registry is the single source; page objects are generated from it.
