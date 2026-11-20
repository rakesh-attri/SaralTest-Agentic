# Capability matrix

Status of every capability in PLAN.md. **implemented** = working code with tests · **partial** = works with a
stated limitation · **blocked** = needs an external prerequisite (exact blocker given) · **planned** = later phase.
Updated at the end of each phase (CLAUDE.md rule 16).

_Last updated: Phase 1 — 2026-11-20 (branch `claude/phase-1-implementation-854b3b`)._

## Phase 0 — Foundation

| Capability | Status | Where | Notes / blocker |
|---|---|---|---|
| pnpm workspace, TS strict, ESLint (strict-type-checked), Prettier, Vitest, cross-env | implemented | `package.json`, `tsconfig.json`, `eslint.config.js` | TypeScript pinned to 6.0.x: typescript-eslint supports `<6.1` (TS 7 not yet supported) |
| Node LTS check | implemented | `src/doctor/checks/system.ts` | Node 26.13 (even = LTS line) on this machine |
| Domain contracts (PLAN.md §4) as Zod schemas + `QARunState` | implemented | `src/core/schemas/`, `src/core/state.ts` | LangGraph `Annotation.Root` wrapper added in Phase 1 (`src/graph/state.ts`) |
| Config loaders: models, policy, personas, orgs (+profiles), execution, mcp-tools, observability | implemented | `src/config/` | judge≠coder, every IssueKind has a policy entry, 18-char org IDs, `allowAssertionChanges` must be false, no screenshots in traces; `<placeholders>` reported as unconfigured |
| `.env` loader + secret store (Windows Credential Manager → `.env`) | implemented | `src/config/env.ts`, `src/security/secretStore.ts` | Uses `@napi-rs/keyring` (keytar-compatible, maintained) instead of archived `keytar` — operator decision |
| ModelRouter: google (default), anthropic, openai, azure-openai, ollama, mock | implemented | `src/models/` | Only google + mock exercised in tests; other providers construct but are not live-tested (no keys) |
| Router guards: secret-in-prompt hard stop, quotas, timeouts, token accounting, fallback | implemented | `src/models/guarded.ts`, `router.ts` | Fallback never triggers on HARD_STOP/BUDGET. A timeout frees the caller, but the Google SDK does not cancel the underlying HTTP request (it finishes in the background) |
| Embeddings (Google default, OpenAI, Ollama, mock) | implemented | `src/models/providers/index.ts` | `voyage` → TOOL_UNAVAILABLE (planned with RAG, Phase 2) |
| Real model ids configured | partial | `config/models.yaml` (local, git-ignored) | reasoning/coder/fast = `gemini-3.5-flash-lite`, judge + reasoning fallback = `gemini-3.1-flash-lite`, embeddings = `gemini-embedding-2`; all answered `qa doctor --live` on 2026-11-20. Judge is a **temporary** small model: the key is on the Gemini free tier (Pro quota 0) |
| SkillLoader + `load_skill` tool | implemented | `src/skills/skillLoader.ts` | 16 skills (15 + vendored `langfuse`) |
| Issue, classifyError, HardStopError, resilientNode, budgets, retry | implemented | `src/core/` | Phase 1: resilientNode passes LangGraph interrupts through; the report node also runs when BLOCKED |
| pino logging, run folders `runs/<runId>/` | implemented | `src/core/logger.ts`, `runFolder.ts` | |
| MCP client + allow-list + health checks | implemented | `src/mcp/` | stdio + streamable HTTP (legacy SSE dropped: deprecated in the SDK) |
| Real MCP tool names classified | implemented | `config/mcp-tools.yaml` | Salesforce (13) + Playwright (25) verified live; Atlassian names from the observed connection, not yet re-verified on `/v2/mcp` |
| Mutation guard (org profile enforcement) | partial | `src/mcp/client.ts` | Deny-all default until Phase 2 plugs in org profiles |
| Audit log `runs/<runId>/audit.jsonl` | implemented | `src/security/audit.ts` | |
| Redaction (secrets + PII) | partial | `src/security/redact.ts` | Free-text personal names are masked only in known fields (Name, FirstName, …), not in prose |
| Idempotency keys + write ledger + reconcile | implemented | `src/security/idempotency.ts` | |
| Tracing: OTel once + OpenInference LangChain; Langfuse + Phoenix; redaction before export | implemented | `src/observability/` | Langfuse Cloud reachable with the configured keys; Phoenix path tested with a failing exporter only (no local Phoenix running) |
| Offline Salesforce fixture (mock REST/SOQL + Lightning-like pages) | implemented | `src/fixture/`, `examples/fixture/` | SOQL subset only; everything labelled FIXTURE |
| `qa doctor` | implemented | `src/doctor/`, `src/cli/` | `--offline`, `--live`, `--include-oauth`, `--json` |
| `qa mcp tools`, `qa fixture serve` | implemented | `src/cli/index.ts` | |

## Phase 1 — Inputs & clarification

| Capability | Status | Where | Notes / blocker |
|---|---|---|---|
| Canonical input contracts (`SourceDocument`, `ManualTestCase`, `DefectRecord`, `ChangedComponent`, `ExploratoryObjective`, `AnalysisFinding`) | implemented | `src/core/schemas/inputs.ts`, `requirement.ts` | |
| Section detection with stable refs (AC n, `XX-nn`, headings, bold labels) + sha256 | implemented | `src/inputs/sections.ts` | Convention-based; free prose becomes `S<n>` context blocks |
| JIRA adapter via REST (read-only) | implemented | `src/inputs/adapters/jira.ts` | Live on SF-219 (project SF). ADF → text, AC custom field, links, comments; 401/403 → AUTH, 404 → DATA, 429/5xx → TRANSIENT |
| JIRA adapter via Atlassian Rovo MCP first (`--mcp`) | partial | same | Tested with a mocked hub only. **Blocker:** `.mcp.json` uses the deprecated `/v1` URL and needs OAuth consent: switch to `/v2/mcp`, then `qa doctor --include-oauth` |
| Azure DevOps work item adapter | blocked | `src/inputs/adapters/other.ts` | Unit-tested against the REST shape. **Blocker:** no ADO org (`ADO_ORG_URL` + `ADO_PAT`) |
| Chat text, Markdown/TXT, Gherkin, JSON/YAML, PDF, DOCX adapters | implemented | `src/inputs/adapters/` | PDF: text layer only (no OCR; warning when empty). Tested on synthetic files generated at test time |
| Manual test cases (xlsx/csv) → existing cases | implemented | `src/inputs/adapters/manualTests.ts` | Header aliases; skips "Read Me" tabs; live on the demo XLSX (10 cases) |
| Defect history (JQL + past `results.json`) | implemented | `src/inputs/index.ts` | Stored for the Risk Analyzer (Phase 3); not yet in RAG (Phase 2) |
| Git diff → SFDX metadata components | implemented | `src/inputs/adapters/other.ts` | Common types mapped; others are `Unknown` |
| Exploratory objective input | implemented | same | Stored for Phase 7 |
| Agent runtime: Zod + reflect-retry ×2 + fallback model + `load_skill` | implemented | `src/agents/shared/structured.ts` | Recovered from malformed live JSON twice in the demo |
| Spec Analyst: deterministic lint (7 spec rules + 4 existing-test rules) | implemented | `src/agents/spec-analyst/lint.ts` | Caught every lint-type item of the operator's answer key in both scored runs |
| Spec Analyst: model extract + analyze with ref, persona and completeness checks | partial | `src/agents/spec-analyst/graph.ts` | Works live (Gemini 3.5 flash-lite). Cross-source conflicts vary between runs (0–2 on the same inputs), and the model has stated wrong platform facts (kept as findings, never as knowledge). Expected to improve with a Pro model (needs billing) and a deterministic cross-source check (proposed) |
| `REVIEW_REQUIRED` decided by code (no outcome / unclear / conflict / blocking lint / open question / unconfirmed assumption) | implemented | same | |
| Stable requirement ids across runs | implemented | `src/agents/spec-analyst/ids.ts` | Numbering can have gaps when the model splits or merges requirements differently |
| Mechanical degrade path (no model / invalid output) | implemented | same | All REVIEW_REQUIRED, labelled "mechanical" |
| QA Lead skeleton + policy-driven triage | implemented | `src/agents/qa-lead/triage.ts`, `src/graph/mainGraph.ts` | Only policy responses are used. Responses for later phases (investigate/heal/judge/file_bug) are skipped, and the issue is recorded as `report-only` |
| LangGraph main graph (intake → understand ⇄ clarify → report, triage after every node) | implemented | `src/graph/` | Later phases add discover/plan/build/execute |
| Clarify node with `interrupt()`, ≤5 questions/round, ≤2 rounds, assumptions flagged | implemented | same | |
| Durable checkpoints + `qa resume` across processes | implemented | `src/graph/checkpointer.ts` | Uses `node:sqlite` instead of `@langchain/langgraph-checkpoint-sqlite` (avoids a native build) |
| `qa analyze` / `qa chat` (REPL, `/why` answered from the evidence ledger) / `qa resume` | implemented | `src/cli/` | `--offline` = no network at all |
| Analysis report + JSON outputs per run | implemented | `src/graph/analysisReport.ts` | MOCK / mechanical banners |
| Independent output validation | implemented | `scripts/validate-analysis.ts` (`pnpm validate:analysis`) | |
| RAG ingest of inputs | planned | — | Phase 2 (sources are already saved as normalized JSON) |
| Org cross-check of requirements | planned | — | Phase 2; Phase 1 only emits `ORG_CHECK_NEEDED` findings |

## External prerequisites (open blockers)

| Blocker | Needed for | Owner | How to clear |
|---|---|---|---|
| Google key on the Gemini **free tier** | a Pro-class judge; any Full Copy data in prompts (free-tier prompts may be used by Google to improve products, PLAN.md §12) | Rakesh | Enable billing on the Google project behind the key, then set judge to a Pro model and re-run `pnpm qa doctor --live` |
| Real org IDs / instance URLs in `config/orgs.yaml` | live runs | Rakesh / SF admin | Phase 2 |
| External Client App + JWT key (`SF_ECA_CLIENT_ID`, `SF_JWT_KEY_PATH`) | Salesforce auth | SF admin | PLAN.md §7b, Phase 2 |
| Atlassian Rovo MCP on deprecated `/v1/mcp` in `.mcp.json` | JIRA via MCP (REST works and carried the demo) | Rakesh | Change to `https://mcp.atlassian.com/v2/mcp`, then `pnpm qa doctor --include-oauth` |
| Azure DevOps organisation + PAT | ADO work items as input (optional) | Rakesh | Set `ADO_ORG_URL` and `ADO_PAT` (Credential Manager preferred) |
| Small reasoning model on the Gemini free tier | stable cross-source conflict detection | Rakesh | Enable billing, move `reasoning` + `judge` to a Pro model, re-run the Phase 1 demo |

## Later phases

| Capability | Status | Phase |
|---|---|---|
| JWT/ECA auth, identity checks, org-profile enforcement, discovery, snapshots, knowledge graph, RAG, Explorer | planned | 2 |
| Risk model, Test Planner, oracles, Reviewer pass 1, RTM/XLSX | planned | 3 |
| Test Generator, locator ESLint rule, Reviewer pass 2, data engine | planned | 4 |
| Runner, reporting-labs + Playwright HTML, JIRA comment, Account→Contact demo | planned | 5 |
| Visual QA | planned | 6 |
| Investigation, healing, exploration, fault injection | planned | 7 |
| DeepEval sidecar, golden set, learning lifecycle | planned | 8 |
| CI/CD, full CLI, exit codes | planned | 9 |
| Autonomy levels, prod-test-org, dashboards, multi-org, ADO, MCP chat server | planned | 10 |
