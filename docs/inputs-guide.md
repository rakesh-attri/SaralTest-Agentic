# Inputs guide: from a story, spec or test sheet to canonical requirements

How sf-qa-agent reads its inputs (PLAN.md §7a) and turns them into validated `Requirement` records (PLAN.md §4).
Source code: `src/inputs/`, `src/agents/spec-analyst/`.

## Quick start (PowerShell or any shell)

```powershell
pnpm qa analyze --story SF-219
pnpm qa analyze --file "C:\specs\Contact Management BRD.pdf" --manual-tests ".\examples\inputs\Contact-Manual-Test-Cases.xlsx"
pnpm qa analyze --text "As a Sales Rep I want … AC1 – …" --no-input
pnpm qa analyze --story SF-219 --answers .\answers.yaml        # answers.yaml: Q1: "Yes, Email is required"
pnpm qa resume --run run-20261120-101500-ab12                   # continue a run that is waiting for answers
pnpm qa chat                                                    # paste a story, answer inline, /why R03
pnpm validate:analysis <runId>                                  # re-check a run's output with the Zod contracts
```

Output goes to `runs/<runId>/analysis/`:

- `analysis-report.md`
- `requirements.json`
- `clarifications.json`
- `findings.json`
- `coverage.json`
- `existing-tests.json`
- `issues.json`
- `triage.json`
- `evidence.json`
- `run.json`
- `sources/<docId>.json`

## Inputs

| Input | Flag | Adapter | Notes |
|---|---|---|---|
| JIRA story | `--story KEY` | `adapters/jira.ts` | Atlassian Rovo MCP when `--mcp` is given, otherwise JIRA REST (`JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` from `.env` or Windows Credential Manager). Read-only. Converts ADF to text, keeping bold labels, lists and line breaks. An "Acceptance Criteria" custom field is found through `expand=names`. Comments become `CM-n` sections. |
| Azure DevOps work item | `--ado ID` | `adapters/other.ts` | REST with `ADO_ORG_URL` + `ADO_PAT`. Not configured for this project, so it reports `TOOL_UNAVAILABLE`. |
| Chat / plain text | `--text`, `qa chat` | `adapters/other.ts` | docId `CHAT` |
| Markdown / text | `--file x.md`, `.txt` | `adapters/files.ts` | |
| Gherkin | `--file x.feature` | `@cucumber/gherkin` | Scenarios → `SC<n>`, or the scenario's tag when it is a requirement id (`@AC3`, `@BR-02`); `Rule:` → `RULE<n>` |
| JSON / YAML spec | `--file x.json`, `.yaml` | `adapters/files.ts` | Known shape: `key, title, description, acceptanceCriteria[], rules[], nonFunctional[], assumptions[], personas[], outOfScope[]`. Any other shape is kept as text. |
| PDF | `--file x.pdf` | `pdf-parse` | Text layer only (no OCR; a warning is shown when the PDF has no text). Page markers are removed. The hash covers the file bytes. |
| DOCX | `--file x.docx` | `mammoth` | Headings, lists and table rows are kept. `externalFileAccess` is off. |
| Manual test cases | `--manual-tests x.xlsx\|.csv` | `adapters/manualTests.ts` | Uses the first sheet that has Test ID + Title columns (a "Read Me" tab is skipped). Columns are matched by header aliases (Test ID, Title, Requirement Ref, Persona, Preconditions, Steps, Expected Result, Priority, Type, Last Run Status/Date). Numbered steps are split. High → P1 and similar mappings normalize priority; Failed → FAIL and similar mappings normalize status. |
| Defect history | `--defects "<JQL>"` or `past-results` | jira + `runs/*/results.json` | Feeds the Risk Analyzer (Phase 3). FAIL results keep their LIVE/FIXTURE/MOCK label. |
| Git diff | `--diff origin/main` | `adapters/other.ts` | `git diff --name-status` → SFDX components (CustomField, ValidationRule, Flow, ApexClass, LWC, Layout, FlexiPage, PermissionSet …) |
| Exploratory objective | `--objective "<text>"` | | Stored for the Autonomous Explorer (Phase 7) |

Every adapter is **deterministic**: it never calls a model.

## How a source becomes requirements

1. **Sections with stable refs** (`src/inputs/sections.ts`). Each document is split by convention:
   - numbered acceptance criteria → `AC1`, `AC2` …, including their Given/When/Then lines, even across blank lines
   - ids at the start of a line → that id: `BR-03` (rule), `NFR-01` (non-functional), `A-02` (assumption), `MTC-004` (test)
   - headings, numbered titles and bold labels give the kind of the text below them
   - other prose → `S<n>` (context; never a coverage item)

   The model sees each section as `[DOC#REF]` and must cite those refs.
2. **Deterministic lint** (`src/agents/spec-analyst/lint.ts`) applies the requirement-analysis checklist as fixed rules.
   Spec rules:
   - vague wording
   - an error or warning without its text
   - values defined elsewhere but not provided
   - timing words that need an org mechanism
   - custom components (`__c`)
   - NFR targets with no measurement method
   - conditional rules (both branches)

   Existing-test rules:
   - tests without requirements, or with unknown refs
   - likely duplicates
   - failed or blocked last run (risk signal)
   - requirement items no test covers
3. **Extract** (model, role `reasoning`): one testable behaviour per requirement. Code then checks the output:
   - every cited ref exists
   - every persona is named in the sources
   - a `reviewReason` is given when the outcome is unclear
   - every AC, rule and NFR is cited or explicitly `excluded` with a reason

   Problems are reflected back to the model (×2), then the fallback model is tried. If both fail, the QA Lead degrades
   to the **mechanical** path: one REVIEW_REQUIRED requirement per item, built from Given/When/Then.
4. **Analyze** (model) produces cross-source CONFLICT (two sections must be cited), AMBIGUITY, MISSING_DETAIL and
   ORG_CHECK_NEEDED findings, plus at most 5 questions per round. Each question has refs, test impact and one proposed
   assumption. Repeats of earlier questions are dropped, and overflow is kept as findings.
5. **Status** is decided by code, not the model. `REVIEW_REQUIRED` when any of these holds:
   - no stated expected outcome
   - an unclear outcome
   - a linked CONFLICT
   - an outcome-blocking lint finding
   - a HIGH model finding
   - an open question
   - reliance on an unconfirmed assumption

   Otherwise `EXECUTABLE`. Reasons are listed in `reviewReasons`.
6. **Ids** are `<KEY>-Rnn`, stable across runs (`.qa-memory/requirements/<KEY>.json`, keyed by cited sections + type).
   Every `sources[]` entry carries the document hash, version and section.
7. **Clarification.** Questions pause the graph (`interrupt()`). Answers become a citable source
   (`CLARIFICATIONS#Q1`) for re-analysis (≤ 2 rounds). Unanswered questions become `ASSUMED`, and every affected
   requirement gets `ASSUMPTION (unconfirmed, Qn): …` and stays REVIEW_REQUIRED.

## Labels and safety

- Analysis output shows its model environment: LIVE, **MOCK** (mock provider, labelled everywhere) or **mechanical**
  (no model).
- No Salesforce org is contacted in Phase 1. Org facts are only `ORG_CHECK_NEEDED` findings until Phase 2 discovery
  verifies them.
- Before anything goes to a model, source text is redacted: secrets and PII are masked. A secret that still reached a
  prompt would hard-stop the run (BLOCKED, report written).
