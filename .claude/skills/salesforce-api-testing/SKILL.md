---
name: salesforce-api-testing
description: Write independent Salesforce API tests and API-level assertions in Playwright — REST/Composite calls, SOQL verification, permission checks with UserRecordAccess, async polling, bulk tests and Apex debug-log capture. Use when generating API tests or verifying back-end outcomes of UI tests.
---

# Salesforce API testing

## Fixture

`tests/fixtures/sf.ts` exposes `sf` (jsforce connection for the persona) and `admin` (setup-only connection),
both created from the sf CLI auth of the persona alias. Tests import `test` from this fixture, not from `@playwright/test`.

## Patterns

```ts
test('API: Closed Won creates Contract', { tag: ['@api', '@automation'] }, async ({ sf, data }) => {
  meta({ priority: 'P1', severity: 'critical', feature: 'Opportunity', story: 'SF-1234' });
  const opp = await data.create('Opportunity', { StageName: 'Negotiation', Amount: 50000 });
  await test.step('Close the opportunity', () => sf.sobject('Opportunity').update({ Id: opp.id, StageName: 'Closed Won' }));
  await test.step('Contract is created by the flow', async () => {
    await expect.poll(async () => (await sf.query(`SELECT Id FROM Contract WHERE Opportunity__c='${opp.id}'`)).totalSize,
      { timeout: 60_000, intervals: [2_000, 5_000, 10_000] }).toBe(1);
  });
});
```

- **Assert with SOQL**, not by re-reading the UI.
- **Async**: `expect.poll` with intervals; also check `AsyncApexJob` status for queueables/batch.
- **Permissions**: `SELECT RecordId, HasReadAccess, HasEditAccess, HasDeleteAccess FROM UserRecordAccess WHERE UserId=:u AND RecordId=:r`
  and object/field permission queries; for API as persona, assert `INSUFFICIENT_ACCESS` / missing field errors.
- **Validation rules**: expect the DML error with the exact message from metadata.
- **Bulk**: sObject Collections (200) — assert all succeeded and side effects count = 200.
- **Integration**: trigger the integration (record change, platform event publish, inbound REST call), then assert
  the outcome: resulting records, integration log/status fields, published events (`EventBusSubscriber` / CometD
  listener), or the request captured by a sandbox test endpoint/mock. Never call real production endpoints.
- **Debug logs**: Runner sets a TraceFlag on persona users for the run window; Investigator fetches `ApexLog` bodies
  for failing tests (time-window + user).
- Use bind-safe query building (escape quotes) — never interpolate untrusted text.

## Enforcement

Lint rule forbids raw `fetch` to Salesforce in tests (must use fixture); generated API tests must assert at least one
SOQL-verified outcome.
