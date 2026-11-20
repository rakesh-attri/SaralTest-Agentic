---
name: salesforce-test-data
description: Plan, create, track and clean Salesforce test data via API with run-ID tagging, describe-driven required fields, duplicate-rule awareness and reverse-order cleanup. Use when preparing preconditions, generating data for test cases, or cleaning up after runs.
---

# Salesforce test data

## Principles

1. **Create data through the API, not the UI** (Composite / sObject Collections), unless the UI creation *is* the test.
2. **Every record is tagged** with the run: preferred a custom field `QA_Run_Id__c` (ask admins to add it on key objects);
   fallback: name prefix `QA-<runId>-` .
3. **Ledger**: every created record (`object, id, persona, runId, createdAt`) is appended to `runs/<runId>/data-ledger.json`
   and to state `dataLedger`.
4. **Cleanup** in reverse dependency order (children first), only records with this run's tag (else HARD_STOP).
   Keep data on failure when configured (`keepDataOnFailure: true`) for investigation, then sweep later.
5. **Unique values** for fields covered by duplicate/matching rules (timestamp + random suffix).

## Engine steps (always in this order)

1. Read the current org snapshot (required fields, relationships, record types, picklists, validation rules).
2. Load the approved **business recipe** (`examples/recipes/<chain>.yaml`); if none exists, ask for one — never invent
   business-meaningful values from the story alone.
3. Generate synthetic values (unique for duplicate rules). 4. Validate the full dependency plan.
5. Ask for approval if the recipe or mutation type is new. 6. Create in dependency order; each write has an
   **idempotency key** (stored in the ledger and, when possible, in an external-ID or tag field).
7. Read every record back to verify. 8. Track ownership. 9. Clean up in reverse order, run-owned only.
10. Re-query to verify cleanup; write the cleanup/reconciliation report.

**Uncertain writes** (timeout/crash): state `UNCERTAIN` → query by idempotency key → mark CONFIRMED (adopt the record)
or retry once. Never blind-retry a write. Negative data is used only to assert rejection; never assume an invalid record
can be saved. On `prod-test-org`: smaller bulk sizes, no emails unless confirmed safe.

## Building a record

- Get required fields + valid picklist values **for the record type** from describe / knowledge graph.
- Fill required fields with valid defaults; then apply the test case's specific values (boundary/negative values).
- Lookups: create parents first (Account → Contact → Opportunity) inside one Composite request with references.
- Owner: set `OwnerId` to the persona's user when the test depends on ownership/sharing.

## Data for techniques

| Technique | Data rule |
|---|---|
| Boundary | min-1, min, max, max+1 from field length/precision or validation formula |
| Equivalence | one representative per class (valid picklist values, invalid values) |
| Negative | values that must trip each validation rule; assert the exact error message from metadata |
| Bulk | 200 records in one request (and 201 to cross a batch boundary when triggers batch) |

## Enforcement

`src/sf/dataFactory.ts` is the only way tests create data; cleanup guard checks the tag; orphan sweep command
`qa cleanup --sweep --older-than 24h`.
