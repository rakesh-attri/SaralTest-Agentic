---
name: verified-learning
description: Rules for turning run experience into trusted memory — what counts as proof, DeepEval gates and thresholds, confidence scoring, promotion, decay, release expiry and how agents should use learnings. Use in the Learning Curator / Eval Guardian and before writing anything to long-term memory.
---

# Verified learning

## Learning types

`locator` (old → new, page, persona) · `org-quirk` (e.g. "Stage picklist differs for record type X") ·
`defect-pattern` (symptom → root cause → check) · `data-rule` (e.g. duplicate rule on Account Name+City) ·
`design-heuristic` (e.g. "permission stories need a deny case for Sales Manager").

## Proof required (at least one)

- Healed test passed on re-run (locator, timing).
- Defect Judge confirmed (defect-pattern).
- Experiment result in evidence ledger (org-quirk, data-rule).
- Human approval in chat or review.

## Gates (DeepEval, `eval/`)

| Gate | Metric | Threshold |
|---|---|---|
| Requirements | Faithfulness + GEval "no invented requirements" | 0.85 |
| Retrieval | Contextual precision / recall / relevancy | 0.75 |
| Coverage | GEval "every AC and High risk has a test" | 0.90 |
| Generated test | GEval "steps/assertions match case, nothing weakened" | 0.85 |
| Defect report | Faithfulness to evidence | 0.85 |
| Learning | Faithfulness to evidence | 0.80 |
| Agents | ToolCorrectness, TaskCompletion (tracked) | 0.80 |

Judge model = `judge` role (different from the generating model; with Gemini use DeepEval's Gemini model class). If the eval sidecar fails → gate = "unevaluated"
→ L2/L3 require human approval for that item.

## Lifecycle

candidate → (proof + gate) → **promoted** (confidence 0.6) → each successful reuse +0.1 (max 0.95) →
contradiction −0.3 → < 0.3 **retired**. Every learning tagged with `org` and `release`; after a seasonal release
upgrade all learnings of type `locator` and `org-quirk` drop to 0.5 and are re-verified on next use.

## Using learnings

Agents retrieve learnings with confidence ≥ 0.5, cite them as evidence, and must still verify locators/org facts live.
A learning never overrides a fresh observation.
