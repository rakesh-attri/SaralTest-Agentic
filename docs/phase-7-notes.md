# Phase 7 notes: Investigation, healing, exploration

Branch `claude/phase-7-investigation`, from `main` at `b337d90`. One commit per task (T0–T9), plus one commit per fix
found in the fixture and live runs. How everything works: `docs/defect-investigation-guide.md`.

**Exit criteria (PLAN.md §11).** All three are met.

| Criterion | Status | Proof |
|---|---|---|
| Faults classified ≥ 4/5 correctly | met | Fixture `flt-p7-fx-5`: **7/7**, 0 assertion changes. Live: L1 locator, L2 test data and the injected Phone defect were all classified correctly |
| No assertion changed by the healer | met | Every applied repair has equal fingerprints. `pnpm validate:investigation` re-derives them from the specs on disk |
| Explorer finding → reviewed test case | met | The operator promoted `XF-explore-p7-fx-3-1` → **TC-SF-219-055**: pass 2 APPROVED, PASS on the fixture and live |

**Scope (operator, 2026-11-27 / 28).**
- BR-08 as the real-defect demo.
- Fault injection: fixture first, then live faults made by the operator in Setup.
- One read-mostly Contact-creation charter with at most 5 guarded saves.
- Decisions:
  - Case records are run-tagged (`QA_Run_Id__c` on Case was created by the admin).
  - TC-031 gets a positive counterpart.
  - Bugs go to JIRA project SF as type Bug, but only after the operator approves the exact text.

## What was built

| Task | Result | Main files |
|---|---|---|
| T1 Contracts | Investigation (signals, experiments, verdictBy, route), DefectDraft (judge-standard fields, gate, sha), HealRepair (fingerprints, revert), fault suite / scorecard, exploration contracts. Policy: `investigation:`, charter limits, checkpoint `publish-defect` at L1/L2/L3. Evidence ledger `.qa-memory/evidence.db` + per-run export | `src/core/schemas/investigation.ts`, `exploration.ts`, `src/knowledge/evidenceLedger.ts` |
| T2 Failure capture | Errors per attempt, spec line, failing `test.step`, error-context / trace / screenshot (from the failed attempt), deterministic signals | `src/runner/results.ts`, `src/agents/failure-investigator/signals.ts` |
| T3 Investigator | 3–5 hypotheses, experiment catalog (cheapest first), deterministic rules first, model only within open hypotheses, UNKNOWN below 0.6. `qa investigate` | `src/agents/failure-investigator/` |
| T4 Self-Healer | Locator repairs through the registry (member names pinned, page objects regenerated) and per-case wait factors. TypeScript-AST assertion fingerprint + catalog scope check. Verify by rerun; a FIXTURE repair is reverted afterwards; byte-exact revert. `qa heal` | `src/agents/self-healer/` |
| T5 Fixture + faults | Case object, Contact delete flow, `--faults` (labels, delays, rules, 503, read-only). `qa faults run` | `src/fixture/faults.ts`, `src/faults/suite.ts`, `examples/faults/fixture-suite.yaml` |
| T6 BR-08 | Delete Contact dialog explored (fixture 2, qa-prod 3 locators); Case recipes. Case edits gain `decisions`, `dataRecipe`, `approve`, `addCases`. Generator gains `recordExists` and the Delete-dialog transition | `examples/case-edits/SF-219.yaml`, `src/inputs/caseEdits.ts` |
| T7 Defect Judge | Gate, bug text by code, title model, judge model (≠ coder), publication guarded by approval + policy. `qa defects judge/show/approve/publish` | `src/agents/defect-judge/` |
| T8 Explorer | Charter, approved catalog, state map, evidence-gain selection, org-rule oracle, guarded saves, findings → draft cases → review → human promotion. `qa explore` | `src/agents/autonomous-explorer/` |
| T9 Wiring | Graph `execute → investigate → report`, `qa run --investigate`, report links, `/why`, `pnpm validate:investigation` | `src/graph/investigateNode.ts`, `scripts/validate-investigation.ts` |

Tests: **718 passing** (the phase started at 664). `typecheck` and `lint` are green.

## Proof — offline fixture (FIXTURE)

The fault suite is `pnpm qa faults run --suite examples/faults/fixture-suite.yaml`.

| Run | Result |
|---|---|
| flt-p7-fx-1 (6 faults) | 6/6 correct. F1 and F2 healed: verified, then reverted (`tests/` unchanged) |
| flt-p7-fx-3 (7 faults) | 6/7. F7 was UNKNOWN: one rerun failed in the same step with a different message → "same failure" now means same line **or** same step |
| **flt-p7-fx-5** (final, current code) | **7/7** correct, 0 assertion changes; validator ✓ |
| run-p7-fx-br08-1 | TC-031 FAIL → PRODUCT_DEFECT 0.90 (R-DEF-1, API reproduced) → judge CONFIRMED [FIXTURE]. TC-054 and TC-055 PASS |
| explore-p7-fx-3 | 60 steps, 45 states, 5/5 saves, data CLEAN. Finding: "Last Name input keeps 80 characters" → promoted by the operator (AP-4fa4689f86fd) → TC-SF-219-055 |

## Proof — live qa-prod (LIVE, org 00DdN00000uQ5dKUAS)

| Run | What happened |
|---|---|
| inv-p7-offline-3 | The 4 Phase 5 failures of run-p5-live-4 → INVALID_REQUIREMENT_ASSUMPTION (0.75): each expects the Contact page to open after Save, and none of the cited ACs / BRs says so. Run offline, because the specs have changed since |
| run-p7-live-1 | 8 PASS, TC-026 flaky. It was first called SCRIPT_TIMING, which was **wrong**, and its live wait repair was reverted. After the fix (R-FLAKY-3) the re-investigation `inv-p7-live-1b` → FLAKY |
| run-p7-live-br08-1 | **BR-08 holds on qa-prod.** Salesforce refuses to delete a Contact with *any* Case ("could not be completed because it is associated with the following cases"). TC-031 behaved as required (first attempt flaky on step 3). TC-054 (closed Case → deletable) was contradicted → `inv-p7-live-br08-1b`: INVALID_REQUIREMENT_ASSUMPTION (0.80, new rule R-REQ-2). No bug |
| run-p7-live-054b | Operator revised P7-BR08-POS (a Contact without any Case is deletable) → TC-054 rebuilt → **PASS** |
| run-p7-live-l1 + heal-p7-live-l1-5 | **L1**: the operator renamed Title → "Job Title". SCRIPT_LOCATOR (R-LOC-1). A chain of 2 repairs ("Title", then "Edit Title") was VERIFIED by a passing rerun; fingerprint `c0a660912e` before and after. Reverted after the operator restored the label; run-p7-live-l1-after: TC-036 PASS |
| explore-p7-live-2 | 60 steps, 36 states, 5/5 guarded saves, data CLEAN. Findings: (1) **rule not enforced: Phone accepted "abcdefghij"** — the operator had switched the rule off for the defect demo (Tooling: inactive since 04:28 UTC); (2) Last Name truncation (same as TC-055); (3) two Salesforce-owned console messages. None promoted |
| run-p7-live-def-1 | **Injected defect** (Phone rule off): TC-010 → PRODUCT_DEFECT 0.90 (R-DEF-2, API reproduced) → **DEF-SF-219-010-7fe4c4 CONFIRMED** (judge `nvidia-nim/nemotron-3-ultra`). Text shown to the operator; **not posted** (operator: injected defect) |
| run-p7-live-l2 | **L2**: the operator added Account rule `QA_Fault_Phone_Required` → TEST_DATA 0.90 (R-DATA-1). Rule removed afterwards |

Every live run: data CLEAN (re-query 0) and identity verified. The validator ✓ on every Phase 7 run folder listed above.

## Findings that changed the code

| # | Run | Finding | Fix |
|---|---|---|---|
| 1 | inv-p7-offline-1 | "an error **is shown**" was read as a navigation statement | Navigation words only; config evidence (rules, org checks) never states navigation |
| 2 | run-p7-fx-base-2 | TC-036's ARIA match "Edit Title" → "Edit" (0.50) was called a rename | Only strong candidates (old name contained, or ≥ 2/3 of the words) count; shorter names are behaviour-changing |
| 3 | run-p7-fx-base-2 | "database is locked" (parallel workers) | SQLite busy timeout everywhere; LOCAL_ENVIRONMENT signal |
| 4 | fault dry-run | A late toast reads as `not.toHaveCount … Received: 0`; a 503 page has no 503 in the error | "Never appeared" = element absent; maintenance / login read from the ARIA snapshot; new rule R-DEF-2 |
| 5 | explore-p7-fx-1/2 | Console 4xx noise; Escape left the dialog open; the promoted id collided with TC-054 | 4xx resource errors ignored; state reset only on a real close; promotion skips ids used in case edits |
| 6 | run-p7-live-1 | Flaky test "healed" with a wait factor on LIVE | R-FLAKY-3; R-TIME-1 needs a reproduction with normal waits; repair reverted |
| 7 | run-p7-live-br08-1 | Platform refusal of the action under test; investigator ignored operator-added cases; fixture allowed the delete | PLATFORM_CONSTRAINT signal + R-REQ-2; cases from case edits; fixture blocks the delete by default (F3 = allowed) |
| 8 | run-p7-live-l1 | One rename touched two locators; derived `titleField`; 2/3 similarity missed at 0.67 | Chained repairs (≤ maxAttemptsPerTest, incomplete chain reverted); derived members keep pinned names; threshold exactly 2/3 |
| 9 | run-p7-live-def-1 | Judge refused (run budget 1 token); bug quoted raw design wording | `--investigate` gets a 400k budget; bugs use the case as built (operator edits + wording refresh); "Actual" in words |
| 10 | explore-p7-live-1 | Lightning's "snag" popover is a dialog too → "dialog closed" after every Save | Form dialog = the New Contact dialog with a Save button |
| 11 | run-p7-fx-br08-1 | A record id in a SOQL line of the bug; the sanitize gate stopped it | Evidence-derived bug text is redacted first; the gate still checks the final text |
| 12 | run-p7-live-054 | IR asked for the Contact data step without its parent | Render creates the parents of requested data steps |

## Open items and known limits

- **TC-010 after the Setup reverts:** confirmed. `run-p7-live-after-4` PASS, data CLEAN (the earlier tries
  `run-p7-live-after(-2/-3)` were blocked by a lost network on this machine).
- **Live Explorer findings (explore-p7-live-2), operator review 2026-11-28:**
  - `-3` (rule not enforced) **rejected**: caused by the staged Phone rule switch-off.
  - `-2` (truncation) **rejected**: duplicate of TC-055.
  - `-1` / `-4` (console messages) await a decision. They are questions, so they cannot be promoted as tests as they
    stand.
  - `qa explore reject` records the name and reason on the finding.
- **TC-031 live:** the first attempt is flaky on step 3 (record header after the refusal dialog). The verdict was FLAKY → quarantine; not changed.
- **A live heal of a shared locator** marks the other specs that use it STALE. That is correct, since they must be re-verified; the revert restores the manifest.
- **DeepEval faithfulness** is UNEVALUATED until Phase 8; a human reviews every bug text.
- **Rovo MCP `createJiraIssue`** is untested live (nothing was posted). The REST publish path is unit-tested.
- **The model conclusion path** (no rule decided) was rarely reached; the verdicts above are rule-decided.
- `validation-rule-check` sees only rules in the latest snapshot (L2's new Account rule appeared only in the error text).
- The judge ran on the NIM reasoning model (`nemotron-3-ultra`), which differs from the coder model (rule 8). A Pro judge is still blocked by billing.
