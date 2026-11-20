# Requirements registry (cumulative)

Every requirement from CLAUDE.md / PLAN.md, where it is satisfied and how it is verified. Rows are added each phase;
nothing is removed (status changes instead).

| ID | Requirement | Source | Phase | Status | Implementation | Verification |
|---|---|---|---|---|---|---|
| R-001 | TypeScript strict; no `any` except at MCP boundaries | CLAUDE.md 1 | 0 | met | `tsconfig.json`, `eslint.config.js` (`src/mcp/boundary/**` exempt) | `pnpm typecheck`, `pnpm lint` |
| R-002 | Every agent output Zod-validated | CLAUDE.md 2 | 0–1 | partial | Contracts in `src/core/schemas/`; agent reflect-retry loop is Phase 1 | `schemas.test.ts`; router structured-output + fallback test |
| R-003 | No node throws out of the graph | CLAUDE.md 3 | 0 | met | `src/core/resilientNode.ts` | `resilience.test.ts` (Errors, TypeErrors, strings, sync throws) |
| R-004 | Hard stops → BLOCKED | CLAUDE.md 4 | 0 | met (mechanism) | `HardStopError`; secret-in-prompt guard; mutation guard can hard-stop | `resilience.test.ts`, `router.test.ts`, `mcp.test.ts` |
| R-005 | Generated tests run by Playwright Test, not MCP | CLAUDE.md 5 | 5 | planned | — | — |
| R-006 | Locator rules + `sf-locators/no-fragile-locators` | CLAUDE.md 6 | 4 | planned (`waitForTimeout` already banned by lint) | `eslint.config.js` | — |
| R-007 | Healing never changes assertions | CLAUDE.md 7 | 0/7 | partial | policy schema forces `allowAssertionChanges: false` | `loader.test.ts` |
| R-008 | Model access only via `ModelRouter.get(role)`; judge ≠ coder | CLAUDE.md 8 | 0 | met | `src/models/`; ESLint `no-restricted-imports` outside `src/models/providers` | `router.test.ts`, `loader.test.ts`, lint |
| R-009 | Skills via SkillLoader; descriptions in prompt, bodies on demand | CLAUDE.md 9 | 0 | met | `src/skills/skillLoader.ts` | `skillLoader.test.ts` |
| R-010 | Secrets from env / Credential Manager only; never logged / in prompts | CLAUDE.md 10 | 0 | met | `secretStore.ts`, `redact.ts`, logger censoring, router guard, doctor output redaction | `env.test.ts`, `security.test.ts`, `router.test.ts`, `doctor.test.ts` |
| R-011 | Windows first; paths with spaces | CLAUDE.md 11 | 0 | met | `node:path`, cross-spawn, PowerShell-friendly scripts | CLI e2e + run folder + MCP stdio tests use folders with spaces |
| R-012 | Never fabricate; evidence levels | CLAUDE.md 12 | 0/3 | partial | `EvidenceLevel`, `isAssertable`, TestCase refinement; model ids suggested from the live list, never invented | `schemas.test.ts` |
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
