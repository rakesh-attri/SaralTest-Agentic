# CLAUDE.md — Autonomous Salesforce AI QA Engineer

You (Claude Code) are building **sf-qa-agent**: a local, Windows-first, multi-agent QA system that takes
JIRA stories (or chat / spec files) and produces QA docs, executed Playwright + API tests, investigated
defects, ReportingLabs + Playwright HTML reports, and verified learnings.

**Read `PLAN.md` before any work. Build phase by phase. Do not start a phase until the previous phase's exit
criteria pass.** After each phase, update the checklist in `PLAN.md` and write a short `docs/phase-N-notes.md`.

## Non-negotiable rules

1. **TypeScript strict.** `"strict": true`, no `any` except at MCP boundaries (wrap them with Zod parsing immediately).
2. **Every agent output is validated with a Zod schema** in `src/agents/<agent>/schema.ts`. Invalid output →
   reflect-and-retry with the Zod error → fallback model → raise an `Issue`. Never pass unvalidated LLM JSON on.
3. **No node may throw out of the graph.** Wrap every node with `resilientNode()` (see PLAN.md §Contracts).
   Exceptions become `Issue` objects in state; the QA Lead decides what happens. Every path ends at `report`.
4. **Hard stops are the only exceptions to rule 3**: org ID not in `config/orgs.yaml`, failed identity check, a mutation
   the org profile forbids, metadata deploy/change, a secret leaving the machine in a prompt, cleanup touching records
   without this run's tag. These raise `HardStopError` → the run ends with status `BLOCKED` and a report.
5. **Generated tests are executed by the Playwright Test runner**, never by driving Playwright MCP step by step.
   Playwright MCP is only for exploration, locator discovery and healing.
6. **Locators follow `.claude/skills/salesforce-lightning-locators/SKILL.md`.** The ESLint rule
   `sf-locators/no-fragile-locators` must pass on `tests/**`. No XPath, no generated IDs, no `waitForTimeout`.
7. **Self-healing never changes assertions**, expected values, or test intent. Only locators, waits, navigation.
8. **Model access only through `ModelRouter.get(role)`** — roles: `reasoning`, `coder`, `fast`, `judge`.
   Never import a provider SDK directly in agent code. The `judge` role must be a different model than `coder`.
9. **Skills are loaded through `SkillLoader`** from `.claude/skills/`. Agents get skill *descriptions* in their
   system prompt and pull full bodies on demand via a `load_skill` tool.
10. **Secrets** come from env / Windows Credential Manager (`keytar`) only. Never log them, never put them in prompts,
    add them to `maskKeys` for reporting-labs.
11. **Windows first**: use `node:path` (never hard-coded `/`), `cross-env`, PowerShell-friendly npm scripts, no bash-only
    scripts. Test every CLI command on Windows paths with spaces.
12. **Never fabricate.** No invented Salesforce metadata, expected results or test data values. Expected results need an
    evidence level (PLAN.md §7f). Hypotheses are never promoted to verified knowledge automatically.
13. **Label environments.** Results from the offline fixture or mock providers are `FIXTURE`/`MOCK` everywhere and are
    never reported as a real Salesforce pass.
14. **Security by default.** Every tool call is `observe` or `mutate`; mutations go through org profile + policy +
    approvals; MCP tools pass the allow-list; every mutation is audit-logged; PII is redacted before prompts/logs.
15. **Prefer deterministic checks.** Deterministic assertions over LLM judgement; independent API/SOQL verification over
    UI-only checks.
16. **Track status honestly.** Keep `docs/capability-matrix.md` (implemented / partial / blocked) and
    `docs/requirements-registry.md` (cumulative) up to date each phase. If an external prerequisite (credentials, org,
    model key) is missing, continue the safe local work and report the exact blocker.
17. **Tracing:** one OpenTelemetry instrumentation, exporters switched in `config/observability.yaml` (Langfuse primary,
    Phoenix optional). Redact before export, no screenshots in traces, keys only from `.env`, exporter failures never
    stop a run.
18. **Small, reviewable commits** per task. Each new module gets unit tests (Vitest). MCP and Salesforce are mocked
    in unit tests; real-org tests live under `tests/integration` and are opt-in (`QA_INTEGRATION=1`).

## Commands (PowerShell-friendly; `pnpm qa <cmd>` or the `qa` bin)

| Command | Purpose |
|---|---|
| `qa doctor` | Environment, browsers, model providers, MCP servers, Salesforce identity, Python sidecar |
| `qa discover [--org <id>]` | Org discovery → new snapshot + diff |
| `qa ingest <path\|jql>` | Documents, manual tests, defect history into RAG |
| `qa analyze --story SF-1234` | Requirements + clarification questions |
| `qa design` / `qa review` | Test design / Test Reviewer pass |
| `qa run --story SF-1234 [--org <alias>] [--autonomy L2] [--browser chrome]` | Full run |
| `qa run --regression nightly\|pr --diff <ref>` | Regression sets |
| `qa explore --objective "<text>"` | Goal-directed exploration |
| `qa cleanup [--run <id>]` | Clean up + reconcile run-owned data |
| `qa report` / `qa history` | Rebuild reports / past runs and trends |
| `qa learnings [list\|approve\|retire]` | Inspect learnings |
| `qa visual approve` | Accept visual baselines |
| `qa chat` / `qa resume --run <id>` | Chat REPL / resume from checkpoint |
| `pnpm test` / `pnpm lint` / `pnpm typecheck` / `pnpm eval:golden` | Dev checks |

Every command prints what it is doing, why a step is blocked, which approval is needed, and where output was saved.

## Acceptance demo (Account → Contact)

Run first against `examples/fixture/` (offline), then live on the `dedicated-qa-prod` org (production org holding only
test data — the place to build scripts and test the framework), then — with separate approval — the Full Copy sandbox:
story in → analysis → knowledge retrieval → missing rules flagged → reviewed scenarios → data plan (Account → Contact) →
Playwright + API assertions generated → org/user identity verified → synthetic Account created → related Contact
created → headless run → UI observed → `Contact.AccountId` verified by SOQL → visual + functional results recorded →
failures investigated → run-owned records cleaned and cleanup verified → reporting-labs output → verified lessons stored →
operator QA report. Fixture evidence never counts as live Salesforce evidence.

## Documentation deliverables (`docs/`)

Architecture; agent responsibility matrix; RTM; data-flow diagrams; Salesforce auth guide (ECA + JWT); AI & embedding
config; RAG guide; test-data recipe guide; Playwright/MCP guide; LangGraph orchestration; Windows setup; CI/CD guide;
security & approvals guide; reports guide; troubleshooting; feature/capability matrix; implementation report; known
limitations & roadmap; beginner walkthrough. Each explains how the subsystem works and points to source locations.

## Where things live

- Architecture, agents, contracts, phases: `PLAN.md`
- Domain know-how: `.claude/skills/*/SKILL.md` (use them yourself while writing tests and agent prompts)
- Config: `config/*.yaml` (copy from `*.example.yaml`), `.mcp.json`, `.env`
- Generated tests: `tests/generated/<storyKey>/`; page objects: `tests/pages/`; run outputs: `runs/<runId>/`
- Memory: `.qa-memory/` (LanceDB, SQLite graph, checkpoints) — git-ignored

## Definition of done for any task

- Typecheck, lint and unit tests pass.
- New behaviour is covered by a test or by a documented manual check in the phase notes.
- No new `Issue` type without a QA Lead policy entry in `config/policy.yaml`.
