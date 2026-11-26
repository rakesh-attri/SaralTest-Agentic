# Reports guide

How a run is reported (PLAN.md §10, `.claude/skills/reporting/SKILL.md`). Every report says which environment its
results come from: **LIVE** (a Salesforce org), **FIXTURE** (the offline fixture) or **MOCK** (mock model provider).
FIXTURE and MOCK results are never presented as Salesforce results.

## Where things are (`runs/<runId>/`)

| File | Written by | What it is |
|---|---|---|
| `results.json` | Runner (`src/runner/results.ts`) | normalised `TestResult[]`: every gate row, executed or not, with state, reason, environment, browser, persona, attempts, attachments, data cleanup |
| `playwright-results.json` | Playwright `json` reporter | Playwright's own JSON (the validator re-maps it independently) |
| `playwright-report/index.html` | Playwright `html` reporter | traces, screenshots, videos of failures |
| `reporting-labs/index.html` (+ `report.json`) | `reporting-labs` reporter | dimensions priority / severity / feature / owner / story, story links to JIRA, environment card, history across runs (`.qa-memory/reporting-labs-history.json`) |
| `run/execution-plan.json` | Runner | gate decisions (EXECUTE / BLOCKED / NOT_APPROVED / MANUAL / NOT_SELECTED) |
| `run/execution-summary.json` | Runner | counts, browser, environment, status, cleanup |
| `run/data-reconciliation.json` | Runner (`reconcile.ts`) | every data sub-run, the run-wide re-query, untagged records |
| `report/index.md` | Reporter (`src/report/execution.ts`) | entry point with links to everything below |
| `report/execution-report.md` / `.html` | Reporter | lineage (analysis → design → build → run), gate, results table, failures with attachments |
| `report/release-confidence.md` / `.json` | Reporter | verdict in the skill's template order: verdict · coverage · results by type/priority · defects · blocked / not tested · assumptions · learnings |
| `report/cleanup-reconciliation.md` | Reporter | sub-runs, re-queries, remaining and untagged records (ids masked) |
| `report/impact-coverage.md`, `report/rtm-results.xlsx` | Reporter | requirement → case → spec status → result |
| `report/history.md` (+ `.qa-memory/history.jsonl`) | Reporter | per-case trend of the story's last 10 runs |
| `report/model-attempts.json` | Reporter | model attempts that failed (exact provider messages) |
| `report/jira-comment.md` / `.json` | `qa report comment draft` | the JIRA comment text and its sha256 |
| `logs/run.log` | logger | every warning / error, Playwright output |
| `audit.jsonl` | guarded clients | every mutation, write-ahead (ALLOWED → SUCCEEDED / FAILED, REFUSED) |

Not produced yet: visual-diff report (Phase 6), exploration and defect reports (Phase 7).

## Release-confidence rules (`releaseConfidence`)

- Non-LIVE evidence → **Not ready** ("only FIXTURE evidence").
- A BLOCKED run, any executed FAIL / BLOCKED, or nothing executed → **Not ready**.
- Every executed test passed but something is missing (an AC without a passing executed test, not-approved / stale
  specs, flaky results, data not CLEAN) → **Ready with risks**, with every reason listed.
- Otherwise → **Ready**.
- AC coverage comes from the design RTM (every case that cites the AC).

## Commands

```powershell
pnpm qa run --story SF-219 --org qa-prod
pnpm qa report --run <runId> [--analysis-run <analysis run>]
pnpm validate:run <runId>
pnpm qa report comment draft --run <runId>
pnpm qa report comment approve --run <runId> --by "<your name>"
pnpm qa report comment publish --run <runId>
```

## JIRA comment

- The text is rendered by code from the reports: verdict, counts per environment, not-executed reasons, failures
  (case + title + what was observed), org-setup blocks, assumptions, where the reports are. No record ids, names,
  emails, error payloads or logs; the redactor must leave the text unchanged.
- `approve` records an approval for checkpoint `publish-run-comment` (required at every autonomy level) bound to the
  text's sha256 — a changed text needs a new approval.
- `publish` posts through Atlassian Rovo MCP v2 (`addOrEditJiraIssueComment`, add mode only: the guard refuses a
  `commentId`), and falls back to JIRA REST (`POST /rest/api/3/issue/{key}/comment`, ADF) when MCP is unavailable.
  Both paths are audited; `.qa-memory/publications.jsonl` prevents posting the same text twice. Nothing is attached
  (`allowExternalUpload: false`).
