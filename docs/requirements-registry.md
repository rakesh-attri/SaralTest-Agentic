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
| R-012 | Never fabricate; evidence levels | CLAUDE.md 12 | 0/1/3 | partial | Phase 1: cited section refs and personas must exist; completeness check; assumptions stay flagged and are never promoted; the prompt forbids invented values in assumptions. Evidence levels for expected results arrive in Phase 3 | `schemas.test.ts`, `spec-analyst/index.test.ts` |
| R-013 | FIXTURE/MOCK labelled everywhere | CLAUDE.md 13 | 0 | met (foundation) | `TestResult.environment`, mock model metadata, fixture header + banner, `offline-fixture` profile | `fixture.test.ts`, `router.test.ts` |
| R-014 | observe/mutate tagging, allow-list, audit, PII redaction | CLAUDE.md 14 | 0 | met (org-profile policy in Phase 2) | `src/mcp/`, `src/security/` | `mcp.test.ts`, `security.test.ts` |
| R-015 | Prefer deterministic checks | CLAUDE.md 15 | 3+ | planned | — | — |
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
