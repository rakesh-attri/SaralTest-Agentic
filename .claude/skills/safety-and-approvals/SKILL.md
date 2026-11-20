---
name: safety-and-approvals
description: Safety rules for autonomous QA on real Salesforce orgs — org profiles, observe vs mutate actions, MCP tool allow-list, approvals and human checkpoints, audit logging, redaction, idempotent writes and hard stops. Use before any action that changes data, any new tool use, or any decision about whether to ask the human.
---

# Safety and approvals

## Before acting, classify the action

| Question | If yes |
|---|---|
| Does it change anything in Salesforce or an external system? | It is `mutate` → check org profile, policy, approvals |
| Is the tool on the allow-list (`config/mcp-tools.yaml`)? | If not → do not call it; raise an Issue |
| Is the org ID listed and the identity verified? | If not → HARD_STOP |
| Would it touch records without this run's tag? | Block (HARD_STOP) — except on `dedicated-qa-prod`, where it is allowed and audit-logged; a bulk delete of >200 existing records asks once |
| Would it send screenshots/record data to an external model? | Only if `allowExternalUpload` is true for the run |

## Never (default blocks)

Metadata deploy or change; anonymous Apex or agent-written JavaScript in the page; payments; mass delete; bulk update of
untagged records; permission/profile/role changes (except assigning test permission sets to test users when policy
allows); real external callouts; emails to real people from `prod-test-org` unless deliverability is confirmed safe.

## Writes

Every write has an idempotency key and an audit entry (who, org, persona, object, record ID, before/after, approval ID).
Uncertain outcome → reconcile by key before any retry. Never blind-retry.

## Human checkpoints

missing rules & unknown transitions · review-required expectations · new data recipe or mutation type · side-effect
browser actions & high-risk exploration · behaviour-changing locator repairs · confirming bugs & external submission ·
publishing learnings · mutations on `prod-test-org`. `config/policy.yaml` → `approvals.<L1|L2|L3>` decides which wait.

Ask with a short summary: what, why, risk, what happens if declined. Never make the operator read raw JSON.
Routine actions inside an approved run do not ask again.

## Redaction

Mask emails, phones, names, addresses, IDs from Full Copy data before prompts, logs, evidence and reports; keep the
mapping local so the report can show real values to the operator only.
