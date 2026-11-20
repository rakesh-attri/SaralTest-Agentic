---
name: reporting
description: What each run must report and how — reporting-labs and Playwright HTML setup, test metadata, QA docs (test plan, cases, RTM), release-risk summary wording, JIRA comment and bug formats. Use in the Reporter agent and when configuring reporters.
---

# Reporting

## Reporters (playwright.config.ts)

```ts
import reportingLabs from './reporting-labs.config';
reporter: [
  ['list'],
  ['json', { outputFile: `${runDir}/results.json` }],
  ['html', { open: 'never', outputFolder: `${runDir}/playwright-report` }],
  ['reporting-labs', reportingLabs],
],
```

`reporting-labs.config.ts`: `title: 'SF QA — <storyKey>'`, `outputFolder: '<runDir>/reporting-labs'`,
`dimensions: ['priority','severity','feature','owner','story']`, `links: { story: 'https://<site>.atlassian.net/browse/{id}' }`,
`maskKeys: ['password','token','sessionId','accessToken']`, `history: { enabled: true, keep: 30 }`.

Tests use `meta({...})`, `test.step()`, `log()` and `testData()` from `reporting-labs` so both reports are rich.

## Run folder `runs/<runId>/`

`charter.md, test-plan.md, test-cases.md, rtm.xlsx, clarifications.md, results.json, playwright-report/, reporting-labs/,
defects/*.md, risk-summary.md, run.log, evidence.json`.

## Additional reports

Test-design report (HTML), exploration report (HTML+JSON), defect reports, visual-diff report, impact & coverage summary,
cleanup/reconciliation report, execution history, release-confidence assessment. Every result shows its environment
(`LIVE` / `FIXTURE` / `MOCK`); a mocked or fixture pass is never shown as a real Salesforce pass.

## Release-risk summary (template)

1. Verdict line: `Ready / Ready with risks / Not ready` + one sentence why.
2. Coverage: ACs covered x/y, High risks covered x/y, personas tested.
3. Results by type and priority (counts), flaky count.
4. Defects: id, severity, title, status.
5. Blocked / not tested + reason. 6. Assumptions made. 7. Learnings promoted this run.

## JIRA comment (story)

Short: verdict, counts, top defects with links, link/attachment of reports + RTM, assumptions needing confirmation.
Never paste secrets, record data containing PII, or full logs.
