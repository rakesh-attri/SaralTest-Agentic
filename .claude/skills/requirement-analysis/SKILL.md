---
name: requirement-analysis
description: How to turn a JIRA story or spec into testable requirements, cross-check it against the real Salesforce org, detect ambiguity, conflicts and missing requirements, and write good clarification questions. Use in the Spec Analyst and whenever a requirement is unclear.
---

# Requirement analysis

## Steps

1. **Collect**: summary, description, acceptance criteria (ACs), linked issues, attachments, comments, epic, fix version.
2. **Normalize**: split each AC into atomic, testable statements (`Given/When/Then` or rule form). One behaviour per requirement.
3. **Classify** each: functional, validation, security/permission, data, UI, integration, non-functional.
4. **Cross-check with the org** (RAG + knowledge graph): do the named objects/fields/picklist values/record types exist?
   Does an existing validation rule, flow or permission contradict the AC? Record each conflict as evidence.
5. **Find gaps** with the checklist below.
6. **Ask** only questions whose answer changes a test; max 5 per round, most important first.
7. **Assume** when unanswered (timeout or L3): pick the safest, most common interpretation; mark `assumption: true`.

## Ambiguity & gap checklist

- Who? (which profiles/permission sets/roles; what about users who must *not* be able to)
- Which record types / business units / currencies?
- Boundaries: min/max values, lengths, dates (past/future/today, time zones), null/blank behaviour.
- State transitions: allowed from which states? reversible?
- Error behaviour: exact message? blocking vs warning?
- Automation timing: immediate vs async; what if it fails?
- Existing data: what happens to records created before the change? bulk/import/API path same as UI?
- Integrations/notifications triggered?
- Non-functional: performance expectations, accessibility, audit/history tracking.

## Good question format

`[AC-2] Should Sales Managers (not only Sales Reps) be able to close Enterprise opportunities? The org currently grants
Edit on Opportunity to both via permission set Opportunity_Edit. Test impact: adds 2 cases (allow/deny).`

Each question: AC reference, the concrete ambiguity, what the org shows today, test impact.

## Canonical record

Every input adapter (JIRA, ADO, chat, Gherkin, md/txt/json/yaml, PDF, DOCX, manual test cases, defect history, Git diffs,
exploratory objectives) produces the same `Requirement`: stable ID, business objective, actors/personas, preconditions,
actions, business rules, expected outcomes, dependencies, data requirements, risk, known/unknown assumptions,
source + version references. **No clear expected outcome → `REVIEW_REQUIRED`**, never executable.

## Output (Zod `Requirement`)

`id, text, type, acRef, testable, ambiguities[], conflicts[], assumptions[], sources[]` — every requirement has ≥1 source
(AC, comment, org fact). No requirement may be invented: DeepEval faithfulness gate ≥ 0.85.
