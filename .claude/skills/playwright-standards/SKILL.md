---
name: playwright-standards
description: Coding standards for generated Playwright TypeScript tests in this repo — structure, page objects, fixtures, tags, test.step, web-first assertions, reporting-labs meta, no sleeps. Use whenever generating, reviewing or healing a test file or page object.
---

# Playwright standards (generated tests)

## File layout

- `tests/generated/<storyKey>/<TC-id>-<slug>.spec.ts` — one test case per test (data-driven variants allowed via loops over a typed table).
- `tests/pages/*.ts` — page objects generated from the locator registry. Tests never contain raw locators
  except scoped `getByRole` calls on page-object regions.
- `tests/support/lightning.ts` — shared Lightning helpers.
- `tests/fixtures/*.ts` — `sf`, `data`, `persona` fixtures; tests import `test, expect` from `tests/fixtures`.

## Template

```ts
import { test, expect } from '../../fixtures';
import { meta } from 'reporting-labs';
import { OpportunityPage } from '../../pages/OpportunityPage';

test.describe('SF-1234 Closed Won creates Contract', () => {
  test('TC-07 Sales Rep closes an Enterprise opportunity', { tag: ['@functional', '@regression', '@sales-rep'] },
    async ({ page, data }) => {
      meta({ priority: 'P1', severity: 'critical', feature: 'Opportunity', story: 'SF-1234', owner: 'qa-agent' });
      const opp = await data.create('Opportunity', { RecordType: 'Enterprise', StageName: 'Negotiation' });
      const oppPage = new OpportunityPage(page);

      await test.step('Open the opportunity', () => oppPage.open(opp.id));
      await test.step('Set stage to Closed Won and save', () => oppPage.setStage('Closed Won'));
      await test.step('Contract appears in related list', async () => {
        await expect(oppPage.relatedList('Contracts').getByRole('row')).toHaveCount(2); // header + 1
      });
    });
});
```

## Rules

- Every test: `meta()` with priority, severity, feature, story (JIRA key), owner; tags for test type + persona.
- Every business action in `test.step()` with a human-readable name (it appears in both reports).
- Web-first assertions only; no `waitForTimeout`; no `if` branches that skip assertions.
- One clear oracle per step: expected values come from the test case, which comes from requirements (traceable).
- **Never assert on URLs or record IDs — they are dynamic** (operator rule 2026-11-26). No `toHaveURL`, no
  `page.url()`, no `recordIdFromView`, no comparison with `data.id(...)` / ids read from the page, no hard-coded ids.
  After a create Save, assert in this order:
  1. the success toast contains the name we entered (`expectToast(page, name)`);
  2. the record appears in the related list with that exact name (`relatedListRecord(list, name)` visible);
  3. open it from the related list and assert the record header shows the same name (`expectRecordTitle`);
  4. verify with SOQL **by the run tag** that the stored values match what we entered
     (`data.tagged(object, { LastName: name }, [...fields])` → exactly 1 record, `toMatchObject` the typed values;
     a parent is compared by name, e.g. `Account.Name`, never by id).
  The name typed into a create form is run-unique (`data.unique(...)`), so the record is found by the run tag and
  cleaned up (code tags it with `data.adopt` by that name). Records the data factory created may still be *opened*
  by their ledger id (navigation, not an assertion).
- **Generated values respect the field's max length** from the org snapshot, run-unique suffix included
  (operator rule 2026-11-26): `data.unique(label, format, maxLength)` shortens the label, then drops it, and always
  keeps the random token; a literal longer than its field is refused. (run-p5-live-5: a 41-character First Name was
  cut to 40 by Salesforce.)
- **Read a field on the tab that shows it** (operator rule 2026-11-26): record page objects have
  `fieldInDetails(field)` (opens Details, returns the field) and `listInRelated(list)` (opens Related when the list is
  not shown). Generated tests always read through them: `expect(await page.fieldInDetails(page.titleField))…`. A
  record page opens on Related (run-p5-live-5: Title / Email checks found nothing).
- **Unique values are made at run time, per test, one per record** (operator rule 2026-11-26): names and emails
  come from `data.unique(...)` when the test runs — never a value fixed at build time (`QA-run-…`), never one value
  shared by two records the test creates (only a duplicate-warning test reuses a value on purpose). Record names in
  `data.adopt` are short identifiers.
- Independent tests: own data, no order dependence; `test.describe.configure({ mode: 'parallel' })` unless the case says serial.
- Screenshots: on failure (config), plus `toHaveScreenshot` only on masked component regions for `@ui` cases.
- Accessibility (`@a11y`): `new AxeBuilder({ page }).include('<custom LWC scope>').analyze()`; ignore Salesforce base chrome.
- `playwright.config.ts`: `trace: 'retain-on-failure'`, `video: 'retain-on-failure'`, `retries: 1` (flaky detection),
  reporters `list`, `json`, `html {open:'never'}`, `reporting-labs`.

## Enforcement

ESLint (incl. locator rule), `tsc --noEmit`, Test Reviewer pass 2 checklist (skill `test-design`) — including rule
`dynamic-assertion` (H, blocking): any URL / record-id assertion rejects the spec; `field-length`, `tab-unaware-read`,
`build-time-value` and `shared-unique` (H, blocking) enforce the three value / tab rules above — DeepEval GEval "test matches case,
assertions not weakened". The Test Generator renders the after-Save order above from a `recordView` assertion
(`src/agents/test-generator/render.ts`).
