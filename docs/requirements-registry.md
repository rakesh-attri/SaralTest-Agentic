# Requirements registry (cumulative)

Every requirement from CLAUDE.md / PLAN.md, where it is satisfied and how it is verified. Rows are added each phase;
nothing is removed (status changes instead).

| ID | Requirement | Source | Phase | Status | Implementation | Verification |
|---|---|---|---|---|---|---|
| R-001 | TypeScript strict; no `any` except at MCP boundaries | CLAUDE.md 1 | 0 | met | `tsconfig.json`, `eslint.config.js` (`src/mcp/boundary/**` exempt) | `pnpm typecheck`, `pnpm lint` |
| R-002 | Every agent output Zod-validated | CLAUDE.md 2 | 0–1 | met | `runStructured()` (Zod + deterministic checks, reflect-retry ×2, fallback model, then INVALID_LLM_OUTPUT) | `structured.test.ts`, `spec-analyst/index.test.ts`, `pnpm validate:analysis` |
| R-003 | No node throws out of the graph | CLAUDE.md 3 | 0–1 | met | `src/core/resilientNode.ts`; every graph path ends at `report` (also when BLOCKED) | `resilience.test.ts`, `mainGraph.test.ts` |
| R-004 | Hard stops → BLOCKED | CLAUDE.md 4 | 0 | met (mechanism) | `HardStopError`; secret-in-prompt guard; mutation guard can hard-stop | `resilience.test.ts`, `router.test.ts`, `mcp.test.ts` |
| R-005 | Generated tests run by Playwright Test, not MCP | CLAUDE.md 5 | 5 | planned | — | — |
| R-006 | Locator rules + `sf-locators/no-fragile-locators` | CLAUDE.md 6 | 4 | planned (`waitForTimeout` already banned by lint) | `eslint.config.js` | — |
| R-007 | Healing never changes assertions | CLAUDE.md 7 | 0/7 | partial | policy schema forces `allowAssertionChanges: false` | `loader.test.ts` |
| R-008 | Model access only via `ModelRouter.get(role)`; judge ≠ coder | CLAUDE.md 8 | 0 | met | `src/models/`; ESLint `no-restricted-imports` outside `src/models/providers` | `router.test.ts`, `loader.test.ts`, lint |
| R-009 | Skills via SkillLoader; descriptions in prompt, bodies on demand | CLAUDE.md 9 | 0–1 | met | `src/skills/skillLoader.ts`; agents get `load_skill` through `runStructured` | `skillLoader.test.ts`, `structured.test.ts` |
| R-010 | Secrets from env / Credential Manager only; never logged / in prompts | CLAUDE.md 10 | 0 | met | `secretStore.ts`, `redact.ts`, logger censoring, router guard, doctor output redaction | `env.test.ts`, `security.test.ts`, `router.test.ts`, `doctor.test.ts` |
| R-011 | Windows first; paths with spaces | CLAUDE.md 11 | 0 | met | `node:path`, cross-spawn, PowerShell-friendly scripts | CLI e2e + run folder + MCP stdio tests use folders with spaces |
| R-012 | Never fabricate; evidence levels | CLAUDE.md 12 | 0/1/3 | met (for design) | Phase 1: cited refs/personas must exist, assumptions flagged. Phase 3: every expectation carries a code-assigned evidence level; grounding check rejects values not in evidence; must-cite evidence stops favourable-subset citations; VERIFIED never assigned before execution | `oracles.test.ts`, `test-planner/index.test.ts`, `pnpm validate:design`, live runs (phase-3-notes) |
| R-013 | FIXTURE/MOCK labelled everywhere | CLAUDE.md 13 | 0 | met (foundation) | `TestResult.environment`, mock model metadata, fixture header + banner, `offline-fixture` profile | `fixture.test.ts`, `router.test.ts` |
| R-014 | observe/mutate tagging, allow-list, audit, PII redaction | CLAUDE.md 14 | 0 | met (org-profile policy in Phase 2) | `src/mcp/`, `src/security/` | `mcp.test.ts`, `security.test.ts` |
| R-015 | Prefer deterministic checks | CLAUDE.md 15 | 3+ | met (design) | Obligations, risk, tiers, priority, levels, status, Reviewer checklist and settlement are deterministic; the model only drafts wording and adds judge findings | `impact-risk/index.test.ts`, `test-reviewer/index.test.ts` |
| R-016 | Track status honestly | CLAUDE.md 16 | 0 | met | `docs/capability-matrix.md`, this file | review |
| R-017 | Tracing: one instrumentation, switchable exporters, redact first, no screenshots, failures = warnings | CLAUDE.md 17 | 0 | met | `src/observability/` | `tracing.test.ts` |
| R-018 | Small commits; unit tests per module; MCP/SF mocked | CLAUDE.md 18 | 0 | met | one commit per task on `phase-0-foundation` | `git log`; 170 unit tests |
| R-019 | `qa doctor`: env, browsers, providers, MCP, SF identity, Python sidecar | CLAUDE.md commands; PLAN §11 P0 | 0 | met | `src/doctor/` | `doctor.test.ts`, CLI e2e, manual run (phase-0-notes) |
| R-020 | Resilience policy map with no Issue type lacking a policy entry | PLAN §5; CLAUDE.md DoD | 0 | met | `PolicyConfig` refinement | `loader.test.ts` |
| R-021 | Org selected by exact 18-char Org ID | PLAN §7b | 0 | met (schema) | `OrgId18` | `loader.test.ts` |
| R-022 | MCP allow-list; Playwright evaluate/run_code_unsafe + SF deploy/metadata write blocked | PLAN §7d | 0 | met | `config/mcp-tools.yaml` | `mcp.test.ts`, live `qa doctor` |
| R-023 | Idempotency key on every write; reconcile UNCERTAIN before retry | PLAN §7d | 0 | met (mechanism) | `WriteLedger` | `security.test.ts` |
| R-024 | Offline fixture skeleton | PLAN §11 P0 | 0 | met | `examples/fixture/`, `src/fixture/` | `fixture.test.ts`, manual browser check |
| R-025 | Gemini default; embeddings via Google by default | PLAN §11 P0, §12 | 0 | met (ids pending) | `providers/index.ts` | `router.test.ts` |
| R-026 | Browser channel switch chromium / chrome / msedge | PLAN §7b | 0/5 | partial | doctor probes all three; Runner switch is Phase 5 | doctor output |
| R-027 | All §7a inputs → canonical `Requirement`; `REVIEW_REQUIRED` status | PLAN §7a, §11 P1 | 1 | met (ADO live blocked; Rovo MCP tested with mocks only) | `src/inputs/`, `src/agents/spec-analyst/` | `adapters.test.ts`, `spec-analyst/index.test.ts`, live runs (phase-1-notes) |
| R-028 | Requirement ids stable; sources carry type/ref/version/hash/section | PLAN §4 | 1 | met | `ids.ts`, `refs.ts` | `spec-analyst/index.test.ts` |
| R-029 | Ambiguity / conflict / gap detection; ≤5 questions per round, most important first, each with test impact | requirement-analysis skill; policy.yaml | 1 | met (quality depends on the model) | `lint.ts`, `graph.ts`, `prompt.md` | tests + answer-key scoring in phase-1-notes |
| R-030 | Clarify node with `interrupt()`; assumption handling (L3 / timeout / no input → flagged assumption) | PLAN §11 P1, §5 AMBIGUOUS_SPEC | 1 | met | `src/graph/mainGraph.ts` | `mainGraph.test.ts`, CLI e2e, manual kill/resume check |
| R-031 | Chat REPL | PLAN §7a, CLAUDE.md commands | 1 | met | `src/cli/chat.ts` | `analyze.test.ts` |
| R-032 | QA Lead triage picks only policy responses; may reorder them with a reason, never add one | PLAN §5 | 1 | met | `src/agents/qa-lead/triage.ts` | `qa-lead/index.test.ts` |
| R-033 | `qa analyze`, `qa resume`, `qa chat` print what they do, why something is blocked and where output went | CLAUDE.md commands | 1 | met | `src/cli/` | `cli.e2e.test.ts` |
| R-034 | Checkpointed runs resumable across processes | PLAN §2 (SQLite checkpointer) | 1 | met | `src/graph/checkpointer.ts` | `checkpointer.test.ts`, `analyze.test.ts`, manual check |
| R-035 | MOCK / mechanical analysis labelled everywhere | CLAUDE.md 13 | 1 | met | report banners, `analysisEnvironment`, evidence `environment` | `mainGraph.test.ts`, CLI e2e |
| R-036 | JWT via External Client App; no passwords/MFA; tokens never logged or in prompts | PLAN §7b, CLAUDE.md 10 | 2 | met | `src/sf/auth/sfCli.ts` (in-process JWT grant, Redactor), `ensureStorageState` | `auth.test.ts`, live `qa auth status` |
| R-037 | Identity check before Salesforce work; mismatch / unlisted org = HARD_STOP | PLAN §7b, CLAUDE.md 4 | 2 | met | `src/sf/identity.ts`, `connectSalesforce` | `identity.test.ts`, doctor live check |
| R-038 | Org profiles enforced on every mutation (dedicated-qa-prod first); metadata writes hard stop; audit per mutation | PLAN §7b/§7d, CLAUDE.md 14 | 2 | met (no live mutation yet) | `src/security/orgPolicy.ts`, `GuardedSalesforce`, `createSalesforceHub` | `orgPolicy.test.ts`, `identity.test.ts` |
| R-039 | Discovery of the §11 P2 component list; inaccessible = UNKNOWN, never missing | PLAN §11 P2, §7c | 2 | met | `src/sf/discovery/` | `discovery.test.ts`, live qa-prod |
| R-040 | Immutable snapshots + diff by (type, apiName); no cross-type hash comparison; lineage | PLAN §7c | 2 | met | `src/knowledge/` | `knowledge.test.ts` |
| R-041 | Knowledge graph (SQLite) + impact by recursive CTE depth ≤ 3, edges cited as evidence | PLAN §7, salesforce-platform skill | 2 | met | `src/sf/graph/` | `graph.test.ts` |
| R-042 | Changed components mark linked locators / requirements / tests RE_VERIFY | PLAN §7c | 2 | met | `impactOfDiff`, `SnapshotStore.markReverify`, `LocatorRegistry.markReverify` | `graph.test.ts`, `sf-intelligence/index.test.ts`, live demo |
| R-043 | Requirements cross-checked against the org (requirement-analysis step 4), questions in skill format | requirement-analysis skill | 2 | met | `src/agents/sf-intelligence/crossCheck.ts` | `sf-intelligence/index.test.ts`, live cross-check |
| R-044 | Application Explorer + locator registry; skill ranking; no XPath / generated ids / nth | PLAN §3, locators skill | 2 | met (Lightning); Experience Cloud blocked | `src/agents/app-explorer/`, `locatorRegistry.ts` | `app-explorer/index.test.ts`, live 3 pages |
| R-045 | RAG ingest: hash dedupe, incremental, resumable; hybrid retrieval with RRF and org filter; embed model per row | PLAN §7, §11 P2 | 2 | met | `src/rag/` | `rag.test.ts`, live ingest |
| R-046 | Fixture results labelled FIXTURE everywhere (snapshots, reports, locators, evidence) | CLAUDE.md 13 | 2 | met | `environment` on snapshots/checks/locators; report banner | tests + fixture demo |
| R-047 | Risk model: mandatory / recommended / optional; never drop AC coverage for low risk | PLAN §11 P3, test-design skill | 3 | met | `src/agents/impact-risk/risk.ts`, `tierObligations` | `impact-risk/index.test.ts` ("a low risk never removes AC coverage"), live RISK-08 |
| R-048 | Test Planner covers all categories (functional, negative, boundary, permission allow/deny, bulk, ui, nfr, regression) | PLAN §11 P3 | 3 | met (visual / integration only when a requirement asks; none in SF-219) | `obligations.ts`, `test-planner/` | `test-planner/index.test.ts`, live runs |
| R-049 | Oracles: every expected result has an evidence level; only APPROVED_REQUIREMENT / DECLARED_CONFIG / VERIFIED may become assertions | PLAN §7f | 3 | met | `src/oracles/`, `TestCase` superRefine | `oracles.test.ts`, `schemas.test.ts`, `pnpm validate:design` |
| R-050 | Test Reviewer pass 1 (skill checklist), findings fixed or justified, max 2 rounds, then QA Lead decides | test-design skill, PLAN §11 P3 | 3 | met | `src/agents/test-reviewer/` | `test-reviewer/index.test.ts`, `design.test.ts` |
| R-051 | Judge role is a different model than coder | CLAUDE.md 8 | 3 | met (fallback also ≠ coder) | `config/models.yaml` judge = gemini-3.1-pro-preview → flash-lite fallback | `loader.test.ts`; live labels `judge=… (fallback)` |
| R-052 | Test plan, test cases, RTM (JSON + XLSX), test-design report; MOCK / mechanical / FIXTURE labelled | PLAN §10, §11 P3, CLAUDE.md 13 | 3 | met | `src/graph/designReport.ts` | `design.test.ts` (XLSX sheets, banners) |
| R-053 | Permission tests run as the real non-admin persona, never inferred; missing persona → BLOCKED-NO-PERSONA | PLAN §8, salesforce-auth-personas | 3 | met | `personas.ts`, `caseStatus`, planner persona check | `impact-risk/index.test.ts`, `test-planner/index.test.ts` |
| R-054 | `qa design` / `qa review` print what they do, why something is blocked and where output went | CLAUDE.md commands | 3 | met | `src/cli/design.ts` | `design.e2e.test.ts` (path with spaces) |
| R-055 | Graph nodes never throw; plan/review degrade or block via triage; every path ends at report | CLAUDE.md 3 | 3 | met | `designNodes.ts`, `mainGraph.ts` | `design.test.ts` (failing hook → PARTIAL report) |
| R-056 | OpenAI-compatible provider (base URL + key) with NVIDIA NIM and Groq presets; keys only to https or localhost | Operator 2026-11-20 | pre-4 | met (live 2026-11-21) | `src/models/endpoints.ts`, `providers/index.ts`, `schemas.ts` | `chain.test.ts`, `doctor.test.ts` |
| R-057 | Per-provider rate limits (requests and tokens per minute) | Operator 2026-11-20 | pre-4 | met | `src/models/rateLimiter.ts`, `quotas:` in models.yaml | `chain.test.ts` (fake clock) |
| R-058 | Automatic fallback to the next provider on 429 (no repeated calls to a cooling-down provider) | Operator 2026-11-20 | pre-4 | met | `guarded.ts` (Retry-After cooldown), `router.ts` chains, `runStructured` | `chain.test.ts`, live forced failover (`nim-failover-1`) |
| R-059 | Role layout: reasoning + judge NIM; coder NIM → Groq; fast Groq; Gemini last for all; judge and coder from different families | Operator 2026-11-20 | pre-4 | met | `config/models.yaml`; family check in `qa doctor`; judge never shares a model with any coder chain entry (schema) | `loader.test.ts`, `chain.test.ts`, `qa doctor` |
| R-060 | Embeddings stay on Gemini, no re-index | Operator 2026-11-20 | pre-4 | met | `embeddings:` unchanged | `qa doctor` |
| R-061 | `qa doctor` lists available models per provider | Operator 2026-11-20 | pre-4 | met (live: Google, NIM, Groq) | `src/models/listModels.ts`, `src/doctor/checks/models.ts` | `doctor.test.ts` |
| R-062 | DeepEval uses the judge role through the same OpenAI-compatible endpoints | Operator 2026-11-20 | pre-4 | partial (judge model ready; runner Phase 8) | `src/eval/judgeEndpoint.ts`, `eval/qa_eval/judge_model.py` | `judgeEndpoint.test.ts`, `eval/tests/test_judge_model.py` |
