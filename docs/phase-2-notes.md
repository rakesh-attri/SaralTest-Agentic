# Phase 2 notes: Salesforce intelligence

Built on `main` after Phase 1 was fast-forwarded into it (the Phase 1 branch is kept; its worktree was removed). There
is one commit per task, T0–T9.

**Exit criterion (PLAN.md §11):** a second discovery detects a changed validation rule and flags dependent tests, and
3 pages are in the registry. **Met, live on qa-prod and on the offline fixture.** The evidence is under
*Exit proof* below.

## What was built

| Task | Result | Main files |
|---|---|---|
| T0 Setup | Phase 1 merged; deps `jsforce`, `@lancedb/lancedb`, `apache-arrow`, `playwright`; LanceDB's optional native install scripts denied; qa-prod `release` = Winter '27; Salesforce MCP points at `qa-prod` | `package.json`, `pnpm-workspace.yaml` |
| T1 Auth | JWT via the External Client App; frontdoor storageState per persona (`.auth/<org>/<persona>.json`); login/MFA page → AUTH; foreign host → IDENTITY_MISMATCH | `src/sf/auth/` |
| T2 Identity + policy | identity check (Organization + userinfo + instance + IsSandbox per profile); org-profile MutationGuard; GuardedSalesforce with write-ahead audit; Salesforce MCP hub with guard; `qa auth status\|login`; doctor live identity check | `src/sf/identity.ts`, `src/security/orgPolicy.ts`, `src/sf/client.ts`, `src/sf/hub.ts`, `src/doctor/checks/identity.ts` |
| T3 Discovery | every area in the §11 P2 list + MetadataComponentDependency; unreadable area → UNKNOWN; fixture Tooling metadata + changed-VR variant | `src/sf/discovery/`, `src/fixture/metadata.ts`, `examples/fixture/metadata*.json` |
| T4 Snapshots | immutable snapshots, type-prefixed hashes, diff, lineage, RE_VERIFY marks | `src/knowledge/` |
| T5 Graph | SQLite graph, recursive-CTE impact (depth ≤ 3, edge path as evidence), deterministic asset linking | `src/sf/graph/` |
| T6 Cross-check + node | deterministic org cross-check of requirements; `discover` node in the main graph; `qa discover`; `qa analyze --org` | `src/agents/sf-intelligence/`, `src/graph/mainGraph.ts`, `src/cli/discover.ts` |
| T7 Explorer | Lightning Application Explorer + locator registry; `qa locators discover\|list`; `qa discover --ui` | `src/agents/app-explorer/`, `src/knowledge/locatorRegistry.ts` |
| T8 RAG | LanceDB chunkers/store/manifest; hybrid retrieval with RRF; `qa ingest` | `src/rag/`, `src/cli/ingest.ts` |
| T9 Demo + docs | live + fixture proof; fixes listed below; docs | this file, `docs/setup/salesforce-auth.md`, `docs/knowledge-graph.md`, `docs/rag-guide.md` |

Tests: **317 passing** in 30 files (Phase 1 had 246). `pnpm typecheck`, `pnpm lint` and `pnpm test` are green after
every task.

## Decisions and deviations

- **API sessions use an in-process JWT Bearer grant**, not `sf org display`. sf CLI 2.159 prints `[REDACTED]`
  instead of access tokens in `--json` output.
  - The grant uses the same ECA client id and private key.
  - The token stays in memory, is registered with the Redactor, and is renewed once on `INVALID_SESSION_ID`.
  - `sf org login jwt` keeps the alias for the browser frontdoor and the Salesforce DX MCP server.
- **The Explorer uses the Playwright library** (isolated context + frontdoor state), not step-by-step Playwright MCP.
  It is deterministic, needs no model, and avoids the blocked `browser_evaluate`.
- **"Dependent tests" in Phase 2** are the test assets that exist so far: Phase 1 manual tests, requirements and
  registry locators.
  - Requirements and manual tests link to fields by deterministic word-bounded label or API-name matching, inside the
    objects the text names; the matched term is kept as edge evidence.
  - Locators link explicitly.
  - Generated specs join in Phase 4.
- **The cross-check is deterministic** and does not use the planned optional LLM wording step. Questions come from
  templates in the skill format, so no org fact or question depends on a model.
- **Fixture identity:** `personas.yaml` usernames belong to the live org. For a FIXTURE org, the expected user is the
  seed user mapped to the persona id. Live orgs still compare against the configured username.
- **A stale fixture server** (PID 9904, started at 13:13, before this work) holds port 4545. I did not stop a process
  I had not started. The CLI fixture demo ran from an isolated copy of the config on port 4546.

## Fixes from the live demo

Each fix is generic and has a test:

1. **Explorer read Related-tab elements after switching to Details**, so they were hidden. The Contacts › New button
   was missing. Each page state is now prepared right before it is read.
2. **The UI label differs from the describe label** in qa-prod: Phone shows as "Phone" but is labelled
   "Business Phone"; "Account Name" is `AccountId`. Field matching now tries label → label without " ID" → API name →
   relationship name, and records which basis matched.
3. **The Gemini free-tier quota (HTTP 429) was swallowed by LangChain** as empty vectors, and LanceDB refused them.
   `checkVectors()` now turns empty, NaN or ragged vectors into a TRANSIENT error. Ingest retries with backoff at a
   rate the quota allows. The first failed ingest resumed: 327 resumed, 96 skipped, nothing re-embedded twice.
4. **The cross-check claimed NOT_FOUND although the fields area was UNKNOWN** (seen against the stale fixture server).
   Scope objects now come from the snapshot header, so an unreadable scope gives UNKNOWN plus a question.
5. **A format rule was counted as "required"**: `AND(NOT(ISBLANK(Phone)), …)` only fires when Phone is filled in.
   `blocksBlank()` ignores negated blank tests.
6. **A Zod error from an unexpected response shape was labelled `INVALID_LLM_OUTPUT`.** It is now reported as an
   unexpected response shape.
7. **Impacted locators were marked only in the knowledge DB.** The locator registry itself is now set to RE_VERIFY.

## Exit proof

### Live: qa-prod (`00DdN00000uQ5dKUAS`, Enterprise, production with test data only, Winter '27)

Identity: `pnpm qa auth status --org qa-prod` reports `Verified: org 00DdN00000uQ5dKUAS (Enterprise Edition,
IsSandbox=false, LIVE) · user rakesh.sharma@nexturn.com.sfpartner · API v68.0 · release Winter '27`. `qa doctor`
shows `[ OK ] Salesforce identity (org + user)`.

| Run | What happened | Result |
|---|---|---|
| `run-p2-live-1` | discovery #1 + `--ui` + cross-check | 399 components, 0-change diff against the earlier dev snapshot (no false positives), 3 pages registered |
| — | **operator** adds `Contact.Phone_Must_Be_10_Digits` in Setup (the agent never changes metadata) | — |
| `run-p2-live-2` | discovery #2 | `added ValidationRule Contact.Phone_Must_Be_10_Digits`; RE_VERIFY on 6 assets |
| — | **operator** edits the rule's error message | — |
| `run-p2-live-3` | discovery #3 | **`changed ValidationRule Contact.Phone_Must_Be_10_Digits` (changed key: `errorMessage`)** |

Impact and RE_VERIFY from `run-p2-live-3` (`runs/run-p2-live-3/discovery/discovery-report.md`):

| Asset | Evidence (graph path) |
|---|---|
| locator `contact-new/textbox:New Contact/Phone` | `Locator -locates-> Field:Contact.Phone ; ValidationRule:Contact.Phone_Must_Be_10_Digits -error-on-> Field:Contact.Phone` |
| locator `contact-record/button:Details/Edit Phone` | same path through `Field:Contact.Phone` |
| manual test **MTC-001** (Create Contact from Account related list: enters Phone) | `ManualTest:MTC-001 -covers-> Field:Contact.Phone ; …` |
| requirements **SF-219-R14, R36, R39** (mention Phone) | `Requirement -mentions-> Field:Contact.Phone ; …` |

Tests that do not touch Phone (for example MTC-003, invalid email) are not flagged. `pnpm qa locators list --org
qa-prod` now shows both Phone locators as `RE_VERIFY`.

**Locator registry: 3 pages.** `pnpm qa locators list --org qa-prod`:

| Page | Locators | Opened via | Examples |
|---|---|---|---|
| `account-record` | 35 | `/lightning/r/Account/<id>/view` (default, Related, Details tabs) | `getByRole('main').getByRole('article', { name: 'Contacts', exact: true }).getByRole('button', { name: 'New', exact: true })` |
| `contact-record` | 44 | `/lightning/r/Contact/<id>/view` | `getByRole('main').getByRole('button', { name: 'Edit Phone', exact: true })` → Contact.Phone |
| `contact-new` | 36 | Account › Contacts related list › **New** (dialog cancelled, nothing saved) | `getByRole('dialog', { name: 'New Contact' }).getByRole('textbox', { name: 'Last Name', exact: true })` → Contact.LastName |

All locators are rank 1 (role). Registry rules reject XPath, `nth`/`first`/`last` and `slds-` chains. Elements inside
related-list record rows (12 on the Account page) and names holding record data are not registered. ARIA evidence is
PII-redacted (emails and phones appear as `<EMAIL_n>`/`<PHONE_n>`).

### Org cross-check of the Phase 1 requirements (`run-p2-live-5`, after the rule change)

Input: `run-p1-final-combined` (SF-219 + BRD PDF + manual tests). Result: 1 exists, 5 consistent, **1 not found**,
4 conflicts, 2 unknown.

| Id | Refs | Check | Result | What qa-prod shows |
|---|---|---|---|---|
| OC-013 | BR-09 | `Number_of_Contacts__c` exists | **NOT_FOUND** | no field `Number_of_Contacts__c` on Account or Contact (108 fields searched, admin describe). Question: new field to deliver, or a different field meant? |
| OC-003 | AC3, BR-03 | Email is required | CONFLICT | optional in the schema; no layout or validation rule requires it |
| OC-004 | AC3, BR-03 | Email format | CONSISTENT | Email-type field |
| OC-005 | AC4, BR-10 | duplicate warning | CONFLICT | 1 duplicate rule on Contact, inactive |
| OC-006 | AC5, BR-04 | Phone required (when Lead Source = Web) | CONFLICT | no rule makes Phone required |
| OC-007 | AC5, BR-04 | Phone must have 10 digits | CONSISTENT | `Contact.Phone_Must_Be_10_Digits` (was a CONFLICT before the operator added the rule) |
| OC-008 | AC5, BR-04 | Lead Source "Web" | CONSISTENT | active picklist value |
| OC-009/010 | AC6 | Read Only cannot create/edit Contacts | EXISTS / CONSISTENT | profile Read Only: read=true, create=false, edit=false (no Read Only test user yet) |
| OC-011 | BR-06 | Title from an approved list | CONFLICT | free-text field (length 128), no restriction |
| OC-001/012 | — | personas "Sales Rep", "Sales Manager" | UNKNOWN | no profile or permission set with that name; question asked |
| OC-002 | AC2, BR-02 | Last Name required | CONSISTENT | schema `nillable=false` |

Every row cites the snapshot. Settled results are `DECLARED_CONFIG` evidence; the rest are `UNKNOWN_OR_CONTRADICTORY`
and cannot become assertions.

### Offline fixture (FIXTURE-labelled; CLI, isolated root on port 4546)

`run-p2-fixture-1` (baseline + UI: 2 pages) → server restarted with `metadata.changed-vr.json` → `run-p2-fixture-3`:
`changed ValidationRule Contact.Phone_Format (errorConditionFormula, errorMessage)`, with RE_VERIFY on MTC-001 and
SF-219-R14/R36/R39. The report carries the `**FIXTURE**` banner. The same scenario is automated in `graph.test.ts`
and `sf-intelligence/index.test.ts`.

### RAG (live Gemini `gemini-embedding-2`)

- `pnpm qa ingest run-p1-final-combined --org qa-prod --snapshot --locators` stored 423 chunks: docs 8, locators 115,
  org_metadata 264, requirements 26, test_assets 10.
- A re-run skips everything unchanged. The interrupted first run resumed without re-embedding.
- Search for "Phone validation rule on Contact" returned the Phone locators and Contact metadata first, via
  vector + FTS fusion.

## Not verified / known limits

- **`qa analyze --org` was not run live** (to save the Gemini free-tier quota). The `discover` node is covered by
  `mainGraph.test.ts` (success, degrade, hard stop), and the same pipeline ran live through `qa discover`.
- **No live mutation:** Phase 2 is read-only. The org-profile guard is unit- and fixture-tested only.
- **Text-match asset linking is heuristic.** It selects regression candidates and is never an assertion.
- **Experience Cloud explorer is blocked** (no Digital Experiences in qa-prod). Persona UI checks for sales rep and
  read only are blocked (no test users).
- **The operator-created rule `Contact.Phone_Must_Be_10_Digits` is still active in qa-prod.** It blocks saving
  Contacts whose Phone is not exactly 10 digits. Deactivate it when it is no longer wanted; the next discovery will
  report the change.
