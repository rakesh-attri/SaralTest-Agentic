# Playwright / MCP guide: generated tests, page objects, locators

How Phase 4 turns reviewed test cases into Playwright tests, and how they are checked without being run.
Execution is the Runner's job in Phase 5. Rule 5 of CLAUDE.md applies: generated tests run under Playwright
Test; Playwright MCP is used only for exploration, locator discovery and healing.

## 1. Pipeline (`qa build`)

```
qa design run (APPROVED cases)
  → build:   page objects from the locator registry (code)
             → Test Generator (coder role) fills a Zod test IR per case (deterministic checks reflected back)
             → code renders the spec (playwright-standards template), Prettier
             → tsc · ESLint (sf-locators) · playwright test --list · locator dry-run
  → review2: Test Reviewer pass 2 (deterministic checklist + judge ≠ coder)
             → regenerable findings go back to build (≤ 2 rounds) → QA Lead settlement
  → report:  runs/<id>/build/ + tests/generated/<story>/manifest.json
```

```powershell
pnpm qa build --from-run run-p3-live-5 --org qa-prod --run-id run-p4-live-1
pnpm validate:build run-p4-live-1
npx playwright test --list --reporter=list
```

Code: `src/agents/test-generator/` (context, render, graph, pageObjects, expression, dryRun, toolchain),
`src/agents/test-reviewer/pass2.ts`, `src/graph/buildNodes.ts`, `src/graph/buildReport.ts` and `src/cli/build.ts`.

## 2. The test IR (the model never writes TypeScript)

Schema: `src/core/schemas/generation.ts`.

- **Actions:** `openRecord`, `openNewFromRelatedList`, `fill`, `clear`, `click`, `selectTab`, `apiUpdate`, `adopt`.
- **Assertions:** `visible` / `hidden`, `inputValue`, `fieldError`, `toast`, `recordView`, `recordTitle`,
  `relatedListHasRecord`, `soqlField`, `soqlNoRecord`, `apiRejects`, `historyTracked`, `a11yScan`, `tabOrder`.
  Each assertion cites a case step's expectation.
- **Values:** `data` (recipe field), `recordId`, `literal`, `length`, `unique` (text / email / phone).

Deterministic checks (`irProblems`) run on every model answer and again in pass 2:
- every case step is implemented, and every assertable expectation is asserted with that step's evidence;
- only catalog elements are used, with the right roles, and only on a page that is open at that point of the
  flow (page context);
- related-list buttons are used only through `openNewFromRelatedList`;
- literals appear in the case text, the recipe or the UI labels; lengths are stated in the case step;
- API error codes are derivable from metadata;
- UI-created records are adopted with the value the test typed;
- keyboard checks cover every field of their scope.

## 3. Page objects

`qa locators page-objects --org <alias>` (also run by `qa build`) generates `tests/pages/*.ts` and
`page-catalog.json` from `.qa-memory/locators.db`:
- One class per page: AccountRecordPage, ContactRecordPage, NewContactDialog.
- Members:
  - registry rows (field → `lastName`, otherwise `<scope> <name>` + a role suffix, e.g. `contactsNewButton`);
  - scope regions (`contactsRelatedList`);
  - the root region.
- RE_VERIFY rows stay, flagged. A spec that uses one is REVIEW_REQUIRED.
- Labels live only here. Tests use members and helpers.

## 4. Locator rules: `sf-locators/no-fragile-locators`

Package: `packages/eslint-plugin-sf-locators`, wired in `eslint.config.js` for `tests/**` (except `tests/unit`).
It bans:
- XPath, generated ids, `[id^=`, numeric `aria-labelledby`, `data-aura-*`;
- `nth-child` / `nth-of-type`, `.slds-*` selectors, and `force-*` / `lightning-*` tag chains;
- hard-coded record ids in `goto` or locators;
- `.nth()` without `// order:`, `.first()` / `.last()` without `// unique-test-data:`;
- `waitForTimeout`.

`tests/**` also bans raw `fetch` (use the `sf` / `data` fixtures).

## 5. "Resolve" without execution

| Check | How |
|---|---|
| TypeScript | `tsc -p tsconfig.json --noEmit` (imports use `.js` extensions under NodeNext) |
| ESLint | ESLint Node API on the spec files |
| Load / list | `playwright test --list --reporter=json <files>`: loads every spec and its imports; nothing runs |
| Locator dry-run | `src/agents/test-generator/dryRun.ts`: opens each page as the persona (frontdoor storageState, the Explorer's page specs, tabs prepared, dialogs cancelled) and requires `count() === 1`, visible and enabled for every member the specs use |

Run the dry-run on its own with:

```powershell
pnpm qa locators dry-run --org qa-prod --manifest tests/generated/SF-219/manifest.json
```

Registry expressions are parsed by a small grammar (`expression.ts`: getBy* / locator chains), never evaluated
as code. MCP is not used: `browser_evaluate` is blocked, and rule 5 applies.

## 6. Runtime support used by generated specs

| File | What |
|---|---|
| `playwright.config.ts` | `testDir tests/generated`; one auth + test project per persona (`@persona:<id>` tag), storageState `.auth/<org>/<persona>.json`, channel from `config/execution.yaml`, reporters list / json / html / reporting-labs |
| `tests/setup/auth.setup.ts` | identity check, then the frontdoor session per persona |
| `tests/fixtures/index.ts` | `persona`, `sf` (identity-checked GuardedSalesforce), `data` (per-test data sub-run, verified cleanup), `a11y` |
| `tests/support/lightning.ts` | waitForSpinners, expectToast, openRecord, selectTab, showRelatedList, relatedListRecord, expectFieldError, expectRecordTitle, recordIdFromView, selectPicklist, fillLookup |
| `tests/support/api.ts` | soqlValue, soqlCount, historyFields (bind-safe SOQL) |
| `tests/support/a11y.ts` | scanScoped / classifyViolations / recordBaseline / checkTabOrder (operator rule below) |

**a11y rule (operator, 2026-11-21):**
- The axe scan is scoped to the dialog.
- Violations in Salesforce-owned markup are known baseline findings (annotation plus `a11y-baseline.json`).
- Only violations in `a11y.customNamespaces` (default `c`) fail the test, together with the keyboard check:
  reachability, focus trap and visual reading order.

## 7. Test Reviewer pass 2 verdicts

| Verdict | When |
|---|---|
| BLOCKED | an H finding of a blocking rule remains: typecheck, lint, not listed, locator unresolved, persona unavailable, invalid data binding, AST violation, spec missing |
| REVIEW_REQUIRED | a mechanical skeleton, a RE_VERIFY locator, no dry-run, or any finding escalated by the QA Lead (e.g. a judge finding not fixed in 2 rounds) |
| APPROVED | a generated spec with no open finding and a resolved dry-run |

Only APPROVED specs are executed by the Runner (Phase 5).

## 8. Execution (`qa run`, Phase 5)

The generated specs are executed by the Playwright Test runner through the Runner (`src/runner/execute.ts`), never
step by step through Playwright MCP (CLAUDE.md rule 5).

1. **Gate** — only APPROVED specs with a current dependency record run (`src/runner/gate.ts`). Staleness is re-checked
   against the org the specs were built for only (`manifest.org`).
2. **Preflight** — identity check (HARD_STOP → run BLOCKED), browser resolution, one browser session per persona (its
   landed host becomes `SF_BASE_URL`), recipe approvals (missing → BLOCKED before any test).
3. **Run** — `npx playwright test <spec files> --project <persona>` with `QA_ORG`, `QA_RUN_ID`, `QA_RUN_DIR`,
   `QA_STORY_KEY`, `QA_BROWSER`, `QA_AUTONOMY`, `QA_ENVIRONMENT`, `SF_BASE_URL`. Spec filters come before `--project`
   (a variadic option).
4. **Results** — `results.json` (normalised), `playwright-results.json` (raw). See `docs/reports-guide.md`.
5. **Data** — one data sub-run per test attempt; afterwards every sub-run is cleaned again and re-queried; untagged
   records created by the run user during the run are reported.

**Browsers.** `--browser` > `QA_BROWSER` > `config/execution.yaml` `browser`. `chromium` is Playwright's bundled browser;
`chrome` / `msedge` are local installs (Playwright `channel`). A channel that cannot be launched falls back to
`fallbackBrowser`, and every result records the fallback.

**Lightning behaviour the helpers handle (qa-prod, Phase 5):**
- a failed save shows a popover ("We hit a snag." / "Similar Records Exist") that is its **own modal dialog** and hides
  the record form from the accessibility tree — `expectFieldError` closes it first (`closeSavePopover`);
- a picklist near the bottom of a record modal opens under the docked form footer — `selectPicklist` picks the same
  option by keyboard when the click is intercepted;
- a Save from a related list **stays on the parent record** (toast + new row); it does not open the new record.

None of these change an assertion, an expected value or a step.
