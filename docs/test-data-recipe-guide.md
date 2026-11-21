# Test data recipe guide

How test data is planned, approved, created, verified and cleaned up (PLAN.md §7e, `salesforce-test-data` skill).
Code: `src/sf/data/` (plan, engine, report), facade `src/sf/dataFactory.ts`, approvals `src/security/approvals.ts`,
CLI `src/cli/data.ts`, Playwright fixture `tests/fixtures/index.ts`.

## 1. A recipe

`examples/recipes/<name>.yaml` holds **business-approved** values. The engine never invents business values.

```yaml
recipe: account-contact
approvedBy: "Rakesh Sharma"          # a placeholder (<name>) makes the recipe invalid
objects:
  - object: Account                  # step id = alias ?? object
    recordType: null
    fields:
      Name: "QA-{runId}-Acme {synthetic}"
      Industry: Technology           # must be an active picklist value in the snapshot
      BillingCountry: India
  - object: Contact
    parent: { field: AccountId, ref: Account }   # lookup filled from the parent's record id
    fields:
      FirstName: "{synthetic}"
      LastName: "QA-{runId}-{synthetic}"
      Email: "qa+{runId}-{synthetic}@example.invalid"
negativeVariants:
  - name: missing-last-name
    object: Contact
    remove: [LastName]
    expect: rejected                 # only used to assert a rejection
cleanup: reverse-dependency
```

- `{runId}` becomes the data run id. `{synthetic}` becomes a token that is deterministic per run, step and field, so
  a resumed run reuses the same values. A value that is only `{synthetic}` becomes `Qa<token>`.
- Parents must be declared before their children. Negative variants must name an existing step.

## 2. The plan (`qa data plan`, observe only)

`buildDataPlan` reads the latest snapshot of the org (`SnapshotFacts`) and validates the whole plan. Each of the
following is an **ERROR**, and an invalid plan is never executed:

| Code | Meaning |
|---|---|
| UNKNOWN_OBJECT / UNKNOWN_FIELD | not in the snapshot (an unreadable area is reported as UNREADABLE_METADATA instead) |
| OBJECT_NOT_CREATEABLE / FIELD_NOT_CREATEABLE | the user cannot create it |
| INVALID_PICKLIST_VALUE | not an active picklist value |
| REQUIRED_FIELD_MISSING | the snapshot says required and the recipe has no value: ask for an approved value |
| VALUE_TOO_LONG | over the field length |
| EMAIL_DOMAIN_NOT_ALLOWED | the email domain is not in the org's `allowedEmailDomains` |
| RUN_TAG_FIELD_MISSING / RUN_TAG_TOO_LONG | `runTagField` is configured but not in the snapshot, or the run id is longer than the field (qa-prod: 50) |
| NO_UNIQUE_KEY | no synthetic field contains the run id (needed to reconcile and to adopt records) |
| NEGATIVE_NOT_REJECTABLE | no metadata proves the variant is rejected, so a rejection cannot be asserted |
| RECORD_TYPE_UNRESOLVED | record types need a RecordTypeId the snapshot does not hold yet |

These are only **WARNINGs**:
- an active validation rule references a recipe field;
- an active duplicate rule exists (values are run-unique anyway).

The run tag is `QA_Run_Id__c = <runId>`. If `runTagField: null`, the unique key must start with `QA-<runId>-`
instead. Negative variants get their expected error codes from metadata: REQUIRED_FIELD_MISSING for a removed
required field, FIELD_CUSTOM_VALIDATION_EXCEPTION when an active rule blocks the blank value.

## 3. Approval (human checkpoint)

The first use of a recipe **version** on an org is the checkpoint `new-data-recipe-or-mutation-type`. The version
is the sha256 of the parsed recipe, so any change needs a new approval. Whether the checkpoint waits depends on
`config/policy.yaml` `approvals`: L1 = all, L2 = includes it, L3 = not. Approvals are recorded in
`.qa-memory/approvals.jsonl`:

```powershell
pnpm qa data approve --recipe account-contact --org qa-prod --by "Your Name"
```

Without an approval, `qa data run` and the `data` fixture refuse with that exact command. Nothing is written.

## 4. Lifecycle (`qa data run`)

1. **Identity check** (`ctx.connect()`): a wrong org, user or instance is a HARD_STOP.
2. **Create** in dependency order. Each write goes through the ledger (`runs/<id>/data/writes.jsonl`), states
   PLANNED → SENT → CONFIRMED / FAILED, and through `GuardedSalesforce` (org-profile guard plus write-ahead audit
   ALLOWED → SUCCEEDED / FAILED in `runs/<id>/audit.jsonl`).
   - A timeout or connection reset makes the write **UNCERTAIN**. It is reconciled by querying the unique key plus
     the run tag: if found, the record is adopted; if not, it is sent once more. There are no blind retries.
3. **Verify:** every record is read back by SOQL; the planned values and the parent lookup (`Contact.AccountId`)
   are compared.
4. **Negative variants:** each must be rejected with an expected code. One that is unexpectedly saved is adopted
   and cleaned up.
5. **Cleanup** runs in reverse order and covers run-owned records only.
   - Each record is re-read first: if it no longer carries this run's tag, that is a **HARD_STOP**
     (`UNTAGGED_CLEANUP`).
   - The delete goes through the guard with `cleanup: true`.
6. **Re-query:** `SELECT Id FROM <obj> WHERE QA_Run_Id__c = '<runId>'`, plus the ledger ids, must return 0 rows.
   Only then is the status `CLEAN`.
7. **Reports** go to `runs/<id>/data/`: `data-plan.json/.md`, `data-ledger.json`, `verify.json`, `negatives.json`
   and `cleanup-report.json/.md`. The Markdown masks record ids.

Use `--keep` to skip cleanup. Clean up later, or after a crash, with:

```powershell
pnpm qa cleanup --run <runId> --org qa-prod
```

This reconciles UNCERTAIN writes, then cleans up and re-queries.

Independent check:

```powershell
pnpm validate:data <runId>
```

It covers the plan, the read-back, the lookups, the negatives, the CLEAN cleanup in reverse order, and the audit
pairs.

## 5. In generated tests (`data` fixture)

```ts
await data.create('account-contact', ['Account']);   // only the steps the test needs (parents included)
await accountRecordPage.open(data.id('Account'));     // navigate by ledger id, never by name
const name = data.unique('contact');                 // run-unique value the test types
await data.adopt('uiContact', 'Contact', 'LastName', name); // UI-created record: tagged + cleaned up
const r = await data.attempt('Contact', {}, ['LastName']);  // API oracle: must be rejected
```

- Every test has its own data sub-run: `<runId>-<hash of the test id>`, with its own tag and ledger under
  `runs/<runId>/data/<hash>/`. Parallel tests never share data.
- Teardown runs the cleanup and the re-query, attaches `data-cleanup.json`, and fails the test if anything remains.
- `QA_KEEP_DATA=1` keeps the data.
