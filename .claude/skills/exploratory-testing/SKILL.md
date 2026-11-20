---
name: exploratory-testing
description: How the Autonomous Explorer chooses what to explore next based on coverage gaps and risk, runs time-boxed exploration charters in Salesforce through Playwright MCP, applies exploration heuristics, and turns findings into reviewed test cases or suspected defects. Use whenever planning or running exploratory testing.
---

# Exploratory testing (Autonomous Explorer)

## When it runs

After the scripted tests have run (and between investigations), within `exploration.minutesPerRun` from `config/policy.yaml`.
It never blocks the run: if its budget ends or a tool fails, it reports what it covered and stops.

## Choosing the next area (score each candidate, highest first)

| Signal | Source | Weight |
|---|---|---|
| AC or High risk with no passing test | RTM, risk model | 3 |
| Component changed by the story (field, flow, validation rule, layout, LWC) | Impact report, knowledge graph | 2 |
| Recent failures or flaky tests nearby | Results, RAG defects | 2 |
| Persona × record type never exercised | Charter, results | 1 |
| Past defect pattern in this area | RAG learnings | 1 |

Write the choice and its reason to the evidence ledger, so the report can say why this area was explored.

## Charter format

`Explore <area> as <persona> with <resources/data> to discover <risk/information>` + time box (default 10 min) + stop conditions.

## Heuristics to apply in Salesforce

- **CRUD + lifecycle:** create, edit, clone, delete, undelete; every stage/status transition, including backwards.
- **Boundaries & formats:** empty, max length, special characters, currencies, dates/time zones, very large numbers.
- **Interruptions:** cancel mid-edit, Save & New, back button, two tabs editing one record, session timeout.
- **Permissions:** same action as each persona; record owned by someone else; read-only fields via inline edit.
- **Related data:** parent without children, many children (related list paging), lookup to inactive records.
- **Automation side effects:** what else changed after save (fields, related records, emails, tasks)? Check via SOQL.
- **Bulk paths:** list view mass edit, import, inline edit in list views.
- **Integration:** changes that should trigger callouts/events — did they? What if the external system is slow?

## Rules

- Use the locator skill; record newly proven locators in the registry.
- Create data only through the Test Data Agent (tagged, cleaned up).
- Never change metadata or configuration; read-only exploration of setup.
- Take notes as you go: action, observation, oddities, with screenshots/ARIA snapshots as evidence.

## Outputs

1. **New test cases** for behaviour worth guarding → Test Planner → Test Reviewer → Generator (never straight to code).
2. **Suspected defects** → Failure Investigator → Defect Judge (normal evidence standard applies).
3. **Questions** about intended behaviour → QA Lead → clarification in chat.
4. **Coverage note** in the report: areas explored, time spent, findings count.
