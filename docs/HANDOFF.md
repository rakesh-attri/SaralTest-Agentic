# HANDOFF — sf-qa-agent project state (written 2026-11-27)

Written so that another coding agent (Codex, OpenCode, …) or a human can continue the work without the Claude Code
history. Read `AGENTS.md` first for the rules, commands and repo map. This file covers **state**: where the code is,
what is done, what is half-done, what waits on whom, and how to resume.

---

## 1. Where the code is (branches) — read this first

GitHub: `https://github.com/rakesh-attri/SaralTest-Agentic` (`origin`). Main checkout: `C:\Projects\SaralTest-Agentic`.

| Branch | State | On GitHub? |
|---|---|---|
| `main` | Phases 0–6 merged (PR #6 merged at `b337d90`) | yes |
| `claude/phase-6-visual-qa` | Phase 6 (merged into main) | yes |
| **`claude/phase-7-investigation`** | **Phase 7 in progress: T0–T4 committed (`73a87a2` … `71e1b2c`), stacked on main** | **NO, local only** |
| `claude/project-documentation-handoff-c57ba0` | this handoff (`AGENTS.md`, `docs/HANDOFF.md`) on top of main | push it |
| `claude/phase-1/3/4/5-*`, `phase-0-foundation`, `backup/pre-phase-4-local`, `claude/phase-6-r1-baseline-91b6ed`, `claude/new-session-bd5fa6` | historical (merged or superseded) | some |
| `tooling/graphify` | operator's code-graph tool (`graphify-out/` is untracked in the main checkout) | yes |

> ⚠️ **Uncommitted Phase 7 work (T5 fault injection) exists only in the main checkout's working tree**
> (`C:\Projects\SaralTest-Agentic`, branch `claude/phase-7-investigation`). On 2026-11-27 about 22:19 a Claude session
> was still running `qa faults run … --run-id flt-p7-fx-1` there. Files:
> - **new:** `src/faults/suite.ts`, `src/faults/suite.test.ts`, `src/cli/faults.ts`, `src/fixture/faults.ts`,
>   `src/fixture/faults.test.ts`, `examples/faults/fixture-suite.yaml`;
> - **modified:** the fixture (`examples/fixture/pages/contact-record.html`, `seed.json`, `static/record-page.js`,
>   `src/fixture/server.ts`, `store.ts`), the failure-investigator (`context`, `experiments`, `index`, `providers`,
>   `rules`, `signals`), `self-healer/index.ts`, `src/cli/index.ts`, `src/core/schemas/investigation.ts`;
> - **one-line busy timeout** `new DatabaseSync(file, { timeout: 10_000 })` added in 7 SQLite stores. This fixed
>   "database is locked" with parallel workers (run-p7-fx-base-2).
>
> **Do this first:** commit the WIP on `claude/phase-7-investigation` (for example "Phase 7 T5 (WIP): fault-injection
> suite …"), then `git push -u origin claude/phase-7-investigation`. Do not commit `graphify-out/` unless the operator
> wants it.

---

## 2. Phase status

| Phase | Status | Proof (run ids under `runs/`) | Notes |
|---|---|---|---|
| 0 Foundation | done | `qa doctor` | `docs/phase-0-notes.md` |
| 1 Inputs & clarification | done | JIRA SF-219 + Contact BRD PDF | `docs/phase-1-notes.md` |
| 2 Salesforce intelligence | done (live qa-prod) | changed VR detected → RE_VERIFY | `docs/phase-2-notes.md` |
| 3 Test planning | done | `run-p3-live-5`, `run-p3-live-7`, `run-p3-fixture-3` | `docs/phase-3-notes.md` |
| pre-4 Model providers | done | NIM + Groq failover | `docs/pre-phase-4-notes.md` |
| 4 Generation & data | done | `run-p4-live-1`, `run-p4-live-data-1`, `run-p4-build-decided-8` | `docs/phase-4-notes.md` |
| 5 Execution & reporting | done | `run-p5-fixture-4`, `run-p5-live-4`, `run-p5-live-chrome-2`, `run-p5-live-data-2` | 3 PASS / 4 FAIL on both. The 4 FAILs are a spec assumption (see §6) |
| 6 Visual QA | done (fixture exit + live desktop); tablet deferred | `run-p6-fixture-9→10`, `run-p6-live-3/9/11/14/15` | `docs/phase-6-notes.md`; open items §6 |
| **7 Investigation, healing, exploration** | **in progress** | `inv-p7-fx-base-*`, `flt-p7-fx-1` | §4 below |
| 8 Verified learning & eval | not started | — | PLAN.md §9, §11 |
| 9 CI/CD & full CLI | not started (templates in `ci/`) | — | |
| 10 Enterprise hardening | not started | — | |

Unit tests: 652 passing at the end of Phase 6 (`pnpm test`). Phase 7 added more. Typecheck and lint were green at
every commit.

---

## 3. Machine-local state (git-ignored, exists only on the operator's PC)

| Path | Holds | If lost |
|---|---|---|
| `config/models.yaml` | real model ids per role (see §5) | copy `models.example.yaml`, pick ids from `pnpm qa doctor` |
| `config/orgs.yaml` | fixture + **qa-prod** (org ID `00DdN00000uQ5dKUAS`, `dedicated-qa-prod`, release Winter '27, `runTagField: QA_Run_Id__c`) + `fc-admin` placeholder | rebuild from `orgs.example.yaml` |
| `config/personas.yaml` | `system-admin` (default), `sales-rep` (Limited Access User: no Contact access yet) | from example |
| `config/execution.yaml` | browser chromium, `visual.viewports: [desktop]` | from example |
| `config/observability.yaml` | Langfuse on, Phoenix off | from example |
| `.env` | API keys (Google, NVIDIA, Groq, JIRA, Langfuse), `SF_ECA_CLIENT_ID`, `SF_JWT_KEY_PATH` | secrets: ask the operator. Never print them |
| `.mcp.json` | salesforce / playwright / atlassian-rovo servers | from `.mcp.example.json` |
| `.auth/<org>/<persona>.json` | Playwright storage states (frontdoor) | regenerated by `qa auth login` / `qa run` |
| `.qa-memory/` | `knowledge.db` (snapshots), `graph.db`, `rag/` (LanceDB), checkpoints, `approvals.jsonl`, `evidence.db` (Phase 7), `heal/repairs.jsonl` | rebuild via `qa discover`, `qa ingest`; **approvals cannot be rebuilt**, so back this folder up |
| `runs/<runId>/` | every run's outputs, reports, audit.jsonl, logs | proof history: back it up |
| JWT private key `server.key` | outside the repo; path in `SF_JWT_KEY_PATH` / Credential Manager | ECA cert `CN=SaralTest-QA`, expires **2027-11-20** |

Recorded approvals that are still in use:
- recipe `account-contact@136f8241a8ee3c57` for qa-prod, `AP-fc20bc1739d9`;
- visual baselines qa-prod: `AP-ad178d5f7b56` (R1), `AP-c4cadc1d966c` (account-record), `AP-176058e3a085`
  (dialog + contact-details).

---

## 4. Phase 7 — details and how to resume

**Goal (PLAN.md §11):**
- Failure Investigator (full taxonomy);
- Self-Healer (AST check that assertions are unchanged; repairs auditable and reversible);
- Defect Judge, evidence ledger, defect reports;
- Autonomous Explorer;
- fault-injection suite.

**Exit:**
- faults classified correctly in at least 4 of 5;
- no assertion changed by the healer;
- an Explorer finding becomes a reviewed test case.

### Done (committed on `claude/phase-7-investigation`)

| Task | Commit | What |
|---|---|---|
| T0 | `73a87a2` | PLAN Phase 6 status updated |
| T1 | `065d62a` | Contracts: investigation, defect, healing, fault and exploration (`src/core/schemas/investigation.ts`, `exploration.ts`). Policy: `investigation:` (reproductions 2, flakyReruns 3, minConfidence 0.6, extendedWaitFactor 3), the `publish-defect` checkpoint at L1/L2/L3 and charter limits. Evidence ledger: `src/knowledge/evidenceLedger.ts` → `.qa-memory/evidence.db` + per-run export |
| T2 | `f68c3b3` | The runner keeps failure detail: per-attempt errors, spec line, failed step, error-context / trace / screenshot. Deterministic failure signals |
| T3 | `d3636a1` | Failure Investigator (`src/agents/failure-investigator/`): signals → 3–5 competing hypotheses → experiment catalog (requirement trace, probes, data ledger, snapshot diff, validation rules, permissions, ARIA locate, reruns, flaky reruns, API reproduction). Deterministic verdict rules come first; the model may only choose within the open hypotheses; below 0.6 the verdict is UNKNOWN. `qa investigate`. Env `QA_WAIT_FACTOR` / `QA_RETRIES` for reruns |
| T4 | `71e1b2c` | Self-Healer (`src/agents/self-healer/`): locator repairs through the registry and per-case wait factors. An assertion fingerprint (TS AST) must be equal before and after, or the repair is refused. Verify by rerun and revert on failure; FIXTURE repairs are verified, then reverted. Behaviour-changing repairs wait for approval at L1/L2. Byte-exact revert. `qa heal`, `qa heal revert`, `qa heal list` |

### In progress (uncommitted, see the warning in §1)

**T5, fault-injection suite.** `examples/faults/fixture-suite.yaml` has 7 faults on approved SF-219 specs (TC-007,
TC-010, TC-031):
- F1 label rename → SCRIPT_LOCATOR (heal);
- F2 late toast → SCRIPT_TIMING (heal);
- F3 BR-08 not enforced → PRODUCT_DEFECT;
- F4 new Account rule → TEST_DATA;
- F5 Lightning 503 → ENVIRONMENT;
- F6 Account read-only → PERMISSION_CONFIG;
- F7 Phone rule off → PRODUCT_DEFECT.

For each fault, `qa faults run` does this:
1. Start the fixture with the fault (`src/fixture/faults.ts`).
2. Run the case.
3. Run `investigate`.
4. Run `heal` for script faults.
5. Score expected vs actual verdict, and count applied repairs that changed an assertion (must be 0).

The scorecard goes to the run folder. Fixture only: the command refuses any non-FIXTURE org.

```powershell
pnpm qa faults run --suite examples/faults/fixture-suite.yaml --no-model --run-id flt-p7-fx-<n>
pnpm qa faults run --suite examples/faults/fixture-suite.yaml --only F1-label-rename,F2-late-toast
```

Note: running `pnpm qa faults run --help` in the main checkout hung without output on 2026-11-27 (it was not
investigated; possibly the import of the fixture/runner modules keeps the process alive). Use `--only` for short
runs.

**Next steps to finish Phase 7:**
1. Commit and push T5. Make `pnpm typecheck`, `pnpm lint` and `pnpm test` green. Check the `flt-p7-fx-1` scorecard:
   the target is at least 4/5 correct and 0 assertion changes.
2. **Defect Judge + defect reports** (`src/agents/defect-judge/` per the PLAN.md §3 pattern):
   - judge role, which must not be the coder model;
   - `policy.investigation.reproductions` = 2 fresh-data reproductions (+1 via API when possible) before CONFIRMED;
   - a defect draft with evidence from the ledger;
   - publishing to JIRA only through the `publish-defect` checkpoint with a human approval, and only if
     `defectPublication.enabled` (currently false).
   - Read `.claude/skills/defect-investigation/SKILL.md`.
3. **Autonomous Explorer** (`qa explore`, now a stub in `src/cli/index.ts`):
   - visited/unvisited state map;
   - evidence-gain step selection;
   - approved actions only;
   - stop conditions (`policy.exploration`: 20 min, 3 charters);
   - findings → Test Planner → Test Reviewer → reviewed test case.
   - Read `.claude/skills/exploratory-testing/SKILL.md`. Use the Playwright MCP allow-list.
4. Wire `investigate → heal → execute (max 3) | judge → file_bug` into the main graph (`src/graph/mainGraph.ts`). The
   QA Lead triage currently records these responses as `report-only`.
5. Exploration and defect reports in `src/report/`, linked from the run index.
6. Fixture proof first. Then, only if the operator agrees, live: investigate the 4 SF-219 FAILs of `run-p5-live-4`
   (expected verdict INVALID_REQUIREMENT_ASSUMPTION or similar; see §6).
7. Phase close-out: `docs/phase-7-notes.md`, capability matrix, requirements registry, PLAN.md ticks, PR to `main`.

---

## 5. Models and external services (configured on this machine)

| Role | Primary | Fallbacks |
|---|---|---|
| reasoning | NVIDIA NIM `nvidia/nemotron-3-ultra-550b-a55b` | Gemini flash-lite |
| coder | NIM `poolside/laguna-xs-2.1` (`responseFormat: json_object`) | Groq `openai/gpt-oss-120b` → Gemini `gemini-3.5-flash-lite` |
| fast | Groq `openai/gpt-oss-20b` | Gemini flash-lite |
| judge | NIM `minimaxai/minimax-m3.1-flash` | `gemini-3.1-flash-lite` |
| embeddings | Google `gemini-embedding-2` | — |

- Google is on the **free tier**: there is no Pro model (the 404/429 errors come from quota 0), and about 60 embedded
  chunks per minute.
- Groq on_demand allows only 8k TPM, which is too small for the generator.
- Any role can be switched to Anthropic, OpenAI, Azure OpenAI, Ollama or any OpenAI-compatible endpoint in
  `config/models.yaml`. Check the result with `pnpm qa doctor --live`.

Other services:
- **JIRA** project SF on Atlassian Cloud. The demo story is **SF-219**. Reading uses REST (`JIRA_*` env).
  - The Rovo MCP consent does not grant the site's cloud id, so the run comment went via REST (comment 10068).
- **Langfuse Cloud** (Hobby) gets the traces.
- **Salesforce CLI** alias for qa-prod is set by `sf org login jwt`. API sessions use an in-process JWT grant,
  because sf CLI 2.159 redacts tokens.

---

## 6. Open items waiting on a human (operator = Rakesh)

| Item | Who | Unblocks |
|---|---|---|
| 4 SF-219 specs (TC-007/010/026/036) expect the Contact page after a related-list Save; qa-prod stays on the Account. Requirement or assumption? | product owner + operator | those 4 tests; good live input for Phase 7 investigation |
| Accept the observed message texts in `runs/run-p5-observe-8/observe/observed-messages.md`, then `qa build --cases …` | operator | text assertions in TC-046/048/050 |
| sales-rep user needs Contact (+ Account) read/create permission set on qa-prod | SF admin | TC-032/044/047/048 (BLOCKED) |
| Dedicated non-admin test users (read-only) pre-approved on the ECA | SF admin | persona deny cases (BLOCKED-NO-PERSONA) |
| Google billing (Pro judge, Full Copy data in prompts) | Rakesh | Pro-class Reviewer / Defect Judge |
| Full Copy sandbox `fc-admin`: real org ID/URL in `orgs.yaml`, fresh JWT login | Rakesh / admin | Phase 10 demo on the sandbox |
| Rovo MCP: re-consent and grant the Jira site | Rakesh | JIRA via MCP instead of REST |
| Digital Experiences not enabled in qa-prod | SF admin | Experience Cloud explorer / visual |
| Phase 6 leftovers: account-record header strip varies (0.091 %, `run-p6-live-15`), so mask it like the Activity panel and re-approve; intermittent dialog Address shift; 2 Salesforce-owned dialog a11y rules not accepted (`aria-prohibited-attr`, `sf-section-tab-order-not-applied`) | operator | clean 3/3 MATCH on qa-prod |
| Tablet viewport deferred: the "Account Name" label is hidden on account-record-tablet (cause unknown, 5 attempts listed in phase-6-notes). Re-enable with `visual.viewports: [desktop, tablet]` | later | tablet visual QA |
| Q1–Q3 of SF-219 assumed; 4 org conflicts (Email/Phone required, duplicate rule inactive, Title list) | product owner + admin | assertable cases for AC3–AC5 |
| Record types in recipes (no RecordTypeId in discovery yet) | dev (us) | recipes with record types |
| Edit-form generation needs an `openEdit` IR action | dev (us) | TC-012 / TC-045 |
| ADO org + PAT | Rakesh (optional) | Azure DevOps input |

---

## 7. Common workflows (copy-paste, PowerShell)

Everything below is safe on the **fixture**. Live (`--org qa-prod`) creates and deletes real records (run-tagged,
verified cleanup), so run it only when the operator asks.

```powershell
# health
pnpm qa doctor --offline
pnpm typecheck; pnpm lint; pnpm test

# offline fixture (keep running in its own terminal)
pnpm qa fixture serve --port 4545

# analysis → design → build, offline (design needs a stored snapshot of the org: discover first)
pnpm qa discover --org fixture
pnpm qa analyze --file examples/stories/account-contact.md --offline --no-input
pnpm qa design --from-run <analysisRunId> --org fixture
pnpm qa build --from-run <designRunId> --org fixture      # specs → tests/generated/<storyKey>/
# execute the already-approved SF-219 specs (the Phase 5 demo set)
pnpm qa run --story SF-219 --org fixture --autonomy L3 --run-id run-pX-fixture-1
pnpm validate:run run-pX-fixture-1
pnpm qa report --run run-pX-fixture-1

# visual (fixture)
pnpm qa visual run --org fixture --autonomy L3
pnpm qa visual status --org fixture

# Phase 7
pnpm qa investigate --run <runId> --no-model
pnpm qa heal --investigation <invRunId>            # plan only; --apply to apply + verify + revert-on-fail
pnpm qa faults run --suite examples/faults/fixture-suite.yaml --no-model

# live, ONLY with operator consent
pnpm qa auth status --org qa-prod
pnpm qa run --story SF-219 --org qa-prod --run-id run-pX-live-1
pnpm qa cleanup --run run-pX-live-1               # if a run left data (reconciles + re-queries)
```

Every run writes to `runs/<runId>/`:
- `report/index.md` links everything;
- `logs/run.log` and `model-attempts.json` hold model errors;
- `audit.jsonl` holds every mutation;
- `playwright-report/` and `reporting-labs/` hold the HTML reports.

---

## 8. Architecture in one page

Pipeline (LangGraph, `src/graph/mainGraph.ts`, SQLite checkpoints so `qa resume` works across processes):

```
intake → understand ⇄ clarify(interrupt) → discover → plan ⇄ review(pass 1) → build ⇄ review2 → execute → report
                     (Phase 7 adds: execute → investigate → heal → execute ×≤3 | judge → file_bug; explore)
every node = resilientNode(); errors → Issue → qaLead.triage by config/policy.yaml → retry | fallback | degrade | ask | escalate
HardStopError → BLOCKED → report
```

Key ideas a new agent must keep:
- **Code decides, models propose.**
  - Requirement status, priorities, evidence levels and review status are assigned by code.
  - LLM outputs are Zod-validated, with reflect-retry ×2, then the fallback chain, then a *mechanical* degrade path
    that is labelled as such.
- **Evidence levels** (`src/oracles/`). An expected result can be asserted only when it is backed by an approved
  requirement, declared org config, or a verified observation.
- **Generated specs** are rendered by code from a Zod IR that the coder model fills in (`src/agents/test-generator/`).
  - Page objects come from the locator registry, which the Application Explorer fills by observing the real org.
  - A spec gets a dependency record (rules, fields, locators); when a dependency changes, `qa discover` / `qa build`
    mark it STALE, and the gate (`src/runner/gate.ts`) runs only APPROVED + current specs.
- **Data**:
  - each test attempt creates its own run-tagged records (`QA_Run_Id__c`) from an approved recipe
    (`examples/recipes/account-contact.yaml`), with idempotency keys and read-back verification;
  - cleanup runs in reverse order with a tag re-check and a re-query (`src/sf/data/`, `tests/fixtures/index.ts`).
- **Safety**: every Salesforce write goes through `src/sf/client.ts` + `src/security/orgPolicy.ts` (org profile) with
  a write-ahead audit. MCP tools must pass `config/mcp-tools.yaml`. `deploy_metadata`, `browser_evaluate` and
  similar tools are blocked.
- **Fixture** (`src/fixture/`) mirrors qa-prod's behaviour (validation-rule formula subset, Lightning-like DOM). That
  is why fixture and live gave the same 3 PASS / 4 FAIL. Everything from it is labelled FIXTURE.

More detail:
- `docs/langgraph-orchestration.md`, `docs/knowledge-graph.md`, `docs/rag-guide.md`;
- `docs/test-design-guide.md`, `docs/test-data-recipe-guide.md`, `docs/playwright-mcp-guide.md`;
- `docs/reports-guide.md`, `docs/setup/salesforce-auth.md`, `docs/inputs-guide.md`, `docs/ai-embedding-config.md`.

---

## 9. Gotchas learned the hard way (don't re-learn these)

- **TypeScript is pinned to 6.0.x**: typescript-eslint supports `< 6.1`.
- **Checkpointer and stores use `node:sqlite`** (no native build). Parallel Playwright workers need the 10 s busy
  timeout (Phase 7 WIP).
- **sf CLI 2.159 redacts tokens in `--json`**, so the JWT grant is made in process (`src/sf/auth/sfCli.ts`).
- **Lightning:**
  - Locker blocks `ShadowRoot.getElementById`, so use `querySelector` inside shadow roots.
  - Toast role may be `alert` or `status`.
  - A pinned record header covers the top row, so capture from the page top.
  - `force-placeholder2` 0×0 elements never clear, so count only visible placeholders.
  - The New Contact dialog can take up to 60 s to load.
  - Lightning ignores the layout section's TopToBottom tab order. This is recorded as a Salesforce-owned a11y finding.
- **Visual:**
  - `toHaveScreenshot` takes `stylePath`, not `style`, so the masks live in `tests/support/visual-volatile.css`.
  - With `updateSnapshots: 'none'`, a missing baseline is "snapshot doesn't exist" → NO_BASELINE.
  - Hide volatile values with `visibility: hidden`, not painted boxes.
  - `maxDiffPixelRatio` is 0.0005.
- **Staleness is checked only against the org the specs were built for**, so a fixture run never writes STALE marks
  into the qa-prod manifest.
- **Models:**
  - The Google SDK does not cancel a timed-out HTTP request.
  - Gemini can return empty vectors on 429 (handled as TRANSIENT).
  - Never let the judge share a model with the coder.
- **Tracing**: instrument once (OpenInference LangChain). Adding the Langfuse callback handler as well duplicates
  spans.
- **The Rovo MCP v2 meta-tools** (`executeWrite`, `executeRead`, …) bypass the per-tool allow-list, so they stay
  blocked.
- On Windows, `pnpm qa ...` runs through `tsx`. `node bin/qa.mjs` uses `dist/` if `pnpm build` has run, so rebuild or
  delete `dist/` after code changes.

---

## 10. Using Codex / OpenCode on this repo

- Both read **`AGENTS.md`** at the repo root automatically. `CLAUDE.md` is kept for Claude Code. Keep the two in sync.
- Skills in `.claude/skills/` are plain Markdown. Read the relevant `SKILL.md` before working in its area. Do not
  move them, because the runtime loads them from there.
- MCP servers: translate `.mcp.json` into your tool's config (see AGENTS.md §4). The **runtime** does not depend on
  your agent's MCP setup.
- There are no Claude-specific runtime dependencies: `@langchain/anthropic` is only one optional provider.
- Work in a branch or worktree per phase. Commit per task. Never push to `main` directly: open a PR, as done for
  PRs #1–#6.
- When you finish a step, update the phase notes and the capability matrix, as the previous agent did after every
  task.
