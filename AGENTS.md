# AGENTS.md — sf-qa-agent (for Codex, OpenCode, Cursor, Aider or any coding agent)

This repo was built with Claude Code. Claude Code reads `CLAUDE.md`. Other agents read this file. **This file holds
the same rules, plus the tool-neutral details a new agent needs.** If the two files ever disagree, `CLAUDE.md` and
`PLAN.md` win, and you should fix this file.

> **Read in this order before you change anything:**
> 1. `AGENTS.md` (this file): rules, commands, repo map.
> 2. **`docs/HANDOFF.md`**: the current state, which branch has what, uncommitted work, open decisions, how to resume.
> 3. `PLAN.md`: architecture, agents, contracts, resilience policy, phases with checklists and exit criteria.
> 4. The newest `docs/phase-N-notes.md`, then `docs/capability-matrix.md` (implemented / partial / blocked).
> 5. The `.claude/skills/<name>/SKILL.md` that matches your task (see "Skills" below).

---

## 1. What this project is

**sf-qa-agent** is a local, Windows-first, multi-agent QA system for Salesforce. Its inputs are a JIRA story, a chat
request or a spec file (PDF, DOCX, Markdown, Gherkin, JSON, YAML, or manual test cases in XLSX/CSV). It produces:

- QA docs: test charter, plan, cases, RTM (JSON + XLSX), clarification log.
- Generated Playwright UI tests and API tests that the Playwright Test runner executes.
- Investigated failures and defect drafts.
- Reports: reporting-labs, Playwright HTML, execution and release-confidence reports, visual-diff, a JIRA comment.
- Verified learnings, kept in persistent memory.

Stack: TypeScript (strict), Node ≥ 22 (dev machine: Node 26.13), pnpm 12, LangGraph.js, LangChain model providers,
Playwright 1.65, jsforce, Zod 4, LanceDB (RAG), `node:sqlite` (knowledge graph, checkpoints, evidence ledger),
OpenTelemetry → Langfuse, Vitest. There is an optional Python 3.12 + `uv` sidecar in `eval/` (DeepEval).

Model access is provider-agnostic, by **role** (`reasoning`, `coder`, `fast`, `judge`). The providers configured
today are NVIDIA NIM, Groq and Google Gemini; Anthropic, OpenAI, Azure OpenAI and Ollama also work. **The runtime
product does not need Claude.** Only the development workflow used Claude Code.

---

## 2. Non-negotiable rules (from CLAUDE.md, apply to every change)

1. **TypeScript strict.** No `any`, except at MCP boundaries, and those must be Zod-parsed immediately.
2. **Every agent output is validated with Zod** (`src/agents/<agent>/schema.ts`). If output is invalid, retry with
   the Zod error as feedback, then use the fallback model, then raise an `Issue`. Never pass unvalidated LLM JSON on.
3. **No node may throw out of the graph.** Wrap every node with `resilientNode()` (`src/core/resilientNode.ts`).
   Exceptions become `Issue` objects in state, and the QA Lead triages them by `config/policy.yaml`. Every path ends
   at `report`.
4. **Hard stops are the only exception** (`HardStopError` → run status `BLOCKED` + a report). They are:
   - an org ID that is not in `config/orgs.yaml`;
   - a failed identity check;
   - a mutation the org profile forbids;
   - a metadata deploy or change;
   - a secret that would enter a prompt;
   - cleanup that would touch records without this run's tag.
5. **The Playwright Test runner executes generated tests.** Never drive Playwright MCP step by step to execute a
   test. MCP is only for exploration, locator discovery and healing.
6. **Locators follow `.claude/skills/salesforce-lightning-locators/SKILL.md`.** The ESLint rule
   `sf-locators/no-fragile-locators` (`packages/eslint-plugin-sf-locators/`) must pass on `tests/**`. Do not use
   XPath, generated IDs or `waitForTimeout`.
7. **Self-healing never changes assertions**, expected values or test intent. It may change only locators, waits
   and navigation. `src/agents/self-healer/fingerprint.ts` enforces this with an AST fingerprint (Phase 7).
8. **Models are reached only through `ModelRouter.get(role)`** (`src/models/router.ts`). Never import a provider SDK
   in agent code. `judge` must be a different model from `coder` (the config loader enforces this).
9. **Skills are loaded through `SkillLoader`** (`src/skills/skillLoader.ts`) from `.claude/skills/`. Agents get skill
   descriptions in their system prompt and load full bodies on demand with a `load_skill` tool.
10. **Secrets** come only from env or Windows Credential Manager (`@napi-rs/keyring`, service `sf-qa-agent`). Never
    log them or put them in prompts. Add them to `maskKeys` for reporting-labs.
11. **Windows first.** Use `node:path` (never a hard-coded `/`) and `cross-env`. Keep npm scripts PowerShell-friendly
    and write no bash-only scripts. Test CLI commands on paths with spaces.
12. **Never fabricate.** Do not invent Salesforce metadata, expected results or test data. Each expected result
    carries an evidence level (PLAN.md §7f). Only `APPROVED_REQUIREMENT`, `DECLARED_CONFIG` and `VERIFIED` may
    become assertions. A hypothesis is never promoted to verified knowledge automatically.
13. **Label environments.** Results from the offline fixture or mock providers are labelled `FIXTURE` / `MOCK`
    everywhere. They are never reported as a real Salesforce pass.
14. **Security by default.**
    - Every tool call is `observe` or `mutate`.
    - Mutations go through the org profile, the policy and approvals.
    - MCP tools must be on the allow-list (`config/mcp-tools.yaml`).
    - Every mutation is audit-logged (`runs/<id>/audit.jsonl`).
    - PII is redacted before prompts and logs.
15. **Prefer deterministic checks** over LLM judgement. Prefer API/SOQL verification over UI-only checks.
16. **Track status honestly.** Update `docs/capability-matrix.md` and `docs/requirements-registry.md` each phase. If an
    external prerequisite is missing, continue the safe local work and report the exact blocker.
17. **Tracing:** use one OpenTelemetry instrumentation, with exporters switched in `config/observability.yaml`
    (Langfuse primary, Phoenix optional).
    - Instrument once: never add both the Langfuse callback handler and OpenInference.
    - Redact before export, and put no screenshots in traces.
    - An exporter failure is a warning only.
18. **Small, reviewable commits**, one per task. Each new module gets Vitest unit tests. MCP and Salesforce are mocked
    in unit tests. Real-org tests live in `tests/integration` and are opt-in (`QA_INTEGRATION=1`).

**Definition of done for any task:**
- `pnpm typecheck`, `pnpm lint` and `pnpm test` pass.
- New behaviour is covered by a test, or by a documented manual check in the phase notes.
- No new `IssueKind` is added without a QA Lead policy entry in `config/policy.yaml`.

**Human-in-the-loop rules the operator (Rakesh) relies on:**
- **Never approve on the operator's behalf.** Approvals (`--by "<name>"`, `--approve-by`, `qa data approve`,
  `qa visual approve`, `qa report comment approve`) are recorded with a human name. Run them only after the operator
  says so in chat, and then use their name.
- Do not post to JIRA, publish defects or change Salesforce Setup/metadata yourself. Ask the operator.
- Live runs mutate a real org (qa-prod). Run them only when the operator asks. Fixture runs are always safe.

---

## 3. Skills (domain know-how): how to use them without Claude Code

`.claude/skills/<name>/SKILL.md` are plain Markdown files with YAML frontmatter (`name`, `description`). Claude Code
loaded them automatically. **In Codex or OpenCode, read the file yourself before working in its area**. The runtime
agents load the same files through `SkillLoader`, so do not move or rename them. (OpenCode can also discover skills
from `.claude/skills/`; if your version does not, just read them.)

| Skill | Read it when you… |
|---|---|
| `qa-lead-playbook` | touch triage, routing, the policy, or decide what to do after an error |
| `requirement-analysis` | work on the Spec Analyst, inputs, clarification questions |
| `salesforce-platform` | reason about objects, validation rules, flows, sharing, limits |
| `salesforce-lightning-locators` | write, review, discover or heal any locator / page object |
| `salesforce-auth-personas` | touch JWT auth, frontdoor sessions, personas, `.auth/` |
| `salesforce-test-data` | touch recipes, the data engine, run-tag cleanup |
| `salesforce-api-testing` | write API tests, SOQL verification, UserRecordAccess checks |
| `test-design` | work on the Test Planner / Reviewer, risk model, RTM |
| `playwright-standards` | generate, review or heal a spec or page object |
| `visual-testing` | touch baselines, masks, layout checks, a11y |
| `defect-investigation` | work on the Failure Investigator, Defect Judge (**Phase 7**) |
| `exploratory-testing` | work on the Autonomous Explorer (**Phase 7**) |
| `safety-and-approvals` | add a tool, a mutation, an approval or a checkpoint |
| `reporting` | touch reports, JIRA comment, reporting-labs |
| `verified-learning` | Phase 8: learnings, DeepEval gates |
| `langfuse` | tracing / Langfuse (vendored reference skill) |

---

## 4. Setup (Windows, PowerShell)

```powershell
# prerequisites: Node 22+ (dev machine uses 26.13), pnpm 12, Git, Salesforce CLI (sf), optional Python 3.12 + uv
pnpm install
pnpm exec playwright install chromium
# copy each config/*.example.yaml to config/<name>.yaml (git-ignored), .env.example to .env, .mcp.example.json to .mcp.json
pnpm qa doctor            # add --offline (no network), --live (1 tiny call per model role), --json
```

The real `config/*.yaml`, `.env`, `.mcp.json`, `.auth/`, `.qa-memory/` and `runs/` are **git-ignored**. On the
operator's machine they already exist in `C:\Projects\SaralTest-Agentic\` (see `docs/HANDOFF.md` §3). A fresh clone
needs them recreated from the examples.

### MCP servers for your agent

`.mcp.example.json` defines three servers. It is used both by the dev agent and by the runtime (`src/mcp/client.ts`):
- `salesforce`: `npx -y @salesforce/mcp --orgs <alias> --toolsets orgs,data,metadata,users,testing --allow-non-ga-tools`
- `playwright`: `npx @playwright/mcp@latest --browser chromium --isolated`
- `atlassian-rovo`: `npx -y mcp-remote https://mcp.atlassian.com/v2/mcp` (OAuth in the browser)

To use them in **Codex**, add the same command/args under `[mcp_servers.<name>]` in `~/.codex/config.toml`. In
**OpenCode**, add them under `"mcp"` in `opencode.json` (`type: "local"`, `command: [...]`). The runtime's own MCP use
is governed by `config/mcp-tools.yaml`; only tools listed there load.

---

## 5. Commands

Dev checks (run all three before every commit):

| Command | Purpose |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` (strict, `noUncheckedIndexedAccess`) |
| `pnpm lint` | ESLint strict-type-checked + `sf-locators/no-fragile-locators` on `tests/**` |
| `pnpm test` | Vitest unit tests (`src/**/*.test.ts`, `tests/unit/**`). ~650+ tests, all mocked, no network |
| `pnpm test:integration` | opt-in real-org tests (`QA_INTEGRATION=1`) |
| `pnpm format` / `pnpm format:check` | Prettier |
| `pnpm validate:analysis\|design\|build\|data\|run\|visual <runIds>` | independent validators that re-check a run folder's exit criteria |

The `qa` CLI is run as `pnpm qa <cmd>`, or `node bin/qa.mjs <cmd>` from any folder. Global option: `--root <path>`.

| Command | What it does |
|---|---|
| `qa doctor [--offline\|--live\|--include-oauth\|--json]` | Environment, browsers, model providers, MCP, Salesforce identity, Python sidecar |
| `qa mcp tools [--server <n>]` | Lists real MCP tool names; flags unclassified / stale allow-list entries |
| `qa fixture serve [--port 4545] [--metadata <f>] [--layout <f>]` | Offline Salesforce fixture (mock REST/SOQL + Lightning-like pages), results labelled FIXTURE |
| `qa auth status\|login [--org <alias>] [--persona <id>]` | JWT login, identity check, browser session per persona |
| `qa analyze --story SF-219 \| --file <path> \| --text ... [--manual-tests x.xlsx] [--org <alias>] [--offline] [--mcp] [--answers a.yaml] [--no-input]` | Inputs → requirements + clarification questions (LangGraph, checkpointed) |
| `qa resume --run <id> [--answers f]` / `qa chat` | Resume after a clarification interrupt / chat REPL (`/why` reads the evidence ledger) |
| `qa decide --run <id> ...` | Apply operator decisions (answers, deferred reqs) → new analysis run (`examples/decisions/SF-219.yaml`) |
| `qa discover [--org <alias>] [--objects Account,Contact] [--cross-check]` | Org discovery → immutable snapshot + diff + knowledge graph + impact |
| `qa locators discover\|page-objects\|dry-run\|list\|observe-messages` | Application Explorer, locator registry, page-object generation, live locator dry-run, observed error texts |
| `qa ingest [targets...]` | RAG ingest into LanceDB (hash-deduped, incremental, resumable) |
| `qa design --from-run <analysisRun> --org <alias>` / `qa review --run <designRun>` | Risk model, coverage obligations, Test Planner, Reviewer pass 1, plan/cases/RTM |
| `qa build --from-run <designRun> --org <alias> [--cases ...] [--stale]` / `qa review --run <buildRun> --pass 2 [--cases ...]` | Generate Playwright specs + Reviewer pass 2 (APPROVED / REVIEW_REQUIRED / BLOCKED) |
| `qa data plan\|approve\|run` / `qa cleanup [--run <id>]` | Test-data engine: recipe → plan → approval → create/verify → reverse-order verified cleanup |
| `qa run --story SF-219 --org <alias> [--browser chrome\|msedge\|chromium] [--autonomy L1\|L2\|L3] [--cases ...] [--plan-only] [--run-id ...]` | Execute APPROVED, current specs. Exit codes (`exitCodeOf` in `src/cli/run.ts`): 0 = all PASS + data clean · 1 = any FAIL/UNCERTAIN/BLOCKED test or data not clean · 2 = nothing executable · 3 = run BLOCKED (hard stop) |
| `qa report --run <id>` / `qa report comment draft\|approve\|publish` | Rebuild reports / JIRA run comment (approval bound to sha256) |
| `qa visual run\|approve\|status --org <alias>` | Visual baselines, layout checks, a11y (Phase 6) |
| `qa investigate --run <id> [--offline] [--no-reruns] [--no-model]` | **Phase 7 (branch `claude/phase-7-investigation`)**: failure investigation → evidence-ledgered verdict |
| `qa heal --investigation <id> [--apply] [--approve-by <name>]` / `qa heal revert\|list` | **Phase 7**: Self-Healer (locators/waits only; byte-exact revert) |
| `qa faults run --suite examples/faults/fixture-suite.yaml [--only ...] [--no-model]` | **Phase 7, uncommitted WIP**: fault-injection suite on the fixture |
| `qa explore`, `qa learnings`, `qa history` | Stubs: print "planned for Phase 7/8/9" and exit 2 |

Run ids follow `run-p<phase>-<fixture|live|...>-<n>` (for example `run-p6-live-15`). Investigation runs are `inv-*`,
heal runs `heal-*`, fault suites `flt-*`. Every command says what it is doing, why a step is blocked, which approval it
needs and where output was saved (`runs/<runId>/`).

---

## 6. Repo map

```
bin/qa.mjs                    CLI launcher (dist/ if built, else tsx)
src/cli/                      commander commands (index.ts registers all)
src/core/                     state, Issue, classifyError, HardStopError, resilientNode, retry, budget, logger, runFolder
src/core/schemas/             ALL Zod contracts (requirement, testCase, design, generation, data, execution, result,
                              visual, investigation, exploration, learning, knowledge, issue, inputs)
src/config/                   Zod config loaders (models, policy, personas, orgs, execution, mcp-tools, observability), env
src/models/                   ModelRouter, providers, fallback chains, rate limiter, guarded calls, attempt log
src/agents/<agent>/           spec-analyst, sf-intelligence, app-explorer, impact-risk, test-planner, test-reviewer,
                              test-generator, qa-lead, shared/structured.ts (Zod + reflect-retry + fallback + load_skill)
                              Phase 7 branch adds: failure-investigator, self-healer
src/graph/                    LangGraph main graph, nodes, reports, SQLite checkpointer (node:sqlite)
src/inputs/                   input adapters (JIRA REST/MCP, ADO, files, PDF, DOCX, XLSX, git diff) → Requirement
src/sf/                       auth (JWT, frontdoor), identity, guarded client, hub, discovery, knowledge graph, data engine
src/knowledge/                snapshots + diff, locator registry, observed messages (+ evidence ledger on Phase 7)
src/rag/                      LanceDB store, chunkers, hybrid retrieval
src/oracles/                  expected-result evidence levels, grounding
src/security/                 org policy guard, approvals, audit, redaction, idempotency, secret store
src/runner/                   gate, preflight, execute (Playwright Test), results, reconcile, browser channel
src/report/                   execution / release-confidence / JIRA comment reports
src/visual/                   visual run, collect, approve, baselines, report, tab order
src/fixture/                  offline Salesforce fixture server (SOQL subset, formula subset, layouts)
src/observability/            OpenTelemetry + Langfuse/Phoenix
src/mcp/                      MCP client + allow-list + boundary parsing
src/doctor/                   qa doctor checks
src/eval/                     DeepEval judge endpoint wrapper
packages/eslint-plugin-sf-locators/   custom ESLint rule
tests/generated/SF-219/       generated specs (reviewable, re-runnable without the LLM)
tests/pages/                  generated page objects (from the locator registry)
tests/support/                Lightning helpers, waits, a11y, visual, layout
tests/fixtures/index.ts       Playwright fixtures: persona, sf, data (per-test sub-run + verified cleanup), a11y
tests/setup/auth.setup.ts     per-persona storageState
tests/visual/                 VIS-001 visual suite, A11Y-001 a11y suite
tests/visual-baselines/<org>/ approved baseline PNGs + baselines.json
playwright.config.ts / playwright.visual.config.ts
examples/                     fixture data, recipes, stories, inputs (BRD PDF, manual tests XLSX), decisions, case edits
                              (Phase 7 WIP: examples/faults/fixture-suite.yaml)
scripts/                      validate-*.ts, probe-coder.ts, backfill-spec-deps.ts
eval/                         Python DeepEval sidecar (uv), golden/SF-219
ci/                           GitHub Actions + Azure Pipelines templates (Phase 9 to finish)
config/                       *.example.yaml (committed) + policy.yaml + mcp-tools.yaml (committed); real yaml git-ignored
docs/                         guides, phase notes, capability matrix, requirements registry, HANDOFF.md
```

---

## 7. How work is done here (the workflow to keep)

- **Phase by phase.** Do not start a phase until the previous phase's exit criteria pass (PLAN.md §11).
- **One branch per phase** (`claude/phase-N-<topic>`), stacked on the previous one, **one commit per task** (T1, T2,
  …) plus one commit per fix found in a fixture or live run. Commit messages say what changed and which run proved it.
- **Prove on the offline fixture first** (`qa fixture serve`, `--org fixture`, `--autonomy L3`). Then go live on
  `qa-prod`, only when the operator says so.
- **At the end of every phase:**
  - tick `PLAN.md` §11 and write its status line;
  - write `docs/phase-N-notes.md` (what was built, how it works, findings → fixes, exit proof with run ids, not
    verified / known limits);
  - update `docs/capability-matrix.md` and `docs/requirements-registry.md`;
  - run the matching `pnpm validate:*`.
- Record operator decisions with their date in the phase notes ("operator 2026-11-27").
- Be honest. Write "not run", "fixture only" or "not verified" when that is the truth.
