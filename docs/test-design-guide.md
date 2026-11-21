# Test design guide (Phase 3)

How `qa design` turns analysed requirements and org knowledge into a reviewed test design, and where each step
lives in the code. The rules come from `.claude/skills/test-design/SKILL.md`; this guide describes how they are
enforced.

## Run it

Design from an earlier analysis run, against the latest stored snapshot of an org (read-only on Salesforce):

```bash
pnpm qa design --from-run run-p1-final-combined --org qa-prod --run-id design-sf219
```

The same run without model calls (mechanical drafting and deterministic review only):

```bash
pnpm qa design --from-run run-p1-final-combined --org qa-prod --offline
```

Review an existing design again (for example after answering a question):

```bash
pnpm qa review --run design-sf219
```

Check a design against the exit criteria (independently of the run):

```bash
pnpm validate:design design-sf219
```

`qa analyze --story SF-219 --org qa-prod` now runs analysis → discovery → design → review in one go.

## Pipeline

```
requirements + findings + clarifications + manual tests      (runs/<id>/analysis)
snapshot + fresh org cross-check + diff/impact + RE_VERIFY    (.qa-memory/knowledge.db, graph.db)
locator registry (UI labels) + personas.yaml + recipes
            │
            ▼
EvidenceIndex (src/oracles/evidenceIndex.ts) ── every citable id with its level
            │
            ├─► risk model (src/agents/impact-risk/risk.ts)       RISK-nn: drivers, score, tier
            ├─► obligations (src/agents/impact-risk/obligations.ts) OB-nnn: what MUST be covered
            ▼
Test Planner (src/agents/test-planner/graph.ts) — model drafts wording per batch of 6 obligations
            │   code: ids, priority, evidence levels, review status, tiers, RTM
            ▼
Test Reviewer pass 1 (src/agents/test-reviewer/) ⇄ planner revise (max 2 rounds)
            │   QA Lead settlement: nothing stays OPEN
            ▼
runs/<id>/design/  charter · test-plan.md · test-cases.md · rtm.json/.xlsx · risks · obligations · review-pass1 · HTML
```

Graph wiring: `src/graph/designNodes.ts` (`plan`, `review`), `src/graph/mainGraph.ts` (routing, triage),
`src/cli/design.ts` (design hook = all org-side inputs).

## Evidence levels

| Level | When (code: `assignLevel`) | Becomes an assertion |
|---|---|---|
| `UNKNOWN_OR_CONTRADICTORY` | anything cited is contested: org CONFLICT / NOT_FOUND / UNKNOWN, ambiguity or conflict finding, open / only-assumed clarification, assumption or prose block, inactive rule, nothing cited | no — case REVIEW_REQUIRED |
| `DECLARED_CONFIG` | an org check (EXISTS / CONSISTENT) or a declared snapshot component | yes |
| `APPROVED_REQUIREMENT` | an uncontested story AC / BRD rule / NFR section | yes |
| `OBSERVED_ONLY` | only UI observations (locators) or manual tests | no — review first |
| `VERIFIED` | UI and SOQL agreed in an executed run | yes (from Phase 5) |

A contradiction is never outvoted: one contested citation makes the step UNKNOWN.

## Obligations

| Kind | Derived from |
|---|---|
| positive / deny / ui / nfr | every approved AC (or the first rule / NFR when there is no AC) of each requirement |
| negative | validation requirements: one per org check on a rule (required, format, duplicate rule, allowed values), otherwise one from the sections |
| boundary | `N characters` / `N digits` in the text → N-1 / N / N+1, with the field matched in the requirement's objects |
| allow | security requirements, when the default persona's object access is declared |
| bulk | data / functional requirements touching an object with an active trigger or flow (200 records) |
| regression | an imported manual test with an open RE_VERIFY mark |

Each obligation carries:
- `evidenceIds`: what a step may cite. Uncontested items when there are any, otherwise the contested ones.
- `mustCite`: what every step carries no matter what the model cites (its own org check; whole-requirement contests
  such as a NOT_FOUND component).
- `level`: the best level reachable, and `tier`.

## Risk model

`likelihood = base(requirement risk: HIGH 0.5, MEDIUM 0.35, LOW 0.2) + drivers` (capped 0.95), with these drivers:

| Driver | Weight |
|---|---|
| org conflict | +0.25 |
| org not found | +0.25 |
| org unknown (not a persona check) | +0.1 |
| REVIEW_REQUIRED | +0.1 |
| failed manual test | +0.2 |
| RE_VERIFY | +0.15 |
| changed component | +0.2 |
| past defect | +0.2 |

`score = likelihood × impact` (H 1, M 0.6, L 0.3; security / data requirements are H).

The tier comes from the score and the drivers:

| Tier | Rule |
|---|---|
| mandatory | covers an AC, or has a change / RE_VERIFY / past-defect driver |
| recommended | score ≥ 0.35 |
| optional | everything else |

AC obligations are always mandatory.

## What the model may and may not do

The model (Planner, `reasoning` role) drafts `title`, `technique`, `preconditions` and steps (`action`, `expected`,
`obligationId`, `evidence`). Every draft goes through `draftProblems()`, and each problem is sent back to the model:
- the obligation is covered and has a verifying step;
- only allowed evidence is cited;
- quoted values and numbers are grounded in the cited evidence, the step's action / preconditions, or an observed UI
  label;
- the expectation is not vague and does not restate the rule;
- the persona exists and matches the obligation (no unavailable persona unless the obligation requires it);
- the recipe exists (unknown names are dropped by `normalizeDrafts`).

The model never sets an evidence level, a review status or a priority, and never changes coverage.

## Reviewer pass 1 and the QA Lead

- **Deterministic rules** (`rules.ts`): AC positive, validation negative, deny case per permission requirement,
  every obligation covered, high risk without an executable case, unused charter persona, boundary values (literal or
  input length), bulk case, vague or restated expectation, ungrounded value, scope creep (unknown requirement or
  out-of-scope phrase), duplicates.
- **Judge** (`judge` role, different from the coder): adversarial findings that cite existing case and requirement ids.
  In round 2 it verifies its own open findings.
- **Planner revise:**
  - each revised case is validated on its own;
  - a revision or removal that would leave an obligation uncovered is rejected and the original is kept;
  - justifications are recorded;
  - a deterministic H finding cannot be justified by the planner.
- **Settlement** (`settleFindings`), after round 2:
  - lost coverage is restored by a mechanical case (RESOLVED);
  - an unavailable persona or a high risk with blocked cases is JUSTIFIED with its recorded reason;
  - everything else is **escalated**: the affected cases become REVIEW_REQUIRED, and the finding is JUSTIFIED and
    marked `escalated`.

## Labels

- `designEnvironment`: LIVE / MOCK / NONE (mechanical).
- `orgEnvironment`: LIVE / FIXTURE / NONE.
- The models used are listed per agent with a `(fallback)` flag.
- Every human-readable output (test plan, test cases, charter, HTML, XLSX label column) carries the MOCK / mechanical /
  FIXTURE banners. FIXTURE or MOCK designs are never presented as real Salesforce evidence.
