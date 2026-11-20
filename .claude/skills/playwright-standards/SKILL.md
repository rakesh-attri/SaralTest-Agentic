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
- Independent tests: own data, no order dependence; `test.describe.configure({ mode: 'parallel' })` unless the case says serial.
- Screenshots: on failure (config), plus `toHaveScreenshot` only on masked component regions for `@ui` cases.
- Accessibility (`@a11y`): `new AxeBuilder({ page }).include('<custom LWC scope>').analyze()`; ignore Salesforce base chrome.
- `playwright.config.ts`: `trace: 'retain-on-failure'`, `video: 'retain-on-failure'`, `retries: 1` (flaky detection),
  reporters `list`, `json`, `html {open:'never'}`, `reporting-labs`.

## Enforcement

ESLint (incl. locator rule), `tsc --noEmit`, Test Reviewer pass 2 checklist (skill `test-design`), DeepEval GEval
"test matches case, assertions not weakened".
