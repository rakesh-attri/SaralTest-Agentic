---
name: test-design
description: Risk-based test design for Salesforce stories — test charter, formal techniques (boundary, equivalence, decision table, state transition, pairwise, persona x record-type matrix), negative, bulk, integration and regression selection, plus the Test Reviewer's two review passes. Use when planning tests, writing test cases, building the RTM or reviewing coverage.
---

# Test design

## Charter first

`mission, scope, outOfScope, personas, risks[{id, desc, likelihood 0-1, impact H/M/L}], testTypes[], exitCriteria`.
Every test case links to ≥1 requirement **and** ≥1 risk (or is marked `regression`).

## Technique selection

| Requirement shape | Technique |
|---|---|
| Numeric/date/length limits | Boundary value analysis (min-1, min, max, max+1) |
| Categories of input | Equivalence partitioning (one valid per class + invalid classes) |
| Several conditions → outcome | Decision table (collapse impossible combinations) |
| Status/stage lifecycle | State transition (valid + invalid transitions) |
| Many independent parameters | Pairwise (all pairs), not full combinatorial |
| Who can do what | Persona × record-type × action matrix (allow + deny cases) |
| Default execution | System Administrator test user, unless the story names or impacts other profiles/permission sets |
| Automation | Trigger condition true/false, async completion, failure path, bulk 200 |
| UI | Field presence/required/read-only per persona & record type |
| Integration | Happy path, external system down/timeout, bad response, retry/idempotency, data mapping per field |

## Expected-result evidence (oracles)

Every expected result is labelled: `APPROVED_REQUIREMENT`, `DECLARED_CONFIG` (validation rule, Flow condition, field
metadata), `VERIFIED` (UI + SOQL agree in an earlier run) → may be asserted; `OBSERVED_ONLY` → review first;
`UNKNOWN_OR_CONTRADICTORY` → case is `REVIEW_REQUIRED`. Never invent an expected result.

## Regression selection tiers

`mandatory` (ACs of the story + dependents of changed components + confirmed past defects nearby), `recommended`
(High-risk neighbours), `optional` (the rest). Low predicted risk never removes AC coverage.

## Priority

P0 = blocks core business flow or security/data exposure; P1 = High risk AC; P2 = Medium; P3 = cosmetic.
Severity of a failure is set by the Defect Judge, priority of a test by the Planner.

## Regression selection

From the Impact report: tests in the registry whose components are within dependency depth ≤ 2 of changed components,
plus all P0 tests for the touched objects.

## Test Reviewer — pass 1: test cases (adversarial, before generation)

- Every AC → ≥1 positive and, where meaningful, ≥1 negative case?
- Every High risk covered? Every persona in the charter used? A deny case (non-admin persona) for each permission requirement?
- Boundaries actually at the boundary values? Bulk case for triggers/flows? Integration cases when the story touches one?
- Expected results specific and observable (no "works correctly")?
- Any case testing something not in requirements (scope creep / hallucination)?
- Duplicates? Cases that only differ cosmetically?
Output: findings with severity; Planner must fix or justify each. Max 2 rounds, then QA Lead decides.

## Test Reviewer — pass 2: generated code (after generation, before execution)

- Every assertion maps to an expected result in its test case, and every expected result has an assertion.
- Every expectation traces to a requirement, AC or org fact (evidence ID) — none invented.
- Nothing weakened: no `toBeTruthy` where a value was expected, no removed steps, no try/catch swallowing failures, no `test.skip`.
- `meta()` and tags match the case (priority, severity, story, type, persona).
- Locators come from page objects/registry; API tests verify outcomes with SOQL.
- RTM updated: every case has a generated test or a reason it is manual.
Output per test: `APPROVED` | `REVIEW_REQUIRED` | `BLOCKED` (+ findings). Only APPROVED tests run. Also check: correct
persona, required data recipe exists, no unauthorized actions, no duplicates, execution readiness.
Generator fixes findings → re-review (max 2 rounds).

## RTM

Rows: requirementId, AC, riskIds, testCaseIds, types, status (designed/automated/passed/failed/blocked). Coverage gate: 100% ACs.
