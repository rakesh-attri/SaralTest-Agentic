# Investigation, healing, defect judging and exploration (Phase 7)

How the framework explains a failed test, repairs what is the test's own fault, decides whether the org is wrong, and
explores beyond the scripted cases. Everything here is evidence-ledgered, and anything that leaves the machine (a bug in
JIRA) or changes behaviour waits for a human.

## 1. Failure Investigator — `src/agents/failure-investigator/`

`qa investigate --run <id>` (or `qa run … --investigate`, graph node `investigate` after `execute`).

1. **Observe** (`signals.ts`). Deterministic facts are read from the stored failure detail (`TestResult.failure`:
   errors per attempt, failing `test.step`, spec line, error-context / trace / screenshot). The signals are:
   - locator not found / not unique;
   - assertion vs URL mismatch;
   - wait timeout;
   - 5xx, maintenance or login page (also read from the ARIA snapshot);
   - data setup failed;
   - insufficient access, validation error or duplicate rule;
   - passed on retry;
   - local environment (SQLite busy).
2. **Hypothesize** (`rules.ts` `hypothesesFor`): 3–5 competing causes across the taxonomy, never one.
3. **Experiment** (`experiments.ts`): a fixed catalog, cheapest first. Only reruns and the API reproduction write
   anything; they go through the guard, and their data is run-tagged and cleaned up.

   | Experiment | Question | Source |
   |---|---|---|
   | requirement-trace | Is the failing expectation stated by what it cites? | IR + test case + design sources (`context.ts`) |
   | identity / health probe | Right org and user? Org reachable? | `GuardedSalesforce` |
   | soql-ledger | Did the test's own data setup succeed? | `runs/<id>/data/<sha(testId#retry)>/writes.jsonl` |
   | snapshot-diff | Did a dependency change since the build? | manifest `dependsOn` vs latest snapshot / registry |
   | validation-rule / permission check | Which rules could reject it; does the persona have access? | snapshot / describe |
   | aria-locate | Is the element on the page under another name? | Playwright `error-context.md` (offline) |
   | rerun-extended-waits / rerun-fresh-data / flaky-reruns | Late? Reproducible? Non-deterministic? | Runner (`QA_WAIT_FACTOR`, `QA_RETRIES=0`) |
   | api-reproduce | Same behaviour through REST? | `reproducers.ts` (BR-08: open Case → DELETE Contact) |

4. **Conclude**. Deterministic rules decide first (`rules.ts`, first match wins):

   | Rule | Verdict |
   |---|---|
   | R-ENV-* | ENVIRONMENT |
   | R-PERM-1 | PERMISSION_CONFIG |
   | R-DATA-1 | TEST_DATA |
   | R-LOC-* | SCRIPT_LOCATOR (strong ARIA candidate only) |
   | R-FLAKY-3 | FLAKY (passed on retry and on unchanged reruns) |
   | R-TIME-1 | SCRIPT_TIMING (reproduces with normal waits, passes with longer ones) |
   | R-FLAKY-* | FLAKY |
   | R-STALE-1 | STALE_KNOWLEDGE |
   | R-REQ-1 | INVALID_REQUIREMENT_ASSUMPTION |
   | R-DEF-2 | PRODUCT_DEFECT (an expected state never appears) |
   | R-DEF-1 | PRODUCT_DEFECT (a stated value or navigation fails on fresh-data reruns) |

   - The reasoning model concludes only when no rule fires. It chooses among the hypotheses that are not refuted,
     must cite evidence ids that exist, and is capped at 0.75.
   - A verdict below `policy.investigation.minConfidence` (0.6) becomes UNKNOWN.
   - PRODUCT_DEFECT is never decided from a single UI failure.

Outputs: `runs/<inv>/investigation/{investigations.json, investigation-report.md}` and `runs/<inv>/evidence/evidence.json`.
The ledger itself is `.qa-memory/evidence.db` (`src/knowledge/evidenceLedger.ts`).

## 2. Self-Healer — `src/agents/self-healer/`

`qa heal --investigation <id> [--apply] [--approve-by "<name>"]`, `qa heal revert --repair <id>`, `qa heal list`.

- It heals only SCRIPT_LOCATOR and SCRIPT_TIMING. Any other verdict is refused.
- **Locator repair:**
  1. The registry row (`.qa-memory/locators.db`) gets the new accessible name. The old row is kept in
     `locator_history`.
  2. The member name is pinned (`memberName`), so `saveButton` stays `saveButton`.
  3. Page objects are regenerated.
  4. The spec's `Locator:` dependency hash is re-bound.
- **Wait repair:** a per-case factor in `tests/support/wait-overrides.json`. It is read by `tests/support/waits.ts`
  (helper waits) and by the `page` fixture (action, navigation and test timeouts).
- **Rule 7 proof (`fingerprint.ts`).** The TypeScript AST yields every `expect(...)` chain, every `expect*` helper and
  every oracle call; these are hashed together with the IR assertions.
  - The fingerprints before and after must be equal.
  - The page-object catalog must keep every member, and only the repaired one may change.
  - Otherwise the repair is REFUSED and reverted.
- **Verify:** the case is rerun with fresh data. A failed verification reverts the repair. A FIXTURE repair is
  verified and then reverted, so it never changes the live page objects.
- **Behaviour-changing repairs** (role changed, or a shorter or dissimilar name) wait for
  `behaviour-changing-locator-repairs` at L1/L2.
- Every repair and revert is audited and appended to `.qa-memory/heal/repairs.jsonl`. File backups in
  `.qa-memory/heal/<id>/` make a revert byte-exact.

## 3. Defect Judge — `src/agents/defect-judge/`

`qa defects judge --investigation <id>` · `show` · `approve --by` · `publish`.

1. **Gate** (`gate.ts`, the defect-investigation SKILL standard). All items must hold:
   - reproduced 2× with fresh data and the same persona;
   - reproduced through the API;
   - test data ruled out;
   - environment ruled out;
   - requirement traced to an assertable level;
   - every evidence id resolves;
   - the text is sanitized.
2. **Bug text** is rendered by code from the evidence. The title is proposed by a model and format-checked
   (`[Object] … when … for <persona>`).
3. **Judge model** (role `judge`, never the coder model) lists every claim the evidence does not support.
   - CONFIRMED only when the gate passed, the judge confirmed and no claim is unsupported.
   - DeepEval faithfulness is UNEVALUATED until Phase 8, so a human reviews the text.
4. **Publication** (`publish.ts`) is refused unless all of these hold:
   - the defect is LIVE and CONFIRMED;
   - there is a `publish-defect` approval bound to the text's sha256 (required at every autonomy level);
   - `policy.defectPublication` names a project and a field mapping.

   It posts through Rovo MCP `createJiraIssue` (`--mcp`) or JIRA REST. It is audited write-ahead and never posts the
   same text twice (`.qa-memory/publications.jsonl`).

## 4. Fault injection — `src/fixture/faults.ts`, `src/faults/suite.ts`

`qa fixture serve --faults <file>` and `qa faults run --suite examples/faults/fixture-suite.yaml` (FIXTURE only).

| Fault | Injection | Expected verdict |
|---|---|---|
| F1 | Save button renamed | SCRIPT_LOCATOR (+ heal) |
| F2 | toast 30 s late | SCRIPT_TIMING (+ heal) |
| F3 | BR-08 not enforced | PRODUCT_DEFECT |
| F4 | new Account rule the recipe violates | TEST_DATA |
| F5 | Lightning pages 503 | ENVIRONMENT |
| F6 | Account read-only | PERMISSION_CONFIG |
| F7 | Phone rule disabled | PRODUCT_DEFECT |

The scorecard (`runs/<id>/faults/scorecard.{md,json}`) passes at ≥ 80 % correct with 0 assertion changes.

## 5. Autonomous Explorer — `src/agents/autonomous-explorer/`

`qa explore --org <alias> [--charter contact-create] [--minutes 10] [--model]`, `qa explore list|promote`.

- **Charter.** One charter per run: mission, why this area (RTM rows without APPROVED coverage), and limits from
  `policy.exploration`: time box, steps, at most 5 guarded saves, saturation.
- **Approved action catalog** (`catalog.ts`). Only `save-attempt` mutates. It goes through `uiAttempt` (guarded and
  audited); anything created is adopted with the run tag and removed by the verified cleanup.
- **State map** (`stateMap.ts`) and **evidence-gain selection** (`select.ts`). The org-rule oracle (`oracle.ts`)
  predicts from declared config whether a Save must be rejected. The model may choose among the top candidates; the
  deterministic score is the default.
- **Stop conditions:** time box, max steps, saturation, error budget, off-domain navigation, or catalog done.
- **Findings** come from deterministic oddities: a rule not enforced, input truncation, a required-marker mismatch, an
  unexpected message, a console error (not a 4xx resource error).
- **From finding to test case** (`review.ts`):
  1. Code drafts a REVIEW_REQUIRED case and runs a deterministic review (question vs test, assertable or not, similar
     design cases).
  2. Only `qa explore promote --by "<name>"` turns it into a story case (`examples/case-edits/<story>-exploratory.yaml`).
  3. The promoted case is APPROVED only when every expectation is assertable.

## 6. Operator case edits for new cases — `src/inputs/caseEdits.ts`

`decisions`, `dataRecipe`, `approve` (only when every expectation is assertable), `addCases` (evidence must exist in the
design run, a recorded decision, or an org component id). `qa build --case-edits a.yaml,b.yaml`.

## 7. Independent check

`pnpm validate:investigation <runIds>` re-derives investigations, defects (sha, gate), heal fingerprints from the specs
on disk, fault scores and exploration limits (`scripts/validate-investigation.ts`).
