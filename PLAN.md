# PLAN.md — Autonomous Salesforce AI QA Engineer (sf-qa-agent)

> Build plan for Claude Code. Read `CLAUDE.md` first for the rules. Work phase by phase; tick the boxes as you go.

---

## 1. Goal

**Spec in → tested, investigated and reported out → smarter next time.**

Input: a JIRA story (Atlassian Rovo MCP), an Azure DevOps work item (optional), a chat request, a spec file
(Gherkin / Markdown / text / JSON / YAML / PDF / DOCX), existing manual test cases, defect history, Git diffs,
or an exploratory objective. All inputs become the canonical requirement record (§4).
Output per run (`runs/<runId>/`):

- QA docs: test charter, test plan, test cases, requirements traceability matrix (RTM), clarification log
- Executed tests: Playwright UI specs + API tests (generated, reviewable, re-runnable without the LLM)
- Defects: investigated, reproduced, evidenced, drafted (published to JIRA/ADO only under an approved policy)
- Reports: reporting-labs HTML + Playwright HTML + the additional reports in §14 + JIRA comment
- Verified learnings written back to persistent memory

---

## 2. Architecture

```
 JIRA story (MCP)     Chat (ask/answer)     Spec files
          \                 |                  /
           v                v                 v
 +-------------------------------------------------------------+
 |                 QA LEAD (supervisor graph)                  |
 |  charter · routing · issue triage · re-planning · reporting |
 +-------------------------------------------------------------+
   |            |              |             |          |
   v            v              v             v          v
 ANALYSIS     DESIGN        EXECUTION    INVESTIGATION  KNOWLEDGE
 Spec Analyst Test Planner  Test Data    Failure Inv.   Reporter
 SF Intellig. Test Reviewer Runner(noLLM)Self-Healer    Learning Curator
 App Explorer Test Generator             Defect Judge   Eval Guardian
 Impact&Risk                             Auton. Explorer
   ^  all agents read/write  ---------------------------------------+
   |                                                                v
 SHARED MEMORY: LanceDB RAG · SQLite org knowledge graph · locator registry · evidence ledger · checkpoints
 ISSUE BUS: any error → Issue → QA Lead → retry | fallback | degrade | ask | escalate (hard stop only for safety)
```

Main graph (LangGraph.js, SQLite checkpointer):

```
START → intake → understand ⇄ clarify(interrupt) → discover → plan ⇄ review(pass 1) → build ⇄ review(pass 2)
      → execute → (failures? investigate → heal → execute (max 3) | judge → file_bug)
      → explore (time-boxed; new cases → plan → review → build → execute) → report → learn → END
Every node: resilientNode(); on Issue → qaLead.triage → route (retry/fallback/skip/ask/escalate)
```

---

## 3. Agents

| Agent | Squad | Model role | Skills | Main tools |
|---|---|---|---|---|
| QA Lead | supervisor | reasoning | qa-lead-playbook | all sub-graphs, chat, interrupt |
| Spec Analyst | analysis | reasoning | requirement-analysis | JIRA MCP, RAG |
| Salesforce Intelligence | analysis | fast | salesforce-platform | Salesforce DX MCP, jsforce Tooling API |
| Application Explorer | analysis | coder | salesforce-lightning-locators, salesforce-auth-personas | Playwright MCP |
| Impact & Risk Analyst | analysis | reasoning | salesforce-platform, test-design | knowledge graph, RAG |
| Test Planner | design | reasoning | test-design | RAG |
| Test Reviewer | design | judge | test-design, playwright-standards | RTM, evidence ledger, generated code (read-only) |
| Test Generator | design | coder | playwright-standards, salesforce-lightning-locators, salesforce-api-testing | fs, Playwright MCP (locator check) |
| Test Data Agent | execution | fast | salesforce-test-data, salesforce-auth-personas | jsforce, Salesforce MCP data toolset |
| Runner | execution | — (code) | — | `@playwright/test` CLI, Tooling API (debug logs) |
| Failure Investigator | investigation | reasoning | defect-investigation | SOQL, ApexLog, traces, Playwright MCP |
| Self-Healer | investigation | coder | salesforce-lightning-locators | Playwright MCP, locator registry |
| Defect Judge | investigation | judge | defect-investigation | Runner, evidence ledger |
| Autonomous Explorer | investigation | reasoning | exploratory-testing, salesforce-lightning-locators | Playwright MCP, RTM, risk model, RAG |
| Reporter | knowledge | fast | reporting | JIRA MCP, fs |
| Learning Curator + Eval Guardian | knowledge | judge | verified-learning | DeepEval sidecar, LanceDB |

Each agent folder: `src/agents/<name>/{graph.ts, prompt.md, schema.ts, tools.ts, index.test.ts}`.

---

## 4. Contracts (implement in `src/core/`)

```ts
// src/core/state.ts  (LangGraph Annotation.Root)
export interface QARunState {
  runId: string; storyKey?: string; org: string; autonomy: 'L1' | 'L2' | 'L3';
  source: SpecSource;                      // jira | chat | file
  story?: StorySnapshot;                   // raw story + ACs + links
  requirements: Requirement[];
  clarifications: Clarification[];         // question, answer | assumption, status
  charter?: TestCharter;                   // mission, risks, personas, scope, exitCriteria
  orgContext?: OrgContext;                 // components touched, personas, layouts
  impact?: ImpactReport;                   // dependencies, regression candidates, riskScores
  testCases: TestCase[];
  rtm: RtmRow[];                           // requirementId ↔ testCaseIds
  generated: GeneratedArtifact[];          // spec files, page objects, api tests
  dataPlan?: DataPlan; dataLedger: CreatedRecord[];
  results: TestResult[];
  investigations: Investigation[];         // hypotheses, experiments, verdict, confidence
  defects: DefectDraft[];
  evidence: EvidenceEntry[];               // claim, sources[], agent, confidence
  evalScores: EvalScore[];
  learnings: LearningCandidate[];
  issues: Issue[];
  status: 'RUNNING' | 'COMPLETE' | 'PARTIAL' | 'BLOCKED';
  budget: { tokensUsed: number; tokenLimit: number; startedAt: string; timeLimitMin: number };
}

// src/core/issues.ts
export type IssueKind = 'TRANSIENT' | 'TOOL_UNAVAILABLE' | 'AUTH' | 'AMBIGUOUS_SPEC' | 'INVALID_LLM_OUTPUT'
  | 'LOCATOR' | 'PRODUCT_DEFECT' | 'DATA' | 'ENVIRONMENT' | 'BUDGET' | 'HARD_STOP' | 'UNKNOWN';
export interface Issue { id: string; kind: IssueKind; node: string; message: string; detail?: unknown;
  attempts: number; resolution?: 'RETRIED' | 'FELL_BACK' | 'DEGRADED' | 'ASKED' | 'ESCALATED' | 'IGNORED';
  createdAt: string; }

// src/core/resilientNode.ts
export function resilientNode<S extends QARunState>(name: string,
  fn: (s: S, ctx: NodeCtx) => Promise<Partial<S>>): (s: S, ctx: NodeCtx) => Promise<Partial<S>>;
// - catches everything; HardStopError → status BLOCKED; others → Issue appended, returns partial update
// - classifies errors (classifyError) using error codes, HTTP status, MCP error shape, Zod errors
// - records duration + tokens to budget; emits a trace span

// src/core/modelRouter.ts
export interface ModelRouter { get(role: 'reasoning'|'coder'|'fast'|'judge'): BaseChatModel;
  withFallback(role): Runnable; embeddings(): Embeddings; }

// src/core/skillLoader.ts
export interface SkillLoader { list(): SkillMeta[];          // name + description from frontmatter
  load(name: string): Promise<string>;                       // full SKILL.md body
  reference(name: string, file: string): Promise<string>; }  // references/*.md
```

Key domain schemas (Zod, `src/core/schemas/`):

```ts
// Canonical requirement (every input adapter produces this)
Requirement { id /* stable, e.g. SF-1234-R03 */, businessObjective, actors[], personas[], preconditions[], actions[],
  businessRules[], expectedOutcomes[], dependencies[], dataRequirements[], risk: 'HIGH'|'MEDIUM'|'LOW',
  assumptions: { known[], unknown[] }, sources[{ type, ref, version, hash }],
  type: 'functional'|'validation'|'security'|'data'|'ui'|'integration'|'non-functional',
  status: 'EXECUTABLE'|'REVIEW_REQUIRED' /* no clear expected outcome → REVIEW_REQUIRED */ }

EvidenceLevel = 'APPROVED_REQUIREMENT'|'DECLARED_CONFIG'|'VERIFIED'|'OBSERVED_ONLY'|'UNKNOWN_OR_CONTRADICTORY'
ExpectedResult { text, evidenceLevel, evidenceIds[] }   // only the first three may become assertions

TestCase { id, title, requirementIds[], riskIds[], technique, persona, recordType?,
  type: 'functional'|'e2e'|'api'|'integration'|'security'|'negative'|'automation'|'bulk'|'data'|'visual'|'ui'|'a11y'|'perf'|'exploratory',
  priority: 'P0'|'P1'|'P2'|'P3', severity, preconditions[], dataRecipe?, steps[{ action, expected: ExpectedResult }], tags[],
  reviewStatus: 'APPROVED'|'REVIEW_REQUIRED'|'BLOCKED', snapshotId }

ResultState = 'PASS'|'FAIL'|'BLOCKED'|'SKIPPED'|'UNCERTAIN'
TestResult { testId, state: ResultState, reason?, evidenceIds[], environment: 'LIVE'|'FIXTURE'|'MOCK', snapshotId, runId }
// environment !== 'LIVE' must be shown as such in every report; never reported as a real Salesforce pass

Snapshot { id, orgId, capturedAt, sourceType: 'METADATA'|'UI_OBSERVATION'|'API_RESULT', release, persona?, components: ComponentVersion[] }
ComponentVersion { snapshotId, type, apiName, version?, hash, dataScope, evidenceStatus: 'DECLARED'|'OBSERVED'|'VERIFIED'|'UNKNOWN', reviewStatus }

Investigation { failureId, observations[], hypotheses[{ id, text, test, result, evidenceIds[] }],
  verdict: 'PRODUCT_DEFECT'|'PERMISSION_CONFIG'|'SCRIPT_LOCATOR'|'SCRIPT_TIMING'|'TEST_DATA'|'INVALID_REQUIREMENT_ASSUMPTION'
          |'STALE_KNOWLEDGE'|'ENVIRONMENT'|'FLAKY'|'UNKNOWN', confidence, status: 'SUSPECTED'|'CONFIRMED' }

DataWrite { idempotencyKey, runId, object, plannedFields, recordId?, state: 'PLANNED'|'SENT'|'CONFIRMED'|'UNCERTAIN'|'CLEANED' }
AuditEntry { at, runId, orgId, user, persona, action: 'observe'|'mutate', tool, object?, recordId?, before?, after?, approvalId? }
LearningCandidate { id, type: 'locator'|'org-quirk'|'defect-pattern'|'data-rule'|'design-heuristic'|'workflow-change'|'flaky',
  text, evidenceIds[], org, release, snapshotId, confidence, status: 'HYPOTHESIS'|'VERIFIED'|'RETIRED' }
```

---

## 5. Resilience policy (QA Lead)

`config/policy.yaml` maps `IssueKind` → ordered responses. Defaults:

| IssueKind | Responses (in order) |
|---|---|
| TRANSIENT | retry ×3 (exp. backoff 2s/8s/30s) → fallback tool → escalate |
| TOOL_UNAVAILABLE | fallback chain: Salesforce MCP → `sf` CLI → jsforce REST/Tooling; JIRA MCP → JIRA REST; Playwright MCP → skip exploration, use registry |
| AUTH | re-auth once → mark persona BLOCKED, continue others → escalate if all blocked |
| AMBIGUOUS_SPEC | ask (interrupt, timeout from config; L3 = no wait) → continue with flagged assumption |
| INVALID_LLM_OUTPUT | reflect-retry ×2 with Zod error → fallback model → degrade (skip item, record) |
| LOCATOR | route to investigate → heal (≤3 attempts) → mark test BLOCKED-SCRIPT |
| PRODUCT_DEFECT | judge → file/draft bug → continue |
| DATA | regenerate unique data → use approved fixture → mark test BLOCKED-DATA |
| ENVIRONMENT | wait + retry on schedule (3 × 5 min) → BLOCKED with report |
| BUDGET | stop new work → report PARTIAL |
| HARD_STOP | halt → report BLOCKED |

Hard stops: org ID not in `config/orgs.yaml`; identity check fails (wrong org/user/instance); a mutation the org
profile forbids; metadata deploy/change; a secret about to enter a prompt; cleanup of records without this run's tag.

The QA Lead's LLM may *reorder or choose* among allowed responses with a written reason (stored in evidence),
but may never pick a response not in the policy list.

---

## 6. Skills (`.claude/skills/`)

15 skills, same files for Claude Code (dev time) and runtime agents:
`qa-lead-playbook, requirement-analysis, salesforce-platform, salesforce-lightning-locators, salesforce-auth-personas,
salesforce-test-data, salesforce-api-testing, test-design, exploratory-testing, visual-testing, safety-and-approvals,
playwright-standards, defect-investigation, reporting, verified-learning`. Code enforcement accompanies every skill (see each SKILL.md "Enforcement" section).

---

## 7. Memory & RAG

- **LanceDB** tables: `requirements, org_metadata, test_assets, defects, learnings, locators, docs`.
  Each row: `id, text, vector, embedModel, org, release, type, sourceRef, createdAt, confidence?`.
- **Chunking** (`src/rag/chunkers/`): JIRA → per AC + summary; Confluence/docs → by heading 500–800 tokens,
  12% overlap; metadata → one chunk per component (object summary, field group of ≤25 fields, validation rule,
  flow, Apex class, permission set); tests/defects/learnings/locators → one per item.
- **Retrieval**: hybrid (vector + LanceDB FTS) with reciprocal-rank fusion, mandatory filters `org`, `release`
  where relevant, optional reranker; returns `{chunk, score, sourceRef}` for evidence citation.
- **Embeddings** via `ModelRouter.embeddings()`; model name stored per row; mismatch → `pnpm memory:reindex`.
- **Knowledge graph** (SQLite `graph.db`): `nodes(id, type, apiName, label, org, meta json)`,
  `edges(from, to, kind)`; filled from Tooling API `MetadataComponentDependency`, object describes, flow
  metadata, validation-rule formula parsing; impact = recursive CTE from touched fields/objects (depth ≤ 3).
- **Locator registry** (`locators` table + `tests/pages/*.ts`): page, element, persona, locator expression,
  strategy rank, lastVerifiedAt, verifiedBy (explorer | healer | human).
- **Evidence ledger** (`evidence.db`): every claim with sources and confidence; used in reports and chat "why?".

---

## 7a. Inputs (`src/inputs/`)

| Input | Adapter | Feeds |
|---|---|---|
| JIRA stories/ACs/links | Atlassian Rovo MCP → REST fallback | requirements, RAG |
| Azure DevOps work items (optional) | Azure DevOps MCP connector | requirements, RAG |
| Chat / plain-English story | REPL | requirements |
| Gherkin, Markdown, text, JSON, YAML | parsers | requirements |
| PDF, DOCX | `pdf-parse`, `mammoth` | requirements, RAG |
| Manual test cases (xlsx/csv) | `exceljs` | RTM as existing cases (Planner reuses + fills gaps) |
| Defect history, past results | JQL via Rovo MCP; past `results.json` | RAG, Risk Analyzer |
| Git diffs | `git diff` on the SFDX project → changed metadata components | impact, regression selection |
| Exploratory objective | chat | Autonomous Explorer charter |

---

## 7b. Salesforce auth, org profiles, browsers

- **API auth:** OAuth 2.0 JWT Bearer via one **External Client App** (Connected App creation is restricted since Spring '26).
  Certificate login → no MFA/passkey prompt; CI-safe. Each persona's test user is pre-approved on the ECA and authorized with
  `sf org login jwt --client-id <eca> --jwt-key-file <key> --username <user> --alias <alias>`.
- **Browser auth:** frontdoor URL from the same token (`sf org open --url-only --target-org <alias>`), saved per persona as
  `.auth/<persona>.json`. Isolated contexts only; never a personal browser profile.
- **Identity check before every run:** `SELECT Id, IsSandbox FROM Organization` + `/services/oauth2/userinfo` must match
  the org profile (org ID, user, instance URL). Mismatch = HARD_STOP.
- **Org profiles** (`config/orgs.yaml`, keyed by exact 18-char Org ID):

| Profile | Allowed | Blocked |
|---|---|---|
| `sandbox-qa` | everything within policy | hard stops |
| `dedicated-qa-prod` | production org with **only test data**: create/edit/delete any record data (incl. existing test data), full-size bulk, data resets; authorized once per Org ID; first live org for building scripts and testing the framework | metadata, permission changes, payments, real callouts, emails outside allowed domains; bulk delete > 200 existing records asks once |
| `prod-test-org` | create/edit/delete **only run-tagged records** as dedicated test users; one approval per run | metadata, bulk/mass ops, untagged deletes, permission changes, payments, real callouts, emails unless deliverability confirmed safe |
| `prod-readonly` | discovery, UI observation, SOQL | any mutation |

- **Browsers:** `config/execution.yaml` → `browser: chromium | chrome | msedge` (Playwright `channel`), headless default.
  Chromium is the CI default; local Chrome with Edge fallback for local runs. Playwright MCP uses the same setting.
- **Admin one-time setup** (document in `docs/setup/salesforce-auth.md`): create ECA, upload cert, pre-approve users,
  no "High Assurance session required" on test-user profiles, cert rotation reminder.

---

## 7c. Org knowledge snapshots (`src/knowledge/`)

- Every `qa discover` writes an immutable `Snapshot` + `ComponentVersion` rows (SQLite) with content hashes.
- `diff(prev, next)` by (type, apiName) → changed/added/removed/unknown. Never compare hashes of different artifact types.
- Changed components → Risk Analyzer (mandatory regression) and → mark linked locators, learnings, assumptions `RE_VERIFY`.
- Inaccessible components are stored `UNKNOWN`, never treated as missing.
- Lineage: TestResult → TestCase → (spec hash, snapshotId, browser observation ids).

---

## 7d. Security & approvals (`src/security/`)

- Every tool call tagged `observe` | `mutate`; `mutate` checked against org profile + policy + approvals.
- MCP tool **allow-list** (`config/mcp-tools.yaml`). Blocked by default: Playwright MCP `browser_evaluate`,
  `browser_run_code_unsafe`; Salesforce MCP deploy / metadata-write / anonymous Apex tools.
- `runs/<runId>/audit.jsonl` (AuditEntry per mutation). Redaction of PII before prompts, logs, reports.
- Idempotency key on every write; after a crash, `UNCERTAIN` writes are reconciled by querying the key before retry.
- Default blocks: payments, mass delete, bulk update of untagged records, permission/profile changes, real callouts.
- No screenshots / record data to an external model unless `allowExternalUpload: true` for the run.
- Human checkpoints (concise chat summaries): missing rules & unknown transitions; review-required expectations; new data
  recipe/mutation type; side-effect browser actions & high-risk exploration; behaviour-changing locator repairs; confirming
  bugs & external submission; publishing learnings; mutations on `prod-test-org`. Autonomy level picks which ones wait.

---

## 7e. Test data engine (`src/sf/data/`)

Recipe (`examples/recipes/*.yaml`) → read snapshot (required fields, relations, record types, picklists, validation rules) →
synthetic values (unique for duplicate rules) → validate full plan → approval if new → create in dependency order with
idempotency keys → read back & verify every record → ledger → reverse-order cleanup of run-owned records only →
re-query to verify cleanup → cleanup/reconciliation report. Negative data is only used to assert rejection.

---

## 7f. Expected-result oracles (`src/oracles/`)

Every `ExpectedResult` carries an `EvidenceLevel`. Only `APPROVED_REQUIREMENT`, `DECLARED_CONFIG`, `VERIFIED` may become
assertions. `OBSERVED_ONLY` needs review; `UNKNOWN_OR_CONTRADICTORY` makes the case `REVIEW_REQUIRED`. The LLM can never
create an expected result without evidence or change an assertion to make a test pass.

---

## 7g. Visual QA (`src/visual/`)

`toHaveScreenshot` baselines per page × persona × viewport (`qa visual approve`); masks for dates, IDs, spinners, names, PII;
local layout checks from element boxes (overlap, clipping, off-screen, hidden required controls, layout shift via
`PerformanceObserver`); loading/blank/error state detection; viewports desktop + 1–2 smaller; a11y (axe on custom LWCs,
labels, focus order). Differences = candidates in the visual-diff report; images go to the LLM only if allowed.

---

## 8. Test types → Playwright projects

`functional, e2e, api, integration, security, negative, automation, bulk, data (relationship/data integrity), visual, ui, a11y, perf`
(+ `exploratory` findings, promoted to scripted cases). New types plug in via `TestTypePlugin { tag, plannerRules, generatorTemplate, reportGroup }`.
Permission tests always run as the real persona (never inferred from metadata alone) and as a non-admin persona. — each a project in
`playwright.config.ts` selected by tag (`grep`). Personas = `storageState` per project dependency
(`auth.setup.ts` creates one state per persona from `config/personas.yaml`).

---

## 9. Evaluation (DeepEval sidecar)

`eval/` = Python 3.12 project managed by `uv` (`uv sync`). Interface: `uv run python -m qa_eval <task>.json`
→ writes `<task>.result.json`. TS wrapper: `src/eval/deepeval.ts` (`execa`, timeout, Issue on failure —
eval failure must **degrade**, not crash: mark gate as "unevaluated" and require human review in L2/L3).

Metrics & gates: see the table in the shareable doc and `.claude/skills/verified-learning/SKILL.md`.
Golden dataset: `eval/golden/<storyKey>/{story.json, requirements.json, cases.json, known_defects.json}`.

Metrics: requirement-extraction accuracy, test relevance, AC coverage, unsupported-assumption rate, retrieval relevance,
grounding, generation validity, defect-classification accuracy, false-positive / false-negative rates, locator-recovery
reliability, repeatability, autonomous action efficiency, cost. Modes: offline (mock model), offline Salesforce fixture,
approved real sandbox + real models.

Autonomy acceptance scenarios (`eval/scenarios/`): missing AC; contradictory rule; negative-case proposal; dependency
regression; asks for data instead of inventing; useful exploration steps; no revisiting finished states; respects
authorization; seeded functional defect; seeded visual regression; locator vs application defect; reproduction;
evidence-backed bug report; locator repair without assertion change; resume after interruption; no repeated uncertain
write; past defect raises regression priority.

---

## 10. Reporting

- `reporting-labs` (`npm i -D reporting-labs`, `npx reporting-labs init`), config in `reporting-labs.config.ts`:
  title, `outputFolder: runs/<runId>/reporting-labs`, `links.story` → JIRA, `maskKeys`, `dimensions:
  ['priority','severity','feature','owner','story']`, history on.
- Playwright `html` reporter (`open: 'never'`) + `json` reporter (consumed by Runner/Investigator).
- Every generated test calls `meta({...})` and uses `test.step()`; data via `testData()`, notes via `log()`.
- Reporter agent also writes: test-plan.md, test-cases.md, rtm.xlsx, test-design report (HTML), exploration report
  (HTML+JSON), defect reports, visual-diff report, impact & coverage summary, cleanup/reconciliation report, execution
  history, release-confidence assessment, JIRA comment. Results from FIXTURE/MOCK environments are always labelled.
- Defect publication to JIRA/ADO only with an approved project, field mapping and publication policy.

---

## 11. Build phases (tick as you complete)

Phases 0–5 give a working spec-in → test-out version proven on the offline fixture; 6–10 add visual QA, investigation,
learning, pipelines and hardening. Every phase: working code, unit + failure + security tests, typecheck, a demo, update
`docs/capability-matrix.md` (implemented / partial / blocked), commit.

### Phase 0 — Foundation
- [x] pnpm workspace, TS strict, ESLint, Prettier, Vitest, `cross-env`; Node LTS check
- [x] Config loaders with Zod: models, policy, personas, orgs (profiles), execution (browser), mcp-tools; `.env` + `keytar`
- [x] `ModelRouter`: google (`@langchain/google-genai`, **default**), anthropic, openai/azure-openai, ollama; **mock provider**;
      quotas, timeouts, token accounting, fallback; embeddings via `GoogleGenerativeAIEmbeddings` by default
- [x] `SkillLoader`, `Issue`, `classifyError`, `HardStopError`, `resilientNode`, budgets, pino, run folders
- [x] MCP client + **tool allow-list** + health checks; audit log; redaction utility; idempotency helper
- [x] **Tracing** (`src/observability/`): one OpenTelemetry `NodeTracerProvider` + LangChain/LangGraph instrumentation
      (instrument ONCE — never add both the Langfuse callback handler and OpenInference, or spans duplicate), with
      switchable span processors from `config/observability.yaml`: Langfuse (`@langfuse/otel` LangfuseSpanProcessor,
      primary, Langfuse Cloud keys from `.env`) and Phoenix (OTLP exporter, optional). Redaction runs before export; no
      screenshots in traces; exporter failure = warning only, never stops a run. Tag traces with runId, storyKey, org
      profile, agent, persona. `qa doctor` checks Langfuse reachability. (Langfuse's own skill from
      github.com/langfuse/skills may be used as reference, but these rules win.)
- [x] Offline Salesforce fixture skeleton (`examples/fixture/`: mock REST/SOQL + static Lightning-like pages)
- [x] `qa doctor`
- **Exit:** `qa doctor` green or each fallback explained; unit tests for router, resilience, allow-list, redaction pass.
- **Status (2026-11-20):** exit criteria met — see `docs/phase-0-notes.md` and `docs/capability-matrix.md`. Secret store uses
  `@napi-rs/keyring` (keytar-compatible) by operator decision.

### Phase 1 — Inputs & clarification
- [x] All input adapters (§7a) → canonical `Requirement`; `REVIEW_REQUIRED` status
- [x] Spec Analyst; clarify node with `interrupt()`; chat REPL; assumption handling
- [x] QA Lead skeleton + policy-driven triage
- **Exit:** a JIRA story and a PDF both produce validated requirements and ≥1 sensible question.
- **Status (2026-11-20):** exit criteria met on live Gemini with JIRA SF-219 and the Contact BRD PDF; see
  `docs/phase-1-notes.md`. ADO live input is blocked (no org). The Atlassian Rovo MCP path is tested with mocks only
  (REST was used live). Cross-source conflict detection depends on the model and varies between runs.

### Phase 2 — Salesforce intelligence
- [x] JWT via ECA, frontdoor sessions per persona, identity checks, org profiles enforced (start with `dedicated-qa-prod`)
- [x] Discovery (objects, fields, relationships, record types, picklists + dependencies, validation rules, Apex, Flows +
      versions, LWC + Aura, layouts/FlexiPages, profiles, permission sets + groups, FLS/CRUD, sharing, custom metadata/settings)
- [x] Snapshots + diff + lineage; knowledge graph; impact query
- [x] Application Explorer (Lightning + Experience Cloud), locator registry; RAG ingest (hash dedupe, incremental, resumable)
- **Exit:** a second discovery detects a changed validation rule and flags dependent tests; 3 pages in the registry.
- **Status (2026-11-20):** exit criteria met live on qa-prod (operator-edited `Contact.Phone_Must_Be_10_Digits` →
  `changed` → MTC-001, SF-219-R14/R36/R39 and 2 Phone locators RE_VERIFY; registry: account-record, contact-record,
  contact-new) and on the fixture; see `docs/phase-2-notes.md`. Experience Cloud explorer blocked (no Digital
  Experiences in qa-prod); non-admin personas blocked (no test users); API sessions use an in-process JWT grant
  because sf CLI redacts tokens.

### Phase 3 — Test planning
- [ ] Risk model (mandatory / recommended / optional regression; never drop AC coverage for low risk)
- [ ] Test Planner (all categories incl. e2e, integration, relationship, permission, visual); oracles with evidence levels
- [ ] Test Reviewer pass 1; test plan, cases, RTM, XLSX, test-design report
- **Exit:** every AC covered; every expectation evidence-labelled; Reviewer findings resolved or justified.

### Phase 4 — Generation & data
- [ ] Test Generator, page objects, Lightning helpers, locator ESLint rule + dry-run
- [ ] Test Reviewer pass 2 → APPROVED / REVIEW_REQUIRED / BLOCKED
- [ ] Data engine (§7e): recipes, approvals, idempotency, verify, reconcile, verified cleanup
- **Exit:** specs lint/typecheck/resolve; data created, verified, cleaned, cleanup confirmed.

### Phase 5 — Execution & reporting
- [ ] Runner (approved tests only), browser channel switch, result states incl. UNCERTAIN, LIVE/FIXTURE/MOCK labels
- [ ] reporting-labs + Playwright HTML + additional reports; JIRA comment
- **Exit:** Account → Contact demo (CLAUDE.md §Acceptance demo) passes end to end on the offline fixture, then live on
  the `dedicated-qa-prod` org.

### Phase 6 — Visual QA
- [ ] Baselines + masking + approve command; layout checks; states; viewports; a11y; visual-diff report
- **Exit:** seeded visual change reported as candidate; approving the baseline clears it.

### Phase 7 — Investigation, healing, exploration
- [ ] Failure Investigator (full taxonomy), Self-Healer (AST check: assertions unchanged; repairs auditable/reversible),
      Defect Judge, evidence ledger, defect reports
- [ ] Autonomous Explorer: visited/unvisited state map, evidence-gain step selection, approved actions only, stop conditions
- [ ] Fault-injection suite
- **Exit:** faults classified ≥ 4/5 correctly; no assertion changed by healer; Explorer finding → reviewed test case.

### Phase 8 — Verified learning & evaluation
- [ ] DeepEval sidecar + gates (scores also sent to Langfuse as Scores on the run's trace); golden dataset; autonomy acceptance scenarios (§9); learning lifecycle
- [ ] Learning + past defects feed test selection and priority
- **Exit:** baselines recorded; a learning and a past defect both change priority on a second run.

### Phase 9 — CI/CD & CLI
- [ ] Full `qa` command set; `ci/github-actions.yml`, `ci/azure-pipelines.yml`; nightly regression; PR impact runs;
      artifact retention; trend history; exit codes
- **Exit:** pipeline run with JWT auth produces reports with no human login.

### Phase 10 — Enterprise hardening
- [ ] Autonomy levels; `prod-test-org` flow with per-run approval (`dedicated-qa-prod` is enabled from Phase 2); Langfuse
      dashboards, alerts and DeepEval scores pushed as Langfuse Scores; multi-org; Azure DevOps connector;
      MCP chat server; documentation set (§13 of CLAUDE.md); capability matrix final
- **Exit:** Account → Contact demo passes in `dedicated-qa-prod` and the Full Copy sandbox; pilot definition of done met.

## 12. Open decisions (confirm with Rakesh before the related phase)

- DECIDED: Gemini default (switchable per role); Python OK; JWT via External Client App; browsers Chromium + Chrome + Edge;
  prod-test-org profile for production orgs with real data; dedicated-qa-prod profile for the production org holding only
  test data (first live target).
- ~~Who creates the ECA and pre-approves test users?~~ DONE for qa-prod (Rakesh created the ECA; JWT works). Non-admin test users still open.
- Which production org IDs (if any) get `prod-test-org`? — Phase 10

- ~~JIRA MCP choice~~ DECIDED: Atlassian Rovo MCP Server (OAuth locally, admin-enabled API token for CI)
- ~~Salesforce DX MCP preview/beta~~ DECIDED: OK, `--allow-non-ga-tools` enabled; fallback sf CLI → jsforce
- First sandbox + personas + test users ownership — Phase 2
- Can devs add `data-testid` to custom LWCs? — Phase 4
- ~~Model per role~~ DECIDED: Gemini default for all roles + embeddings, any role switchable in config/models.yaml. Check Gemini data-use terms for the paid API tier before sending Full Copy data.
- ~~Tracing~~ DECIDED: Langfuse Cloud (Hobby) primary, keys in .env; Phoenix optional local exporter for sensitive runs
