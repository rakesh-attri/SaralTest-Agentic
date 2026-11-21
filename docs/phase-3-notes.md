# Phase 3 notes: Test planning

Branch `claude/phase-3-implementation-ce8175`, built on Phase 2 `main` (e4e9fc1). There is one commit per task, T0–T8,
plus one commit per fix found in the demo runs.

**Exit criterion (PLAN.md §11):** every AC covered; every expectation evidence-labelled; Reviewer findings resolved or
justified. **Met, live on qa-prod and on the offline fixture.** The independent validator
(`pnpm validate:design`) passes for every proof run. The evidence is under *Exit proof* below.

## What was built

| Task | Result | Main files |
|---|---|---|
| T0 Judge model | Judge set to a Gemini Pro model as the operator decided, with a flash-lite fallback. The live probe was blocked (see *Blockers*). | `config/models.example.yaml` (+ local `config/models.yaml`) |
| T1 Contracts | `RiskItem`, `TestCharter`, `ImpactReport`, `CoverageObligation`, `ReviewFinding`. `TestCase` gains `reviewReasons`, `origin`, `refs`, `obligationIds` and `regressionTier`. An APPROVED case may hold only assertable levels, and every non-UNKNOWN expectation must cite evidence. `RtmRow` gains refs, risks, types, manual tests, status and coverage. | `src/core/schemas/design.ts`, `testCase.ts`, `src/graph/state.ts` |
| T2 Oracles | Evidence index (requirement sections, org checks, snapshot components, locators, manual tests). Code assigns the evidence level, runs a grounding check on values, and decides case status. | `src/oracles/` |
| T3 Risk + obligations | A deterministic risk model scores each requirement from evidence-backed drivers and places it in a regression tier. Coverage obligations: positive / negative / boundary / deny / allow / bulk / nfr / regression, each with its allowed and must-cite evidence. Personas are resolved through the org cross-check. | `src/agents/impact-risk/` |
| T4 Test Planner | `runStructured` drafts cases for each batch of obligations, and deterministic checks are reflected back to the model. Code assigns ids, priority, levels, status, tiers and the RTM. There is a mechanical degrade path, manual-test reuse, stable case ids and a revise step. | `src/agents/test-planner/` |
| T5 Test Reviewer pass 1 | The skill checklist runs as deterministic rules, rechecked every round. A judge LLM adds findings (ids validated) and later verifies them. The QA Lead then settles every finding, so none stays OPEN. | `src/agents/test-reviewer/` |
| T6 Graph + outputs | `plan ⇄ review` nodes run behind a design hook. A run seeded with analysis output enters at `plan`. Outputs: charter, test plan, test cases, RTM JSON + **XLSX**, risks, obligations, review findings, **HTML test-design report**. | `src/graph/designNodes.ts`, `designReport.ts`, `mainGraph.ts` |
| T7 CLI + validator | `qa design`, `qa review`; `qa analyze --org` now continues into plan/review; `pnpm validate:design`. | `src/cli/design.ts`, `scripts/validate-design.ts` |
| T8 Demo + docs | Fixture and live proof, 9 fixes from the demo runs, docs. | this file, `docs/test-design-guide.md` |

Tests: **394 passing** in 36 files (Phase 2 had 317 in 30). `pnpm typecheck`, `pnpm lint` and `pnpm test` are green
after every task. One full-suite run during T8 reported one failed *file* with every test passing. Two immediate
re-runs were green and the failure did not recur, so it is recorded as intermittent and unidentified (most likely a CLI
e2e timeout under load).

## How it works (short)

1. **Code decides the facts; the model drafts the wording.**
   - Obligations, risk scores, tiers, priority, evidence levels and review status are computed by code.
   - The model writes titles, actions and expected text.
   - Each step names its obligation and may cite only that obligation's allowed evidence.
   - Code also appends the obligation's **must-cite** evidence to every step, whatever the model cites:
     - the org check a negative case is about;
     - any whole-requirement contest, such as a component the org does not have.
2. **Evidence levels (PLAN.md §7f):**

   | Cited evidence | Level |
   |---|---|
   | Anything contested (org CONFLICT / NOT_FOUND / UNKNOWN, an ambiguity, an unanswered or only-assumed clarification, an assumption or prose block) | `UNKNOWN_OR_CONTRADICTORY` — always wins |
   | An org fact or declared component | `DECLARED_CONFIG` |
   | An uncontested story AC / BRD rule / NFR | `APPROVED_REQUIREMENT` |
   | Only UI observations or manual tests | `OBSERVED_ONLY` |

   `VERIFIED` is never assigned before executed runs exist (Phase 5).
3. **Grounding:**
   - Every quoted value and number in an expectation must appear in the cited evidence, in the step's own action or
     preconditions (test data), or in a UI label the Explorer observed.
   - A guessed error message is therefore rejected.
4. **Requirement-level review reasons:**
   - A reason blocks the cases that cite the sections its source (finding, clarification or inline ref) points to.
   - A reason with no refs ("generated mechanically", "no expected outcome stated") blocks every case of that
     requirement.
5. **Reviewer loop:**
   - Round 1 runs the deterministic rules and the judge. The planner then revises, and each revised case is accepted
     or rejected on its own; a revision may never lose coverage.
   - Round 2 rechecks the deterministic rules, and the judge verifies its own findings.
   - The QA Lead then settles anything still open:
     - lost coverage is restored with a mechanical case (RESOLVED);
     - an unavailable persona or a high risk with blocked cases is JUSTIFIED with the recorded reason;
     - everything else is escalated: the affected cases become REVIEW_REQUIRED for a human, and the finding is
       JUSTIFIED and marked `escalated`.
   - A deterministic H finding can never be justified away by the planner.

## Decisions and deviations

- **Judge = Gemini Pro, as decided — but blocked by billing.**
  - `gemini-2.5-pro` returns 404 ("no longer available to new users").
  - `gemini-3.1-pro-preview` returns 429 (free-tier Pro quota 0).
  - The judge is configured as `gemini-3.1-pro-preview` with `gemini-3.1-flash-lite` as fallback, still ≠ the coder.
  - Every judge verdict in the live runs came from the fallback. Outputs label this as `judge=google/gemini-3.1-flash-lite (fallback)`.
- **No new `IssueKind`, so `config/policy.yaml` is unchanged.** Planner and reviewer failures use INVALID_LLM_OUTPUT /
  TRANSIENT / DATA; triage can degrade `plan` and `review`.
- **The evidence ledger stays in memory** (JSON in `runs/<id>/design/evidence.json`). The planned SQLite `evidence.db`
  is not needed by Phase 3: the evidence index resolves every id. It is listed as partial in the capability matrix.
- **`qa design` re-runs the org cross-check** against the chosen snapshot instead of reading an old
  `org-crosscheck.json`. The check is deterministic and cheap, and this keeps snapshot and checks consistent.
- **"Approved requirement" means an AC / BR / NFR section of the story or BRD.** There is no separate approval state in
  JIRA yet; contested sections are excluded as described above.
- **The live demo used the main checkout as `--root`** (runs, `.qa-memory`, config, `.env` live there). It is read-only
  on Salesforce: no record or metadata was written.
- **`run-p3-live-7` ran from an isolated root** (a copy of the config, the Phase 1 run and the knowledge stores in a temp folder).
  - Reason: another session changed the main checkout's `config/models.yaml` during this phase to NVIDIA NIM / Groq
    providers that only its uncommitted code understands (see *Open items*).
  - I did not touch that file. The isolated root uses the Phase 3 Gemini model config.
  - The API key was passed to the process environment only, never copied to disk.
  - The run folder was then copied to `C:\Projects\SaralTest-Agentic\runs\run-p3-live-7`.

## Fixes from the demo runs

Every fix is generic, was found in our own output, and has a regression test.

| # | Seen in | Defect | Fix |
|---|---|---|---|
| 1 | fixture | `account-contact.md` gave 0 requirements: a numbered list under a plain "Acceptance criteria:" label was not recognised | numbered items under an AC heading become AC1..ACn, but only when the document has no explicit `AC n` lines (`src/inputs/sections.ts`) |
| 2 | fixture | the mechanical analysis of AC4 ("Read-Only cannot create") became an **APPROVED** case run as system-admin | requirement-level review reasons are carried into the cases |
| 3 | live-1 | obligations whose sections were all contested had **no** citable evidence, so the model looped and the batch degraded | such obligations cite the contested evidence and are labelled UNKNOWN |
| 4 | live-1 | the BR-02 boundary cited `Field:Account.Name` ("Name" ⊂ "Last Name"); the AC5 boundary used `Account.Phone` | the field lookup is limited to the requirement's objects, and the longest label wins |
| 5 | live-1 | "06" in "BR-06" was flagged as an invented number | numbers inside ids are not values |
| 6 | live-1 | the NFR-01 perf case was APPROVED although its requirement needs a measurement method | requirement reasons are scoped by their refs (replaces fix 2's regex) |
| 7 | live-1 | the planner's JSON had raw newlines inside strings, causing reflect loops | lenient parse escapes control characters inside string literals (`src/agents/shared/structured.ts`) |
| 8 | live-1 | a batch of 11 obligations timed out (120 s) | planner batch size 6 |
| 9 | live-2 | **AC1 lost all coverage** in the revise step | revisions can never lose coverage; the QA Lead restores uncovered obligations with mechanical cases |
| 10 | live-2 | the "New" button label and manual-test data ("Acme Test") counted as invented | grounding also accepts preconditions and observed UI labels |
| 11 | live-3 | an **APPROVED** case asserted `Number_of_Contacts__c = 50`, a field qa-prod does not have (OC-013) | must-cite evidence: whole-requirement contests attach to every obligation |
| 12 | live-3 | an "Email is required" step cited BR-03 without its OC-003 conflict and became APPROVED_REQUIREMENT | must-cite: a check-derived negative always carries its own org check |
| 13 | live-3 | a case ran as `sales-rep` (no test user) although its obligation needs no persona | an unavailable persona is rejected unless the obligation requires it |
| 14 | live-3 | "the system enforces the requirement as per business rule" passed as an expectation | the restated-rule pattern counts as vague; the planner uses the same rule while drafting |
| 15 | live-4 | one wrong persona discarded the whole revision | revised cases are accepted individually (originals kept for rejected ones) |
| 16 | live-4 | '123456789' was not recognised as the 9-digit boundary | boundary values are also matched as input lengths |
| 17 | live-5 | 5 of 6 revised cases were rejected only for omitted evidence or an invented recipe name | drafts are normalised: omitted evidence = the obligation's full allowed list; unknown recipe names are dropped |
| 18 | live-7 | mechanically drafted cases that reuse a manual test were labelled `manual-reuse` | mechanical cases keep `origin: mechanical` and still record `manualTestId` |

## Exit proof

### Live: qa-prod, story SF-219 (= jira-story-SF-QA-DEMO), Phase 1 requirements, Phase 2 snapshot, manual tests

Inputs:
- Phase 1 run `run-p1-final-combined`: SF-219 + BRD-CON-012 PDF + the 10 manual tests MTC-001..010; 15 requirements, 3 questions assumed.
- qa-prod snapshot `snap-00DdN00000uQ5dK-20261120141700-b92b` (`run-p2-live-5`; 400 components, LIVE).
- Fresh cross-check: 1 EXISTS, 5 CONSISTENT, 1 NOT_FOUND, 4 CONFLICT, 2 UNKNOWN.
- 115 registry locators, and 6 open RE_VERIFY marks from the Phase 2 rule change.

| Run | Code | Result | AC | Labelled | Findings | Cases (A / RR / B) |
|---|---|---|---|---|---|---|
| live-1 | T7 | exit met, but fixes 3–8 needed | 7/7 | 30/30 | 0 open | 7 / 14 / 2 |
| live-2 | +fixes 3–8 | **AC1 uncovered** → fixes 9–10 | 6/7 | 26/26 | 0 open | 11 / 5 / 2 |
| live-3 | +9–10 | met, but fixes 11–14 (wrong APPROVED cases) | 7/7 | 34/34 | 0 open | 5 / 10 / 3 |
| live-4 | +11–14 | met; revise failed → fixes 15–16 | 7/7 | 31/31 | 0 open | 5 / 13 / 2 |
| **live-5** | 2df7eb6 | **COMPLETE, all batches drafted live** | **7/7** | **33/33** | **0 open** (1 resolved, 9 justified, 5 escalated) | 7 / 11 / 2 |
| live-6 | 9479906 | **mechanical**: the main `models.yaml` had been changed by another session (unparseable for this code) | 7/7 | 28/28 | 0 open | 12 / 14 / 2 |
| **live-7** | 9479906, isolated root | met; revise applied 3 changes; one planner batch drafted mechanically (labelled) | **7/7** | **29/29** | **0 open** (1 resolved, 11 justified, 7 escalated) | 7 / 13 / 2 |

`pnpm validate:design --root C:\Projects\SaralTest-Agentic run-p3-live-5 run-p3-live-6 run-p3-live-7` → **all
design outputs valid**. The validator re-parses every file with the Zod contracts. It takes the ACs from the analysis
sources (not from the design's own summary), checks that every requirement has cases, and checks that no finding is
OPEN and every JUSTIFIED one has a reason.

**`run-p3-live-5` in detail** (`runs/run-p3-live-5/design/`):
- **ACs:** AC1→TC-001, AC2→TC-003, AC3→TC-005, AC4→TC-006, AC5→TC-035 + TC-008, AC6→TC-011 + TC-012, AC7→TC-013.
- **Expectations:** 15 APPROVED_REQUIREMENT, 10 DECLARED_CONFIG, 8 UNKNOWN_OR_CONTRADICTORY, 0 OBSERVED_ONLY,
  0 VERIFIED.
- **Risks:** 8 mandatory, 5 recommended, 2 optional.
  - RISK-01 (AC1, score 0.75) is driven by REVIEW_REQUIRED and by RE_VERIFY on MTC-001 / SF-219-R14 / R36 / R39 from
    the Phase 2 Phone rule change.
  - RISK-08 (AC7) scores only 0.06 and **stays mandatory**, because low risk never removes AC coverage.
- **Correctly not approved:**
  - Email required (OC-003 CONFLICT), Phone required when Web (OC-006), duplicate warning (OC-005: rule inactive),
    Title list (OC-011 + Q2), BR-08 open Cases (Q3, no stated outcome) and `Number_of_Contacts__c` (OC-013 NOT_FOUND)
    are all UNKNOWN_OR_CONTRADICTORY and REVIEW_REQUIRED.
  - The Read Only deny case (AC6) and the Sales Rep edit deny (BR-07) are **BLOCKED-NO-PERSONA**.
- **APPROVED (7):**
  - Last Name required (OC-002 + AC2) and its 79/80/81 boundary (BR-02 + `Field:Contact.LastName`).
  - Admin can create (`ObjectPermissions:Profile:System Administrator.Contact`).
  - AC7 related list, BR-05 mailing address default, NFR-02 accessibility, NFR-03 field history.
- **Reviewer:** 10 findings — 5 deterministic, 5 from the judge (flash-lite fallback).
  - 1 was RESOLVED by the judge after a revision.
  - 4 were JUSTIFIED by the planner with recorded reasons (sales-rep / sales-manager have no test users; contested BR-08;
    missing field).
  - 5 were escalated: the affected cases are REVIEW_REQUIRED for a human. Among them are two H judge findings on the Phone
    conditional rule — the judge is right that it is untested, and it cannot be tested until Q1 is answered and OC-006
    is resolved.
- **Files:** `test-plan.md`, `test-cases.md`, `charter.md`, `rtm.xlsx` (sheets RTM / Test Cases / Risks / Review
  Findings), `test-design-report.html`, plus the JSON set.

### Offline fixture (FIXTURE, mechanical)

The fixture used an isolated root with its own fixture server on port 4547: the stale Phase 2 server still holds
port 4545 and was not stopped.
1. `qa discover --org fixture` → `snap-00DFIXTURE00000-20261120161746-52f4`: 44 components, 0 UNKNOWN.
2. `qa analyze --file examples/stories/account-contact.md --offline` → 4 mechanical requirements (after fix 1).
3. `qa design --org fixture --offline --run-id run-p3-fixture-3` →
   - AC 4/4, 6/6 labelled, 0 findings;
   - **0 APPROVED**: every case is REVIEW_REQUIRED, correctly, because the requirements were derived mechanically;
   - FIXTURE and mechanical banners on every output.

`validate:design` → valid. Copied to `C:\Projects\SaralTest-Agentic\runs\run-p3-fixture-3`.

## Not verified / known limits

- **The judge is not a Pro model in practice:** every judge verdict came from `gemini-3.1-flash-lite`. Blocker: billing.
- **Model variability:**
  - Live runs differ: 18–23 cases; 6–14 approved at planning and 5–11 after review.
  - In 3 of the 6 runs with a model (live-1, live-2, live-7), one or two of the five planner batches fell back to
    mechanical drafting after reflect-retries (labelled; mechanical cases quote evidence verbatim, so they are correct
    but read stiffly).
  - Escalated findings (5–7 per run) need a human.
- **Must-cite and grounding are deterministic guards, not semantic proof.** Within one obligation the model may still
  word an expectation more strongly than its evidence; the judge and the escalation path are the backstop. A
  data-integrity check of each expectation against its evidence is a Phase 8 (DeepEval) item.
- **Boundary detection** knows `N characters` / `N digits` only. Dates, currency and numeric ranges are not derived yet.
- **Bulk obligations** need an active trigger or flow on a touched object in the snapshot. qa-prod has none for
  Contact, so no bulk case is required there (the judge suggested one; that finding was escalated).
- **`qa analyze --org` → plan/review end to end** is covered by `src/graph/design.test.ts` and the CLI e2e. It was not
  run live: it would repeat discovery and analysis, and the Gemini free tier is limited.
- **The evidence ledger is not persisted to SQLite** (`evidence.db`); it is JSON per run.

## Open items for the operator

1. **Another session changed `C:\Projects\SaralTest-Agentic\config\models.yaml`** to NVIDIA NIM / Groq providers, with
   uncommitted code changes in the main checkout (`src/config/schemas.ts`, `src/models/*`,
   `src/agents/shared/structured.ts`, …).
   - This branch cannot parse that file; that is why `run-p3-live-6` went mechanical.
   - When merging, expect a **conflict in `src/agents/shared/structured.ts`**, where this branch added the lenient
     JSON parse.
   - In that config the judge has no flash-lite fallback any more; on the free tier its Pro fallback returns 429.
2. Enable Gemini billing (or another provider) for a real Pro-class judge.
3. Create the non-admin test users (Read Only, Sales Rep) so that the BLOCKED deny cases can run.
4. Answer Q1–Q3 and resolve the four org conflicts (Email required, Phone required when Web, duplicate rule inactive,
   Title list) so those cases can become assertable.
5. The stale fixture server on port 4545 (PID 9904, started before Phase 2) is still running.
