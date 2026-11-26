# Phase 5 notes: Execution & reporting

Branch `claude/phase-5-execution-reporting`, stacked on `claude/phase-4-generation-data` at `95eed9a` (PR #4, still open
when Phase 5 started). One commit per task (T1–T8) plus one per fix found in the live runs.

**Exit criterion (PLAN.md §11):** the Account → Contact demo (CLAUDE.md §Acceptance demo) passes end to end on the
offline fixture, then live on `dedicated-qa-prod` (qa-prod). The proof is under *Exit proof*; what "passes" means here
is stated there honestly: the pipeline runs end to end with every step recorded and verified, while 4 of the 7
executed SF-219 specs FAIL on a spec assumption that qa-prod does not meet.

**Operator decisions (2026-11-26):**
- execute only the APPROVED SF-219 specs from the current manifest (`run-p4-design-decided-1` → builds 8/9/10); no
  regeneration during the demo; **re-review only** for the held specs (no regeneration in Phase 5);
- JIRA comment: Rovo MCP first, REST fallback, approval checkpoint + audit on both paths, text shown first;
- recipe `account-contact@136f8241a8ee3c57` approved for qa-prod (`AP-fc20bc1739d9`, Rakesh Sharma);
- a persona that cannot read `Organization` (sales-rep) is identity-checked through its own userinfo; IsSandbox comes
  only from a full check of the same org ID in the same process.

## What was built

| Task | Result | Main files |
|---|---|---|
| T1 Contracts | `StoryManifest`, runner detail on `TestResult`, `ExecutionSummary`, `ReleaseConfidence`, `RunHistoryEntry`, `JiraCommentDraft`, `ObservedMessage` | `src/core/schemas/execution.ts`, `result.ts` |
| T2 Runner | gate → identity (HARD_STOP) → browser (fallback recorded) → persona sessions (base URL = landed host) → recipe approvals → `playwright test` → `results.json` → data reconciliation → summary; `execute` node + seeded entry; `qa run` | `src/runner/`, `src/cli/run.ts`, `src/graph/mainGraph.ts` |
| T3 Fixture parity | validation rules enforced (formula subset; unsupported formula fails loudly), qa-prod rule copies, Lead Source / Title, Lightning-like combobox, full Mailing Address, Contact edit dialog, field-level errors, cascade delete | `src/fixture/`, `examples/fixture/` |
| T4 Explorer | `contact-edit` page (observe only, record name aliased out); `qa locators observe-messages` (guarded + audited Save attempts, SOQL no-record proof, adopt + verified cleanup); pass 2 `message-unasserted` | `src/agents/app-explorer/`, `src/knowledge/observedMessages.ts`, `src/cli/observe.ts` |
| T5 sales-rep + re-reviews | low-privilege identity; per-persona dry-runs in `qa review --pass 2`; re-review keeps the manifest's file facts | `src/sf/identity.ts`, `src/sf/context.ts`, `src/cli/review2.ts`, `pass2.ts` |
| T6 Model errors | provider message + HTTP status per attempt; "Model attempts that failed" after every command; fallback answers named | `src/models/attemptLog.ts`, `structured.ts`, `guarded.ts` |
| T7 Reports | execution report (md + html), release confidence, cleanup / reconciliation, impact & coverage + `rtm-results.xlsx`, history, model attempts, index; reporting-labs links / env / labels; `qa report` | `src/report/`, `playwright.config.ts` |
| T8 JIRA comment | draft → approval bound to sha256 → publish (Rovo MCP v2 add mode, REST fallback), audited, never twice | `src/report/jiraComment.ts`, `src/cli/jiraComment.ts`, `config/policy.yaml`, `config/mcp-tools.yaml` |
| T9 Demo + validator | `pnpm validate:run`; fixture + live + Chrome runs; docs | `scripts/validate-run.ts`, this file |

Tests: **603 passing** in 59 files (Phase 4 ended at 553). `pnpm typecheck` and `pnpm lint` green after every task.

## How execution works (short)

1. **Gate** (`src/runner/gate.ts`): only APPROVED specs with a current dependency record execute. Staleness is
   re-checked only against the org the specs were **built for** (`manifest.org`): a fixture snapshot has other hashes
   and must never write STALE marks into the qa-prod manifest (also in `qa discover` / `qa build`).
2. **Preflight**: identity check (HARD_STOP ends the run BLOCKED), browser resolution (`--browser` > `QA_BROWSER` >
   `execution.yaml`; a missing channel falls back to `fallbackBrowser`, and every result records the fallback), a
   session per persona (the landed host becomes `SF_BASE_URL`), recipe approvals (missing → BLOCKED before any test,
   with the exact `qa data approve` line).
3. **Playwright Test runner** with `QA_*` env; Playwright JSON goes to `playwright-results.json`, normalised
   `TestResult[]` to `results.json`. Mapping: passed → PASS, failed / timedOut → FAIL, pass on retry → UNCERTAIN
   (flaky), interrupted → UNCERTAIN, skipped → SKIPPED, auth setup failed → BLOCKED, passed but data not clean →
   UNCERTAIN; gate rows that did not run are listed with their reason. Every row carries LIVE / FIXTURE.
4. **Data**: one data sub-run per test **attempt** (a retry must not reuse cleaned records); after the run every
   sub-run is cleaned again, a run-wide re-query by tag prefix must return 0, and records the run user created during
   the run **without** the run tag are reported (never deleted by the agent).
5. **Reports** from the run folder (`qa report --run` rebuilds them); JIRA comment only after approval.

## Live findings that changed the code

| # | Run | Finding | Fix |
|---|---|---|---|
| 1 | fx-try-1 | `--project` is variadic in Playwright and swallowed the spec names | spec filters first |
| 2 | fx-try-2 | a retry reused the cleaned data of the failed attempt | data sub-run per attempt |
| 3 | fx-try-2 | staleness check against the fixture would have marked every qa-prod spec STALE | re-check only for the build org |
| 4 | fx-try-4 | `data.ofLength(10)` gave hex: the "10-digit phone" had letters | digits below the run-prefix length (helper, no spec change) |
| 5 | observe-1 | the duplicate "message" was the Account page's own widget (page-wide text) | popovers read by their dialog name; wrong rows withdrawn |
| 6 | observe-3…6 | Lightning's save popover is its own modal dialog and hides the form from the accessibility tree; the help text lives in another shadow root | read popover → close → field (deep shadow search, ARIA-snapshot fallback) |
| 7 | review b8 | re-review dropped `dependsOn` and earlier judge findings from the manifest | re-review changes only reviewStatus / reasons / reviewedBy; judge findings carried over when the judge is down |
| 8 | review b8 | TC-004's length message was linked to the *required* text | observations matched by the kind the step expects |
| 9 | live-1 | a related-list Save **stays on the Account page**; the T3 fixture had been changed to navigate (from the specs' assumption, not an observation) | fixture reverted to live behaviour |
| 10 | live-1 | UI-created Contacts were not adopted (test failed first); only the Account cascade removed them | untagged-record check in reconciliation; fixture cascade delete |
| 11 | live-1/2 | the save popover hides the form for `expectFieldError` and the next fill; it can render after the field turns invalid | `closeSavePopover` with retry + short window (wait/navigation only) |
| 12 | live-3 | the docked form footer covers picklist options near the bottom of the modal | `selectPicklist` keyboard fallback (same value, same check) |
| 13 | live-data-1 | the negative variant copied the synthetic Email: the active duplicate rule fired first (`DUPLICATES_DETECTED`) | variants get their own synthetic values |
| 14 | live-4 | the AC summary lists one case per AC (AC coverage 0/7 while AC5 passed) | AC coverage from the RTM |

No assertion, expected value or step of a generated spec was changed. Fixes 4, 11 and 12 are in test-support code
(`tests/fixtures`, `tests/support/lightning.ts`) and touch values / waits / navigation only.

## Exit proof

### Offline fixture — `run-p5-fixture-4` (FIXTURE)

```powershell
pnpm qa fixture serve --port 4545
pnpm qa run --story SF-219 --org fixture --autonomy L3 --run-id run-p5-fixture-4
pnpm validate:run run-p5-fixture-4
```

- Gate: 7 EXECUTE · 11 NOT_APPROVED · 2 MANUAL (staleness tracked against qa-prod, not re-checked on the fixture).
- **3 PASS** (TC-008, 009, 015) · **4 FAIL** (TC-007, 010, 026, 036 — after Save the page stays on the Account; the
  specs expect the new Contact's page) — identical to live.
- Data CLEAN: 11 sub-runs, re-query 0, 0 untagged. `validate:run` → **valid**.
- L3 on the fixture: no recipe checkpoint wait (FIXTURE only; live ran at L2 with the approval).

### Live qa-prod, chromium — `run-p5-live-4` (LIVE)

```powershell
pnpm qa run --story SF-219 --org qa-prod --run-id run-p5-live-4
pnpm validate:run run-p5-live-4
```

- Identity `00DdN00000uQ5dKUAS` as the system-admin persona; recipe approval `AP-fc20bc1739d9`.
- **3 PASS** (TC-008 Lead Source Web + blank Phone rejected with "Phone is required when Lead Source is Web.";
  TC-009 invalid phone rejected with "Phone must be exactly 10 digits."; TC-015 unapproved Title rejected) ·
  **4 FAIL** (same as the fixture).
- Data CLEAN: 11 sub-runs (Accounts + UI-created Contacts adopted where the test got that far), re-query 0, 0 untagged;
  audit 26 ALLOWED = 26 SUCCEEDED, 0 REFUSED. `validate:run` → **valid**.
- Verdict (release confidence): **Not ready** — 4 failures not investigated yet; AC with a passing test 1/7.

### Account → Contact with `Contact.AccountId` by SOQL — `run-p5-live-data-2` (LIVE)

None of the 7 executed specs asserts `Contact.AccountId` (TC-032 does, and it is BLOCKED — below), so the data cycle
proves it: Account → Contact created, read back by SOQL, **`Contact.AccountId` = the new Account**, negative
`missing-last-name` rejected with `REQUIRED_FIELD_MISSING`, cleanup CLEAN (re-query 0). `pnpm validate:data
run-p5-live-data-2` → all data outputs valid.

### Chrome — `run-p5-live-chrome-1` / `-2` (LIVE)

- `--browser chrome` resolves the installed Chrome channel; every result records `browser=chrome`.
- chrome-1 (TC-015 + TC-026 in parallel): both FAIL — the New Contact modal content did not render within 15 s (cold
  start; overlay shown, content empty) on both attempts.
- chrome-2 (TC-015 alone): **PASS** on Chrome; data CLEAN; `validate:run` → valid.

### Explorer and reviews

- Contact edit form (live): 36 locators, root `getByRole('dialog', { name: /^Edit / })`, no record name stored;
  dry-run 36/36; `ContactEditForm` page object.
- Observed messages (`run-p5-observe-8`, LIVE, guarded + audited, seeds cleaned, re-query 0):
  - required Last Name: field "Complete this field." + page "We hit a snag. Review the following fields Name"; no record;
  - invalid email: field "Enter a valid email address, such as <EMAIL_2>." (the example address is masked by the
    redactor) + the snag popover; no record;
  - 81-character Last Name: **no message** — the input keeps 80 characters and Save creates the record (adopted,
    deleted). This contradicts TC-004's expectation (an error at 81);
  - duplicate email: "Similar Records Exist — This record looks like an existing record. Make sure to check any
    potential duplicate records before saving. View Duplicates"; Save held, no record.
- Re-reviews (no regeneration; the build-8 judge timed out → deterministic only, earlier judge findings carried):
  - TC-004: `message-unevidenced` (no length message exists on qa-prod);
  - TC-046, TC-050: `message-unasserted` — the text is now evidenced, the spec does not assert it → human acceptance
    + regeneration;
  - TC-032, 044, 047, 048: **BLOCKED** — as sales-rep, `sObject type 'Contact' is not supported` (the user has no
    Contact access on qa-prod).
- SF-219 manifest now: 7 APPROVED, 7 REVIEW_REQUIRED, 4 BLOCKED, 2 manual-only.

### Models (exact errors, `runs/run-p5-coder-probe-1/probe.txt`)

- NVIDIA NIM `poolside/laguna-xs-2.1`: reachable; JSON mode, strict schema and tools work; the real TC-007 prompt
  returns an IR that breaks the contract (`steps.1.actions.0.value.kind: Invalid discriminator value`).
- Groq `openai/gpt-oss-120b`: `json_object` / `json_schema` → `HTTP 400: json_validate_failed`; text mode → valid IR
  with 2 deterministic problems; then `HTTP 429: rate_limit_exceeded … on_demand … TPM: Limit 8000`.
- Judge chain in the re-reviews: `nvidia-nim/nvidia/nemotron-3-ultra-550b-a55b` and `nvidia-nim/stepfun-ai/step-5-preview`
  both "judge model call timed out after 120000 ms" (printed by every command in "Model attempts that failed").

### JIRA comment

Drafted for `run-p5-live-4` (`runs/run-p5-live-4/report/jira-comment.md`, sha256 `8409a6da…`), shown to the operator,
approved in chat and recorded as `AP-ced0698c5f74` (Rakesh Sharma). **Posted to SF-219 as comment 10068** via JIRA
REST: the Rovo MCP v2 path was tried first and refused by Atlassian ("Cloud id … isn't explicitly granted by the
user" — the MCP OAuth consent does not include this Jira site). Audit: MCP ALLOWED → FAILED, REST ALLOWED →
SUCCEEDED, all under the approval; `.qa-memory/publications.jsonl` records it. Read back (HTTP 200): the full text is
on the issue; the REST fallback posts plain text (no bold).

## Not verified / known limits

- **4 of 7 executed specs FAIL on qa-prod** for one observed reason (stay on the Account after a related-list Save).
  Not investigated or classified (Phase 7); fixing them needs regeneration (out of Phase 5 scope).
- Chrome cold start: the first Chrome run timed out on the modal; the second passed. Not reproduced further.
- The sales-rep persona cannot run anything until the admin grants Contact access.
- Observed-message texts need a human acceptance before specs assert them (PLAN §7f: OBSERVED needs review).
- Acceptance-demo items owned by later phases: visual results (Phase 6), failure investigation (Phase 7), verified
  learnings (Phase 8) — not in Phase 5.
- Generator `openEdit` IR action (to regenerate TC-012 / TC-045 on the edit form) is a follow-up.

## Open items for the operator

1. Rovo MCP: re-consent so the OAuth grant includes the Jira site (the comment went through REST).
2. Salesforce admin: give the sales-rep test user Contact (and Account) access through a permission set.
3. Decide on the four "stays on the Account" failures: is "the Contact detail page opens after Save" a requirement
   (→ product behaviour differs) or an assumption (→ regenerate the specs)?
4. Accept the observed texts for TC-046 / TC-048 / TC-050 so they can be regenerated with text assertions; TC-004's
   81-character expectation contradicts qa-prod's UI (input truncates).
