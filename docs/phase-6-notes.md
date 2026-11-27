# Phase 6 notes: Visual QA

Branch `claude/phase-6-visual-qa` (from `claude/phase-5-execution-reporting` at `6ce8198`). One commit per task (T1–T6),
plus one commit per fix found in the fixture runs.

**Exit criterion (PLAN.md §11):** a seeded visual change is reported as a candidate, and approving the baseline clears it.
**Status (2026-11-27):** met on the **offline fixture** (FIXTURE). The live qa-prod proof has **not run yet**: the
operator chose "not yet" for the live start. The steps are listed under *Live proof (pending)*.

**Scope (operator, 2026-11-27):**
- Baselines for the New Contact dialog, the Contact record page (Details) and the Account record page.
- Persona system-admin; viewports desktop 1440×900 and tablet 1024×768.
- Masks for names, dates, IDs and spinners.
- Layout checks, an accessibility suite and the visual-diff report.
- Proof on the fixture first, then on qa-prod. The seeded change is a field moved on the Contact page layout in Setup.

TC-022 was replaced by **TC-SF-219-053** in the decided rebuild (commit b4a56ad). The a11y suite reuses TC-053's
helpers and scan rule; TC-053 itself is unchanged.

## What was built

| Task | Result | Main files |
|---|---|---|
| T1 Contracts + config | BaselineRecord / BaselineManifest, VisualCandidate (MATCH · NO_BASELINE · DIFF · RE_APPROVE · NOT_CAPTURED), LayoutFinding, A11yFinding, A11yRegionCheck, VisualRunSummary. `execution.yaml` `visual.viewports` / `baselineDir` / `regionRatio` / `layoutShiftThreshold`. New checkpoint `approve-visual-baseline` at L1, L2 and L3. No new IssueKind. | `src/core/schemas/visual.ts`, `src/config/schemas.ts`, `config/policy.yaml` |
| T2 Helpers | Mask plan and stable capture (spinners settled, fonts loaded, no focus ring, animations off, caret hidden). Local layout checks: overlap, clipped fixed text, off-screen, hidden required control, layout shift via `PerformanceObserver`, blank / loading / error state. | `tests/support/visual.ts`, `tests/support/layout.ts` |
| T3 Fixture | Contact page layout as data: field order of the Details panel and the Contact form, set with `qa fixture serve --layout <file>`. Adds `contact-moved-field.json` (Phone moved below Lead Source) and a Created By + date line. | `src/fixture/layout.ts`, `examples/fixture/layouts/` |
| T4 Suite | `VIS-001`: 3 regions per persona × viewport. `A11Y-001`: scoped axe, Tab order, unnamed controls from the ARIA snapshot. Runs with its own `playwright.visual.config.ts` (per-org `snapshotPathTemplate`, `updateSnapshots: 'none'`, retries 0). | `tests/visual/`, `playwright.visual.config.ts` |
| T5 Runner + CLI | Shared preflight (`qa run` uses it too): identity, browser, sessions, recipe approval. `qa visual run / approve / status`. Candidates are built from Playwright attachments. Each approval is bound to the image hashes and audited per baseline. `--a11y` accepts new Salesforce-owned rules. | `src/runner/preflight.ts`, `src/visual/`, `src/cli/visual.ts` |
| T6 Report + validator | `report/visual-diff.{md,html}` shows baseline / actual / diff, layout and a11y results, with the FIXTURE banner. Visual runs get their own `report/index.md`. `qa report --run` rebuilds them. Independent check: `pnpm validate:visual`. | `src/visual/report.ts`, `scripts/validate-visual.ts` |

Tests: **652 passing** (Phase 5 ended at 603). `pnpm typecheck` and `pnpm lint` were green after every task.

## How it works (short)

1. **`qa visual run --org <alias>`**
   - Runs the same preflight as `qa run`. A missing recipe approval is BLOCKED before any test starts.
   - Then runs `playwright test -c playwright.visual.config.ts`, with one project per persona × visual viewport.
2. **Each region:**
   - Settle the page.
   - Mark volatile values: the run prefix, links (record, user, mailto, tel), the record title, dates, IDs, emails,
     phones and counters.
   - Run a soft `toHaveScreenshot` against `tests/visual-baselines/<org>/<region>-<persona>-<viewport>.png`. Volatile
     values are hidden through `stylePath` and spinners are masked.
   - Attach the same image as `visual-shot-*.png`, so a matching region can still be re-approved later.
   - Run the layout checks.
   - Modal dialogs are captured by their content box (`contentClip`), never the page behind the backdrop.
3. **Collect** (`src/visual/collect.ts`):
   - Playwright error "snapshot doesn't exist" → `NO_BASELINE`.
   - expected + actual → `DIFF`, with the exact pixel ratio computed from the PNG size.
   - Matched, and the baseline is approved, unedited (sha256) and on the same release → `MATCH`. Otherwise →
     `RE_APPROVE`.
   - Nothing captured → `NOT_CAPTURED`.
   - Salesforce-owned axe rules: `BASELINE` if accepted, otherwise `NEW_STANDARD`. Custom-namespace violations →
     `FAIL`.
4. **`qa visual approve --run <id> --by <name>`** is a human checkpoint at every autonomy level.
   - The approval subject is `visual:<org>:<hash of name=sha256…>`.
   - Images are copied into the baseline folder, each with a BaselineRecord: hash, release, approval id, source run.
   - Every baseline gets an audit row.
   - A tampered actual image is skipped.
5. **Data:** each test creates an Account + Contact with the approved recipe. The run reconciles every sub-run and
   re-queries by tag.

## Fixture findings that changed the code

| # | Run | Finding | Fix |
|---|---|---|---|
| 1 | run-p6-fixture-1 | With `updateSnapshots: 'none'`, a missing baseline produces only an error and no `-actual` attachment, so it was read as DIFF | "snapshot doesn't exist" → NO_BASELINE; the proposal image is the attached `visual-shot` |
| 2 | run-p6-fixture-2 | The dialog element is full-viewport (fixture and Lightning `slds-modal`), so the screenshot showed the Account page behind the backdrop with unmasked run data | `contentClip` captures the overlay's content box; page-level masks are dropped there; the pre-filled Account lookup is masked |
| 3 | run-p6-fixture-6 | **The seeded move was missed at 1 %:** 6 MATCH. Painted masks also took the width of each run-unique name (85 px of noise per region) | Volatile values hidden with `visibility: hidden` (same blank space every run). Calibrated: noise 0 px; a moved field is 409 px (0.135 %) on the Details panel and 3,570 px (0.98 %) in the dialog. Default `maxDiffPixelRatio` 0.01 → **0.0005**. Exact ratio from the PNG size (Playwright rounds to 2 decimals) |
| 4 | calibration | `toHaveScreenshot` takes `stylePath`, not `style` (only `locator.screenshot` takes `style`), so values were not hidden in the compared image | The stylesheet is a file: `tests/support/visual-volatile.css` |

Calibration runs `cal-p6-a*`, `cal-p6-b*` and `cal-p6-c*` used a scratch baseline folder and a temporary local ratio of
0. Both were removed afterwards and are not part of the proof.

## Exit proof — offline fixture (FIXTURE)

```powershell
pnpm qa fixture serve --port 4545
pnpm qa visual run --org fixture --autonomy L3
pnpm qa visual approve --run <id> --by "<name>"
pnpm qa fixture serve --port 4545 --layout examples/fixture/layouts/contact-moved-field.json
pnpm validate:visual <runIds>
```

| Run | Layout | Result | Approval (operator in chat, Rakesh Sharma) |
|---|---|---|---|
| run-p6-fixture-4 | default | 6 NO_BASELINE (old masking) | AP-f71bef8f4577 |
| run-p6-fixture-7 | default | 4 DIFF (masking change only) · 2 MATCH | AP-02ff7741f095 |
| run-p6-fixture-8 | default | **6 MATCH** | — |
| run-p6-fixture-9 | **Phone moved** | **4 DIFF**: dialog 3,570 px (0.979 %) and Details 409 px (0.135 % desktop / 0.192 % tablet), both viewports; Account record 2 MATCH. The diff image shows the Phone / Title / Lead Source labels changing places | AP-74584af9d3b7 |
| run-p6-fixture-10 | Phone moved | **6 MATCH** — approving cleared the candidates | — |
| run-p6-fixture-11 | default (revert) | 4 DIFF (back to the original order) | AP-8dec52d43855 |
| run-p6-fixture-12 | default | 6 MATCH | — |

- All of the runs listed above (fixture-4, 7–12) used data CLEAN (4 sub-runs each, re-query 0). Layout findings 0; a11y FAIL 0; no Salesforce-owned violations on the fixture.
- `pnpm validate:visual run-p6-fixture-7 … run-p6-fixture-12` → all **valid**. The validator re-derives statuses from
  Playwright's JSON and checks image hashes, approvals before MATCH, baselines bound to approval + hash, data, audit
  and report banner.
- `qa visual status --org fixture`: 6 baselines, all OK.

## Live proof on qa-prod (pending — not run)

The operator answered "not yet" to the live start on 2026-11-27. Steps when approved:

1. `pnpm qa visual run --org qa-prod` (L2; recipe approval `AP-fc20bc1739d9` if the recipe version is unchanged) → 6
   NO_BASELINE plus any Salesforce-owned a11y rules. The operator approves them (`--a11y` if wanted).
2. Re-run → must be 6 MATCH. If live noise exceeds 0.05 %, tighten the masks first; any ratio change goes into
   `regionRatio` and shows in the report.
3. **Operator, in Setup:** Object Manager → Contact → Page Layouts → Contact Layout → drag **Phone** to another row or
   column → Save. Do not run `qa discover` while the layout is moved.
4. Re-run → expect DIFF on contact-details and new-contact-dialog for both viewports. The operator approves → re-run
   must be 6 MATCH.
5. Operator reverts the layout → re-run → approve → MATCH.

## Not verified / known limits

- **Live qa-prod**: not run, so nothing above is a Salesforce result. Lightning's real rendering noise is unknown, and
  0.05 % may be too tight live.
- Both dialog markups were fixed full-viewport overlays: the fixture's and Lightning's `slds-modal`, which the fixture
  copies. `contentClip` on the real Lightning DOM (shadow roots) is unverified.
- Tab-order check on Lightning: page layouts can be set to top-down Tab order, so the row-order expectation may not
  hold on qa-prod.
- Unnamed controls are recorded as candidates only; they cannot be split into Salesforce-owned and ours.
- No LLM classification of candidates (`allowExternalUpload: false`). Experience Cloud pages are blocked, as in Phase 2.
- Only one smaller viewport (tablet). `laptop` is configured but not in `visual.viewports`.
