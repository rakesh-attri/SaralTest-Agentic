---
name: salesforce-platform
description: Salesforce platform behaviour a QA engineer must account for — data model, record types, validation rules, flows, Apex triggers, LWC, sharing and security, governor limits, async processing and releases. Use when analysing requirements, building org context, scoring impact/risk or explaining a failure.
---

# Salesforce platform knowledge for QA

## What to harvest per story (Salesforce Intelligence)

| Area | Source | Why it matters for tests |
|---|---|---|
| Objects, fields, types, required, defaults, picklist values (per record type) | `describe` / Salesforce MCP | Valid/invalid data, boundary values |
| Record types + page layouts / Lightning record pages | Tooling API `RecordType`, `Layout`, `FlexiPage` | Which fields each persona sees |
| Validation rules (formula + error message + active) | Tooling `ValidationRule` | Negative tests; expected error text |
| Flows (record-triggered, scheduled paths, screen flows), active version | `FlowDefinitionView`, Flow metadata | Automation & async tests |
| Apex triggers / classes touching the objects | Tooling `ApexTrigger`, `ApexClass`, dependencies | Bulk & side-effect tests |
| LWCs on the pages | `LightningComponentBundle`, FlexiPage | Custom UI, a11y scope |
| Permission sets / groups, profiles, FLS, object CRUD | `PermissionSet`, `ObjectPermissions`, `FieldPermissions` | Persona matrix |
| Sharing: OWD, sharing rules, role hierarchy | `Organization`, sharing metadata | Visibility tests |
| Duplicate & matching rules | `DuplicateRule` | Test-data uniqueness |
| Integrations: named credentials, external services, outbound messages, platform events, Apex callouts, connected apps | Tooling API `NamedCredential`, `ExternalServiceRegistration`, `PlatformEventChannel`, Apex dependencies | Integration tests |
| Dependencies | `MetadataComponentDependency` | Impact analysis |

## Behaviours that cause "false" failures (consider before calling a bug)

- **Order of execution**: before-save flows → before triggers → validation rules → after triggers → after-save flows →
  rollups → async. A field may be overwritten after the UI shows it.
- **Async**: scheduled paths, queueables, platform events, future methods — results appear seconds to minutes later.
  Poll via API (`AsyncApexJob`, the target record) with a timeout; do not fail on first read.
- **Caching**: Lightning caches records; reload or navigate after API changes.
- **Field-level security** hides fields silently in the UI and API (no error) — a missing field may be a permission, not a layout bug.
- **Sharing** — "record not found / insufficient privileges" usually means sharing, not deletion.
- **Governor limits** — bulk (200 records) can fail where single-record UI works: real defect class.
- **Releases** — three seasonal releases a year; sandboxes on preview get the release earlier than production.
  Tag knowledge with the release; expect DOM changes in base components.
- **Translation / labels** — labels can be overridden per org or translated; use API names in data, labels in UI.

## Risk heuristics (Impact & Risk Analyst)

High likelihood: new/changed validation rules, flows with decisions, Apex touching >1 object, permission changes,
picklist value changes used in automation, record-type-specific logic.
High impact: money fields, stage/status transitions, integrations, data visible across roles, compliance fields.

## Enforcement

Knowledge-graph schema (`src/sf/graph/`) and the harvest checklist above are the contract; impact analysis must
cite graph edges as evidence.
