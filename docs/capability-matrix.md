# Capability matrix

Status of every capability in PLAN.md. **implemented** = working code with tests · **partial** = works with a
stated limitation · **blocked** = needs an external prerequisite (exact blocker given) · **planned** = later phase.
Updated at the end of each phase (CLAUDE.md rule 16).

_Last updated: Phase 0 — 2026-11-20 (branch `phase-0-foundation`)._

## Phase 0 — Foundation

| Capability | Status | Where | Notes / blocker |
|---|---|---|---|
| pnpm workspace, TS strict, ESLint (strict-type-checked), Prettier, Vitest, cross-env | implemented | `package.json`, `tsconfig.json`, `eslint.config.js` | TypeScript pinned to 6.0.x: typescript-eslint supports `<6.1` (TS 7 not yet supported) |
| Node LTS check | implemented | `src/doctor/checks/system.ts` | Node 26.13 (even = LTS line) on this machine |
| Domain contracts (PLAN.md §4) as Zod schemas + `QARunState` | implemented | `src/core/schemas/`, `src/core/state.ts` | LangGraph `Annotation.Root` wrapper arrives with the main graph (Phase 1) |
| Config loaders: models, policy, personas, orgs (+profiles), execution, mcp-tools, observability | implemented | `src/config/` | judge≠coder, every IssueKind has a policy entry, 18-char org IDs, `allowAssertionChanges` must be false, no screenshots in traces; `<placeholders>` reported as unconfigured |
| `.env` loader + secret store (Windows Credential Manager → `.env`) | implemented | `src/config/env.ts`, `src/security/secretStore.ts` | Uses `@napi-rs/keyring` (keytar-compatible, maintained) instead of archived `keytar` — operator decision |
| ModelRouter: google (default), anthropic, openai, azure-openai, ollama, mock | implemented | `src/models/` | Only google + mock exercised in tests; other providers construct but are not live-tested (no keys) |
| Router guards: secret-in-prompt hard stop, quotas, timeouts, token accounting, fallback | implemented | `src/models/guarded.ts`, `router.ts` | Fallback never triggers on HARD_STOP/BUDGET |
| Embeddings (Google default, OpenAI, Ollama, mock) | implemented | `src/models/providers/index.ts` | `voyage` → TOOL_UNAVAILABLE (planned with RAG, Phase 2) |
| Real model ids configured | **blocked** | `config/models.yaml` | Operator to pick ids; `qa doctor` lists the key's models and suggests ids |
| SkillLoader + `load_skill` tool | implemented | `src/skills/skillLoader.ts` | 16 skills (15 + vendored `langfuse`) |
| Issue, classifyError, HardStopError, resilientNode, budgets, retry | implemented | `src/core/` | QA Lead triage that *acts* on issues is Phase 1 |
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

## External prerequisites (open blockers)

| Blocker | Needed for | Owner | How to clear |
|---|---|---|---|
| Gemini model ids in `config/models.yaml` | any LLM call | Rakesh | Pick from `qa doctor` suggestions |
| Real org IDs / instance URLs in `config/orgs.yaml` | live runs | Rakesh / SF admin | Phase 2 |
| External Client App + JWT key (`SF_ECA_CLIENT_ID`, `SF_JWT_KEY_PATH`) | Salesforce auth | SF admin | PLAN.md §7b, Phase 2 |
| `JIRA_BASE_URL` still the template value in `.env` | JIRA REST fallback | Rakesh | Set your Atlassian site URL |
| Atlassian Rovo MCP on deprecated `/v1/mcp` in `.mcp.json` | JIRA via MCP | Rakesh | Change to `https://mcp.atlassian.com/v2/mcp`, then `pnpm qa doctor --include-oauth` |

## Later phases

| Capability | Status | Phase |
|---|---|---|
| Input adapters, Spec Analyst, clarify/interrupt, chat REPL, QA Lead triage | planned | 1 |
| JWT/ECA auth, identity checks, org-profile enforcement, discovery, snapshots, knowledge graph, RAG, Explorer | planned | 2 |
| Risk model, Test Planner, oracles, Reviewer pass 1, RTM/XLSX | planned | 3 |
| Test Generator, locator ESLint rule, Reviewer pass 2, data engine | planned | 4 |
| Runner, reporting-labs + Playwright HTML, JIRA comment, Account→Contact demo | planned | 5 |
| Visual QA | planned | 6 |
| Investigation, healing, exploration, fault injection | planned | 7 |
| DeepEval sidecar, golden set, learning lifecycle | planned | 8 |
| CI/CD, full CLI, exit codes | planned | 9 |
| Autonomy levels, prod-test-org, dashboards, multi-org, ADO, MCP chat server | planned | 10 |
