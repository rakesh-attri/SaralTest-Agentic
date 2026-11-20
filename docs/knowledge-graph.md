# Org knowledge: discovery, snapshots, diff, knowledge graph, impact, explorer

Phase 2 Salesforce Intelligence. Everything on this page is read-only against the org.

## Pipeline (`qa discover`)

```
identity check → runDiscovery → SnapshotStore.save (immutable) → diffSnapshots(previous, new)
  → rebuildGraph (components + dependencies + test assets) → impactOfDiff → RE_VERIFY marks
  → crossCheckRequirements (when --cross-check) → runs/<runId>/discovery/*
```

Code: `src/agents/sf-intelligence/discover.ts`. CLI: `src/cli/discover.ts`. The same pipeline runs as the
`discover` node of the main graph when `qa analyze --org <alias>` is used (`src/graph/mainGraph.ts`).

## Discovery (`src/sf/discovery/`)

| Area | Source | Component types |
|---|---|---|
| objects, fields, record types, picklists (+ dependent `validFor` values) | REST describe | `SObject`, `Field`, `RecordType` |
| custom metadata types / custom settings | global describe | `CustomMetadataType`, `CustomSetting` |
| validation rules (+ formula, message, active) | Tooling `ValidationRule` (+ `Metadata` per rule) | `ValidationRule` |
| Apex | Tooling `ApexTrigger`, `ApexClass` (body hashed, never stored) | `ApexTrigger`, `ApexClass` |
| flows (+ active version: objects/fields read and written) | `FlowDefinitionView`, Tooling `Flow.Metadata` for in-scope record-triggered flows | `Flow` |
| LWC / Aura | Tooling bundles | `LightningComponentBundle`, `AuraDefinitionBundle` |
| layouts (+ fields, behaviour, related lists), Lightning record pages | Tooling `Layout` (+ `Metadata`), `FlexiPage` | `Layout`, `FlexiPage` |
| profiles, permission sets, groups, CRUD, FLS | `Profile`, `PermissionSet`, `PermissionSetGroup`, `ObjectPermissions`, `FieldPermissions` | same names |
| sharing (OWD) | `EntityDefinition` | on `SObject.body.sharing` |
| duplicate rules | `DuplicateRule` | `DuplicateRule` |
| dependencies | `MetadataComponentDependency` (ids resolved through component and `CustomField` ids) + describe, formulas, flows, layouts | edges |

How it behaves:
- **UNKNOWN, never missing.** When an area cannot be read (permission, feature off, unexpected shape), discovery
  stores UNKNOWN placeholders (`<Object>.*` or `*`) and an area error, then continues with the next area. Only
  describe is critical; if it fails, discovery stops.
- TRANSIENT failures are retried with the policy backoff. Discovery never writes.
- Live qa-prod (Account + Contact): about 5 s, 399 components, 352 dependency edges, 2 UNKNOWN (object-permission
  rows whose parent is hidden).

## Snapshots and diff (`src/knowledge/`)

- `.qa-memory/knowledge.db` holds:
  - `snapshots`, `component_versions` (canonical body + type-prefixed sha256 hash) and `dependencies`;
  - `lineage` (asset → snapshot, spec hash, observation ids);
  - `reverify` marks.
- Snapshots are written in one transaction and never updated. A second write with the same id is refused.
- `diffSnapshots(prev, next)` keys on (type, apiName) and reports added / removed / changed (+ changed body keys) /
  unknown:
  - only objects present in both scopes are compared;
  - an unreadable area gives `unknown`, never `removed` or `added`;
  - cross-org diffs are refused.

## Knowledge graph and impact (`src/sf/graph/`)

- `.qa-memory/graph.db` stores `nodes` and `edges` per org, rebuilt from the latest snapshot. Dependency targets
  outside the discovery scope are kept as stub nodes.
- Test assets are linked deterministically (`assetLinks.ts`):
  - **requirements** (Phase 1 `requirements.json`) and **manual tests** (`existing-tests.json`) link to fields by
    word-bounded label or API name, limited to the objects the text names. The matched term is kept as edge
    evidence and the edge `source` is `text-match`;
  - **locators** link to fields explicitly (`locates`).
- `impact(seeds, depth ≤ 3)` is a recursive CTE in two steps:
  1. it follows one hop over the edges a changed component *governs* (`references`, `error-on`, flow writes,
     `trigger-on`, `controlled-by`, `depends-on`);
  2. it then walks *dependents* (incoming edges).
  The edge path comes back as citable evidence, for example
  `ManualTest:MTC-001 -covers-> Field:Contact.Phone ; ValidationRule:Contact.Phone_Format -error-on-> Field:Contact.Phone`.
- `impactOfDiff` turns impacted test assets into `ReverifyMark`s (`manual-test`, `requirement`, `locator`, …),
  stored in `knowledge.db`.

## Org cross-check of requirements (`src/agents/sf-intelligence/crossCheck.ts`)

The check is deterministic and makes no model call. For each requirement:

| Check | Settled when | Otherwise |
|---|---|---|
| custom API names exist (`X__c`, `__mdt`, …; also from `ORG_CHECK_NEEDED` findings) | field/object found → `EXISTS` | `NOT_FOUND` only if the scope was fully readable, else `UNKNOWN` |
| "X is required" | schema `nillable=false`, a layout marks it Required, or an active validation rule blocks blank values → `CONSISTENT` | `CONFLICT` |
| format ("valid email", "10 digits") | Email-type field, or a validation rule with REGEX/LEN on the field → `CONSISTENT` | `CONFLICT` |
| duplicate warning | active duplicate rule on the main object → `CONSISTENT` | `CONFLICT` (none / inactive) |
| persona | profile or permission set of that name (also "X User" → "X") → `EXISTS` | `UNKNOWN` + question |
| "cannot create/edit X" | profile CRUD agrees → `CONSISTENT` | `CONFLICT` |
| picklist value named in the text | active value → `CONSISTENT` | `CONFLICT` |
| "approved list" | restricted picklist or restricting validation rule → `CONSISTENT` | `CONFLICT` |
| timing ("immediately") | a flow writes the field, or it is a formula → `CONSISTENT` | `UNKNOWN` (triggers are "may update") |

What happens to the results:
- Settled results become evidence entries (`DECLARED_CONFIG`).
- `NOT_FOUND` and `CONFLICT` become `ORG_NOT_FOUND` / `ORG_CONFLICT` findings. `UNKNOWN` results that have a question
  become `ORG_CHECK_NEEDED` findings.
- Questions follow the skill format: `[ref] … The org currently … Test impact: …`.

## Application Explorer and locator registry (`src/agents/app-explorer/`, `src/knowledge/locatorRegistry.ts`)

How a page is explored:
- **Session:** the Playwright library opens the page in an isolated context with the persona's frontdoor
  storageState.
- **Records:** record ids come from read-only SOQL on existing records.
- **States:** the default tab, the Related tab and the Details tab are each selected and then read; dialogs are
  cancelled.
- **Reading:** an ARIA snapshot per state; candidates in the skill's order (role → label), using the smallest unique
  scope (dialog / article / tabpanel …); a candidate is kept only if `count() === 1` and it is visible.
- **Field matching:** the accessible name is matched to a metadata field. The basis is recorded (`label`,
  `label-without-ID`, `api-name`, `relationship-name`). In qa-prod, Phone shows as "Phone" in the UI but its describe
  label is "Business Phone".
- **Privacy:** elements inside related-list record rows, and names containing record values, are never registered.
  ARIA evidence is PII-redacted and screenshots stay local (`runs/<runId>/explorer/`).

The registry (`.qa-memory/locators.db`):
- one row per (org, page, element, persona, record type);
- Zod rejects XPath, `nth`/`first`/`last`, `slds-`/`data-aura` chains, rank/strategy mismatches, and css without a
  reason;
- `markReverify` works by field.

Pages registered on qa-prod: `account-record` (35), `contact-record` (44), `contact-new` (36, opened from the
Account's Contacts related list › New).

Experience Cloud: not available live, because Digital Experiences is not enabled in qa-prod (`Network` is
unsupported).

## Commands

```
pnpm qa discover --org qa-prod --objects Account,Contact --cross-check <analysisRunId> [--ui] [--baseline <snap>]
pnpm qa discover --org qa-prod --list
pnpm qa locators discover --org qa-prod [--pages account-record,contact-record,contact-new]
pnpm qa locators list --org qa-prod [--page contact-new]
pnpm qa analyze --story SF-219 --org qa-prod     # analysis + discover node in the main graph
```
