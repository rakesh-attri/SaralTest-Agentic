# Phase 0 notes — Foundation

Branch `phase-0-foundation`, one commit per task (T1–T11). Exit criterion (PLAN.md §11): `qa doctor` green or each
fallback explained; unit tests for router, resilience, allow-list and redaction pass.

## What was built

| Task | Result | Main files |
|---|---|---|
| T1 Tooling | pnpm workspace, TS strict, ESLint strict-type-checked, Prettier, Vitest, `qa` bin launcher | `package.json`, `eslint.config.js`, `bin/qa.mjs` |
| T2 Contracts + config | Zod contracts for PLAN §4; loaders for all 7 config files; `.env` loader; secret store | `src/core/schemas/`, `src/config/`, `src/security/secretStore.ts` |
| T3 Resilience | `classifyError`, `Issue`, `HardStopError`, `resilientNode`, budgets, retry, logger, run folders | `src/core/` |
| T4 ModelRouter | roles → providers (lazy), guarded calls, fallback, mock provider, model listing + suggestions | `src/models/` |
| T5 SkillLoader | list/load/reference, `load_skill` tool | `src/skills/` |
| T6 Security | redaction, audit log, idempotency ledger | `src/security/` |
| T7 MCP | client, allow-list, health, deny-by-default mutation guard; real tool names classified | `src/mcp/`, `config/mcp-tools.yaml` |
| T8 Tracing | OTel provider, OpenInference LangChain instrumentation, Langfuse/Phoenix, redacting processor | `src/observability/` |
| T9 Fixture | mock REST/SOQL, Lightning-like Account page with New Contact flow, two personas | `src/fixture/`, `examples/fixture/` |
| T10 Doctor | 13 checks, `--offline/--live/--include-oauth/--json`, `qa mcp tools`, `qa fixture serve` | `src/doctor/`, `src/cli/` |

## Decisions and deviations

- **Secret store:** `@napi-rs/keyring` instead of `keytar` (archived, no Node 26 prebuilds). Same Windows Credential
  Manager storage; service name `sf-qa-agent`, account = env key name. Approved by the operator before work began.
- **TypeScript 6.0.x**, not 7: typescript-eslint 8.73 supports `<6.1`.
- **OpenTelemetry versions** pinned to the `@opentelemetry/api` 1.9 / exporters 0.2xx line that `@langfuse/otel` 6
  requires (the newest exporters need api 1.10).
- **No `cmd /c` wrapper for `npx`:** the MCP SDK spawns with `cross-spawn`, which resolves `.cmd` shims on Windows.
  The SDK also passes only a minimal environment, so our API keys are not handed to MCP servers.
- **Legacy SSE MCP transport not supported** (deprecated in the SDK); stdio + streamable HTTP only.
- **Mutations through MCP are denied by default** until Phase 2 plugs in org-profile enforcement.
- **Salesforce MCP has no record-write tools** with the configured toolsets — test-data writes will go through jsforce
  behind the same guard (Phase 2/4).
- **Model ids:** never guessed. `qa doctor` lists the models the key can use and suggests the newest *stable* id per
  role, plus newer preview ids as alternatives. The operator confirms.
- **Fixture org** `00DFIXTURE00000001` with profile `offline-fixture` and `environment: FIXTURE` added to
  `config/orgs.example.yaml` (and the operator's untouched copy).
- Values in `.env` that still contain a `<placeholder>` are treated as unset.

## Manual checks (documented per CLAUDE.md definition of done)

1. `pnpm qa doctor` (online) on this machine — 15 OK, 6 WARN, 0 FAIL; both local MCP servers connected (Playwright
   25 tools, Salesforce 13 tools) and their tool lists match `config/mcp-tools.yaml` exactly; Langfuse Cloud reachable
   with the configured keys; Chromium, Chrome and Edge all launch headless.
2. `pnpm qa fixture serve` + in-app browser: frontdoor session → Account page → **New** → Save without Last Name shows
   "We hit a snag." and "Complete this field." → enter Last Name → toast `Contact "Ada Lovelace" was created.`,
   related list count 1 → 2. Independent SOQL check:
   `SELECT Id, AccountId, Account.Name FROM Contact WHERE LastName='Lovelace'` → `AccountId = 001FX0000000001AAA`
   (FIXTURE evidence only).

## Model configuration (after the exit check)

Operator choices, verified with `pnpm qa doctor --live` (18 OK, 3 WARN, 0 FAIL; all four roles answered):

| Role | Model | Why |
|---|---|---|
| reasoning, coder, fast | `gemini-3.5-flash-lite` | operator choice |
| reasoning fallback | `gemini-3.1-flash-lite` | `gemini-3.8-flash` does not answer on this key |
| judge | `gemini-3.1-flash-lite` | temporary: must differ from coder (rule 8); Pro models unavailable on the free tier |
| embeddings | `gemini-embedding-2` | live-tested (3072-dim vectors) |

Live probes of the key (free tier): `gemini-2.5-pro` → 404 "no longer available to new users" although it is
*listed*; `gemini-3.1-pro-preview` → 429 with free-tier quota **0**; `gemini-3.5…3.8-flash` → no answer within 30 s;
`gemini-2.5-flash` → error; `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite` → OK in ~2 s. Lesson built into the doctor:
a model being listed is not proof it can be called — use `--live`.

## Open items for the operator

See `docs/capability-matrix.md` → *External prerequisites*: Gemini billing (Pro judge + data-use terms),
Atlassian `/v2/mcp`, and (Phase 2) org IDs + External Client App. `JIRA_BASE_URL` is now set and REST auth works.

## Known limitations

- PII redaction masks personal names only in known fields, not in free text.
- Providers other than Google and mock are constructed but not live-tested (no keys).
- Fixture SOQL is a small subset; anything else returns `MALFORMED_QUERY` on purpose.
- A model-call timeout frees the caller, but the Google SDK keeps the HTTP request running in the background until it
  ends (seen as a process that lingers after timeouts).
- The judge runs on a small model until billing is enabled; reviewer/defect-judge quality is limited accordingly.
