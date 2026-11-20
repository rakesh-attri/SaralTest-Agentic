# Capability matrix

Status of every capability in PLAN.md. **implemented** = working code with tests · **partial** = works with a
stated limitation · **blocked** = needs an external prerequisite (exact blocker given) · **planned** = later phase.
Updated at the end of each phase (CLAUDE.md rule 16).

_Last updated: pre-Phase-4 model providers — 2026-11-20 (branch `main`)._

## Phase 0 — Foundation

| Capability | Status | Where | Notes / blocker |
|---|---|---|---|
| pnpm workspace, TS strict, ESLint (strict-type-checked), Prettier, Vitest, cross-env | implemented | `package.json`, `tsconfig.json`, `eslint.config.js` | TypeScript pinned to 6.0.x: typescript-eslint supports `<6.1` (TS 7 not yet supported) |
| Node LTS check | implemented | `src/doctor/checks/system.ts` | Node 26.13 (even = LTS line) on this machine |
| Domain contracts (PLAN.md §4) as Zod schemas + `QARunState` | implemented | `src/core/schemas/`, `src/core/state.ts` | LangGraph `Annotation.Root` wrapper added in Phase 1 (`src/graph/state.ts`) |
| Config loaders: models, policy, personas, orgs (+profiles), execution, mcp-tools, observability | implemented | `src/config/` | judge≠coder, every IssueKind has a policy entry, 18-char org IDs, `allowAssertionChanges` must be false, no screenshots in traces; `<placeholders>` reported as unconfigured |
| `.env` loader + secret store (Windows Credential Manager → `.env`) | implemented | `src/config/env.ts`, `src/security/secretStore.ts` | Uses `@napi-rs/keyring` (keytar-compatible, maintained) instead of archived `keytar` — operator decision |
| ModelRouter: google, anthropic, openai, azure-openai, ollama, openai-compatible (presets `nvidia-nim`, `groq`), mock | implemented | `src/models/`, `src/models/endpoints.ts` | google + mock exercised live/in tests; nvidia-nim / groq construct and list models in tests with mocked HTTP, **not live yet** (no `NVIDIA_API_KEY` / `GROQ_API_KEY`) |
| Per-role fallback chains (primary → fallbacks…), honest labelling of the answering model | implemented | `src/models/router.ts`, `src/agents/shared/structured.ts` | Placeholder/misconfigured entries are skipped; doctor shows which model a role currently runs on |
| Per-provider rate limits (requests + tokens per minute), fail over instead of long waits, 429 → Retry-After cooldown | implemented | `src/models/rateLimiter.ts`, `src/models/guarded.ts` | Token use is estimated before the call (chars/4 + output reserve) and corrected from provider usage. Limits are per provider, not per model (Groq limits are per model, so this is conservative) |
| `tools: false` per model (skills inlined instead of `load_skill`) | implemented | `structured.ts` | `qa doctor --live` probes tool calling and suggests the flag |
| Router guards: secret-in-prompt hard stop, quotas, timeouts, token accounting, fallback chain | implemented | `src/models/guarded.ts`, `router.ts` | Fallback never triggers on HARD_STOP/BUDGET. A timeout frees the caller, but the Google SDK does not cancel the underlying HTTP request (it finishes in the background) |
| Embeddings (Google default, OpenAI, Ollama, mock) | implemented | `src/models/providers/index.ts` | `voyage` → TOOL_UNAVAILABLE (planned with RAG, Phase 2) |
| Real model ids configured | partial | `config/models.yaml` (local, git-ignored) | Operator layout (2026-11-20): reasoning + judge on NVIDIA NIM, coder NIM → Groq, fast Groq, Gemini last for all. NIM/Groq ids are **placeholders** until picked from `qa doctor`; meanwhile every role runs on its Gemini fallback (`gemini-3.5-flash-lite`; judge `gemini-3.1-pro-preview`). Embeddings unchanged (`gemini-embedding-2`, no re-index) |
| SkillLoader + `load_skill` tool | implemented | `src/skills/skillLoader.ts` | 16 skills (15 + vendored `langfuse`) |
| Issue, classifyError, HardStopError, resilientNode, budgets, retry | implemented | `src/core/` | Phase 1: resilientNode passes LangGraph interrupts through; the report node also runs when BLOCKED |
| pino logging, run folders `runs/<runId>/` | implemented | `src/core/logger.ts`, `runFolder.ts` | |
| MCP client + allow-list + health checks | implemented | `src/mcp/` | stdio + streamable HTTP (legacy SSE dropped: deprecated in the SDK) |
| Real MCP tool names classified | implemented | `config/mcp-tools.yaml` | Salesforce (13) + Playwright (25) verified live; Atlassian names from the observed connection, not yet re-verified on `/v2/mcp` |
| Mutation guard (org profile enforcement) | implemented | `src/mcp/client.ts`, `src/security/orgPolicy.ts` | Deny-all stays the default when no guard is wired; Phase 2 wires the org-profile guard (`createSalesforceHub`, `GuardedSalesforce`) |
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
| Defect history (JQL + past `results.json`) | implemented | `src/inputs/index.ts` | Used by the Phase 3 risk model (past-defect driver: ≥2 matching terms). The SF-219 demo had no defect history input |
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
| RAG ingest of inputs | implemented | `src/rag/` | Phase 2 (`qa ingest <runId>`) |
| Org cross-check of requirements | implemented | `src/agents/sf-intelligence/` | Phase 2 (`qa discover --cross-check`, `qa analyze --org`) |

## Phase 2 — Salesforce intelligence

| Capability | Status | Where | Notes / blocker |
|---|---|---|---|
| API sessions via OAuth JWT Bearer against the External Client App (in-process RS256 assertion, token in memory + Redactor) | implemented | `src/sf/auth/sfCli.ts` | Live on qa-prod. sf CLI 2.159 redacts tokens in `--json`, so the grant is made directly; `sf org login jwt` keeps the alias for frontdoor + MCP |
| Token renewal on `INVALID_SESSION_ID` (one new grant, one retry) | implemented | `src/sf/api.ts` | |
| Frontdoor browser session per persona (`.auth/<org>/<persona>.json`, TTL reuse, login/MFA → AUTH, foreign host → IDENTITY_MISMATCH) | implemented | `src/sf/auth/browserState.ts` | Live on qa-prod (lands on `nexturninc6.lightning.force.com`) |
| Identity check (Organization + userinfo + instance + IsSandbox per profile; release drift warning) | implemented | `src/sf/identity.ts` | `qa auth status`, `qa doctor` live check |
| Org-profile enforcement for every mutation (jsforce + MCP): metadata, blocked categories, untagged cleanup, per-run approval, bulk-delete confirmation | implemented | `src/security/orgPolicy.ts`, `src/sf/client.ts`, `src/sf/hub.ts` | No live mutation in Phase 2 (discovery is read-only); all paths unit-tested |
| Write-ahead audit of record writes (ALLOWED → SUCCEEDED/FAILED, REFUSED) | implemented | `src/sf/client.ts` | Fixture-tested |
| Personas beyond admin (sales rep, read only) | blocked | `config/personas.yaml` | **Blocker:** no dedicated non-admin test users in qa-prod; the only persona is a named administrator's account |
| Discovery: objects, fields, record types, picklists + dependencies, validation rules, Apex, flows + active versions, LWC + Aura, layouts, FlexiPages, profiles, permission sets + groups, CRUD, FLS, OWD, duplicate rules, custom metadata/settings, MetadataComponentDependency | implemented | `src/sf/discovery/` | Live Account+Contact in ~5 s (399 components). Apex bodies hashed only |
| Unreadable areas → UNKNOWN placeholders (never "missing"); TRANSIENT retries | implemented | same | Live: hidden-parent permission rows recorded UNKNOWN |
| Immutable snapshots + type-prefixed content hashes + lineage | implemented | `src/knowledge/snapshotStore.ts` | `.qa-memory/knowledge.db` |
| Snapshot diff (added/removed/changed + changed keys/unknown; scope-aware; no cross-org) | implemented | `src/knowledge/diff.ts` | Fixture: changed VR detected. Live: 0-change diffs between unchanged snapshots (no false positives) |
| SQLite knowledge graph + impact (recursive CTE, depth ≤ 3, edge path as evidence) | implemented | `src/sf/graph/` | `.qa-memory/graph.db` |
| Test assets linked to components (requirements, manual tests by deterministic text match; locators explicitly) → RE_VERIFY marks | implemented | `src/sf/graph/assetLinks.ts`, `impactOfDiff` | Text match is heuristic (word-bounded labels in the objects the text names); evidence term kept on each edge |
| Org cross-check of requirements (existence, required, format, duplicate rule, personas, CRUD, picklist values, approved lists, timing mechanism) | implemented | `src/agents/sf-intelligence/crossCheck.ts` | Deterministic; NOT_FOUND only in a fully readable scope. Live findings: see phase-2-notes |
| `discover` node in the main graph (`qa analyze --org`) | implemented | `src/graph/mainGraph.ts`, `src/cli/discover.ts` | Failures degrade (PARTIAL), hard stops block |
| Application Explorer (Lightning) + locator registry (rank rules enforced, field match basis, privacy filter, redacted evidence) | implemented | `src/agents/app-explorer/`, `src/knowledge/locatorRegistry.ts` | Live: 3 pages (35/44/36 locators). Page objects are generated in Phase 4 |
| Application Explorer on Experience Cloud | blocked | same | **Blocker:** Digital Experiences not enabled in qa-prod (`Network` unsupported). No site to explore |
| Playwright MCP as explorer backend | partial | `config/mcp-tools.yaml` | Library-based explorer is the deterministic default; MCP stays available for ad-hoc exploration |
| RAG ingest: LanceDB tables, chunkers per §7, sha256 dedupe, incremental per source, resumable per batch, embed model per row, PII masking | implemented | `src/rag/` | `.qa-memory/rag/` |
| Hybrid retrieval (vector + FTS, RRF, org/release filters, sourceRef) | implemented | `src/rag/store.ts` | |
| Embedding quota handling (empty vectors from swallowed 429 → TRANSIENT, retried) | implemented | `src/models/guarded.ts` `checkVectors` | Gemini free tier allows ~60 embedded chunks/min; ingest is rate-limited accordingly |
| Run-tag field for data cleanup (`QA_Run_Id__c`) | blocked | `config/orgs.yaml` | **Blocker for Phase 4:** the field does not exist in qa-prod. Create it (admin) or set `runTagField: null` (name prefix) |

## Phase 3 — Test planning

| Capability | Status | Where | Notes / blocker |
|---|---|---|---|
| Design contracts (RiskItem, TestCharter, ImpactReport, CoverageObligation with allowed + must-cite evidence, ReviewFinding; TestCase/RtmRow extended) | implemented | `src/core/schemas/design.ts`, `testCase.ts` | Zod: APPROVED cases hold only assertable levels; non-UNKNOWN expectations cite evidence |
| Expected-result oracles: evidence index, code-assigned levels, grounding check, case status | implemented | `src/oracles/` | `VERIFIED` is never assigned before executed runs (Phase 5). Grounding = quoted values / numbers in cited evidence, step text or observed UI labels |
| Risk model (drivers → likelihood × impact; mandatory / recommended / optional; AC coverage never dropped) | implemented | `src/agents/impact-risk/risk.ts` | Live: 15 risks, 8 mandatory; a LOW AC risk (0.06) stays mandatory |
| Coverage obligations (positive, negative per org check, boundary, deny / allow, bulk, nfr, regression from RE_VERIFY) | implemented | `src/agents/impact-risk/obligations.ts` | Boundaries: `N characters` / `N digits` only. Bulk only when the snapshot has an active trigger / flow on the object |
| Persona resolution (requirement name → org profile → configured test user; else BLOCKED-NO-PERSONA) | implemented | `src/agents/impact-risk/personas.ts` | Live: read-only, sales-rep, sales-manager unavailable (no test users / no profile) |
| Test Planner: obligation-bound drafting, reflect on deterministic problems, normalisation, code-assigned priority / levels / status, manual-test reuse, stable ids, revise step | implemented | `src/agents/test-planner/` | Live on Gemini flash-lite; in 3 of 6 runs with a model, 1–2 of 5 batches fell back to mechanical drafting (labelled) |
| Mechanical degrade path (no model / invalid output) | implemented | same | Expected text = verbatim evidence; origin `mechanical` |
| Test Reviewer pass 1: deterministic checklist (rechecked per round), judge findings + verification, ≤2 rounds | implemented | `src/agents/test-reviewer/` | Judge ran on the flash-lite **fallback** (Pro blocked by billing) |
| QA Lead settlement (restore lost coverage, justify with recorded reasons, escalate the rest; nothing OPEN) | implemented | `settleFindings` | Escalated findings (5–7 per live run) need a human |
| `plan ⇄ review` nodes in the main graph; seeded entry at `plan`; triage can degrade both | implemented | `src/graph/designNodes.ts`, `mainGraph.ts` | |
| Design outputs: charter, test plan, test cases, RTM JSON + XLSX, risks, obligations, review findings, HTML test-design report, labels | implemented | `src/graph/designReport.ts` | XLSX: RTM / Test Cases / Risks / Review Findings sheets |
| `qa design`, `qa review`, `qa analyze --org` → design | implemented | `src/cli/design.ts`, `src/cli/index.ts` | `qa analyze --org` end to end tested with mocks only (not run live, to save free-tier quota) |
| Independent exit-criteria validator | implemented | `scripts/validate-design.ts` (`pnpm validate:design [--root]`) | |
| Evidence ledger as SQLite `evidence.db` | partial | `runs/<id>/design/evidence.json` | The in-memory evidence index resolves every id; persistence across runs is not needed until Phase 7 |
| Pro-class judge | blocked | `config/models.yaml` | **Blocker:** Gemini free tier — `gemini-2.5-pro` 404 for new keys, `gemini-3.1-pro-preview` 429 (quota 0). Enable billing |
| Persona-based deny cases executable | blocked | `config/personas.yaml` | **Blocker:** no Read Only / Sales Rep test users (cases are BLOCKED-NO-PERSONA) |

## External prerequisites (open blockers)

| Blocker | Needed for | Owner | How to clear |
|---|---|---|---|
| Google key on the Gemini **free tier** | a Pro-class judge; any Full Copy data in prompts (free-tier prompts may be used by Google to improve products, PLAN.md §12) | Rakesh | Enable billing on the Google project behind the key, then set judge to a Pro model and re-run `pnpm qa doctor --live` |
| Full Copy sandbox `fc-admin`: placeholder org ID/URL, expired sf session | later live runs on the sandbox | Rakesh / SF admin | Fill `config/orgs.yaml`, authorize with `pnpm qa auth login --org fc-admin` |
| Dedicated non-admin test users (sales rep, read only) on qa-prod, pre-approved on the ECA | persona-based UI/permission checks (AC6), BLOCKED-NO-PERSONA otherwise | SF admin | Create users, approve on the ECA, add to `config/personas.yaml`, `pnpm qa auth login --persona <id>` |
| `QA_Run_Id__c` run-tag field missing in qa-prod | Phase 4 data cleanup guard | SF admin | Create the field on Account/Contact (metadata is never changed by the agent) or set `runTagField: null` |
| Digital Experiences not enabled in qa-prod | Explorer on Experience Cloud | SF admin | Enable + create a site, or explore it in the Full Copy sandbox |
| Atlassian Rovo MCP on deprecated `/v1/mcp` in `.mcp.json` | JIRA via MCP (REST works and carried the demo) | Rakesh | Change to `https://mcp.atlassian.com/v2/mcp`, then `pnpm qa doctor --include-oauth` |
| Azure DevOps organisation + PAT | ADO work items as input (optional) | Rakesh | Set `ADO_ORG_URL` and `ADO_PAT` (Credential Manager preferred) |
| Small reasoning model on the Gemini free tier | stable cross-source conflict detection | Rakesh | Enable billing, move `reasoning` + `judge` to a Pro model, re-run the Phase 1 demo — or use NVIDIA NIM (below) |
| Gemini Pro judge returns 429 (free-tier quota 0) | a real Pro-class Test Reviewer (Phase 3), later Defect Judge | Rakesh | Enable billing; `judge: gemini-3.1-pro-preview` is already configured with a flash-lite fallback |
| Q1–Q3 assumed; 4 org conflicts (Email / Phone required, duplicate rule inactive, Title list) | assertable cases for AC3–AC5, BR-03/04/06/08/10 | product owner + SF admin | Answer the questions (`qa resume` / new analyze) and fix or confirm the org config, then `qa design` again |
| `NVIDIA_API_KEY` and `GROQ_API_KEY` not set | NIM / Groq roles; until then every role runs on its Gemini fallback | Rakesh | Add both keys (Credential Manager or `.env`), run `pnpm qa doctor`, pick ids from the printed lists into `config/models.yaml`, then `pnpm qa doctor --live` |

## Later phases

| Capability | Status | Phase |
|---|---|---|
| Test Generator, locator ESLint rule, Reviewer pass 2, data engine | planned | 4 |
| Runner, reporting-labs + Playwright HTML, JIRA comment, Account→Contact demo | planned | 5 |
| Visual QA | planned | 6 |
| Investigation, healing, exploration, fault injection | planned | 7 |
| DeepEval judge model over the judge chain (OpenAI-compatible, failover on 429) | partial (pre-Phase-4) | `src/eval/judgeEndpoint.ts`, `eval/qa_eval/judge_model.py` |
| DeepEval sidecar runner, metrics/gates, golden set, learning lifecycle | planned | 8 |
| CI/CD, full CLI, exit codes | planned | 9 |
| Autonomy levels, prod-test-org, dashboards, multi-org, ADO, MCP chat server | planned | 10 |
