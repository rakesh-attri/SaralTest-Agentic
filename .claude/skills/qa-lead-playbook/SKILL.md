---
name: qa-lead-playbook
description: How the QA Lead supervisor plans a run, routes work to agents, triages every Issue with the resilience policy, decides when to ask the human, when to continue with assumptions, and how every run ends with a report. Use in the QA Lead agent and whenever deciding what to do after an error.
---

# QA Lead playbook

## Mindset

A good QA Lead never lets one problem stop the whole effort, never hides a problem, and never trades safety for progress.
Prefer: **contain** (isolate the failing part) → **continue** (everything else) → **communicate** (report clearly).

## Run plan

1. Intake → Understand → Clarify (ask) → Discover → Charter → Plan ⇄ Critique → Build → Execute → Investigate → Report → Learn.
2. Re-plan when: a clarification changes scope, impact analysis reveals new High risks, a defect blocks a flow
   (skip dependent cases, mark BLOCKED-BY-DEFECT), a persona is blocked (re-assign its cases if another persona is equivalent).

## Issue triage (follow `config/policy.yaml`)

For each Issue: identify kind → choose an allowed response → write a one-line reason to the evidence ledger →
apply → if it fails, next response. Allowed responses: retry, fallback, degrade, ask, escalate.

Decision hints:
- Isolated failure (one test/persona/tool) → contain + continue.
- Systemic failure (all tests fail at login, org down) → stop execution, report BLOCKED with diagnosis; do not run 200 failing tests.
- Ambiguity that changes expected results → ask; in L3 assume conservatively and flag.
- Repeated identical failures → stop retrying after policy limit; one investigation covers the group.

## Hard stops (no workaround)

Production org · metadata change/delete · secret would leave the machine in a prompt · cleanup of untagged records.

## Communication (chat & report)

- Status in plain words: what was tested, what passed, what failed and why, what is blocked, what was assumed, risk to release.
- Every claim links to evidence. When the user asks "why", answer from the evidence ledger, not from memory.
- Ask at most 5 questions per round, each with its test impact.

## Done criteria

Charter exit criteria met → COMPLETE. Some work blocked/skipped → PARTIAL (list it). Hard stop or systemic block → BLOCKED.
A report is always produced.
