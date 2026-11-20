---
name: defect-investigation
description: Hypothesis-driven root-cause investigation of Salesforce test failures — failure taxonomy, evidence sources (traces, SOQL, Apex debug logs, flow errors, permissions), reproduction rules and the Defect Judge's standard before a bug is filed. Use when any test fails or a result looks suspicious.
---

# Defect investigation

## Loop: Observe → Hypothesize → Experiment → Conclude

1. **Observe**: failing step, error, screenshot, trace, network failures, console errors, test data used, persona, timing.
2. **Hypothesize**: list 3–5 competing causes across the taxonomy (never only one).
3. **Experiment**: cheapest discriminating check first (SOQL, metadata, permission query, log) — each result is evidence.
4. **Conclude**: verdict + confidence (0–1) + evidence IDs. Confidence < 0.6 → `UNKNOWN`, ask QA Lead / human.

## Taxonomy (verdict)

| Verdict | Typical signals | Next step |
|---|---|---|
| PRODUCT_DEFECT | Behaviour contradicts a requirement; reproducible via API and UI | Defect Judge |
| PERMISSION_CONFIG | INSUFFICIENT_ACCESS, missing FLS/CRUD, sharing | Defect Judge (config defect) |
| SCRIPT_LOCATOR | Locator not found / not unique; element exists with different name/position | Self-Healer |
| SCRIPT_TIMING | Passed on retry; spinner/toast race; async not awaited | Self-Healer (waits) |
| TEST_DATA | Duplicate rule, missing parent, wrong record type, data from another run | Test Data Agent |
| INVALID_REQUIREMENT_ASSUMPTION | Test expectation came from an assumption the org contradicts | Spec Analyst + human |
| STALE_KNOWLEDGE | Snapshot/locator/learning older than a changed component | Re-discover, re-verify |
| ENVIRONMENT | 5xx, maintenance, login page, org limits, deployment in progress | QA Lead (retry/schedule) |
| FLAKY | Non-deterministic across 3 re-runs without changes | Quarantine + learning |
| UNKNOWN | Low confidence | Escalate |

## Evidence sources

Playwright trace & network, JSON results, SOQL on affected records, `FlowInterview`/flow error emails, `ApexLog` for the
persona in the time window, `UserRecordAccess`, `ObjectPermissions`/`FieldPermissions`, `ValidationRule` active state,
`FlowDefinitionView` active version, setup audit trail (recent config changes), RAG: similar past defects & learnings.

## Defect Judge standard (all required before filing)

- Reproduced **twice**, fresh data, same persona; ideally once via API to exclude UI issues.
- ENVIRONMENT and TEST_DATA explicitly ruled out with evidence.
- Expected behaviour traced to a requirement/AC (or an org fact for regression).
- Report fields: title (`[Object] <what> when <condition> for <persona>`), requirement reference, environment and org
  profile, preconditions and data scope, reproduction steps, expected vs actual, screenshots, trace links, API/SOQL
  evidence, affected Salesforce components (from graph), severity rationale, possible duplicates (RAG), root-cause
  hypotheses, suggested regression tests, status `SUSPECTED` | `CONFIRMED`.
- Console errors and network errors are sanitized (no tokens, session IDs or PII) before they enter evidence.
- Publication to JIRA/ADO only with an approved project, field mapping and publication policy.
- DeepEval faithfulness of report to evidence ≥ 0.85.

## Never

Never classify as PRODUCT_DEFECT from a single UI failure. Never heal a failure whose verdict is a defect.
