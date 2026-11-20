---
name: salesforce-auth-personas
description: How to authenticate Playwright to Salesforce sandboxes per persona (profile/permission set) using sf CLI frontdoor URLs and storageState, refresh sessions, and handle MFA safely. Use when setting up auth, adding a persona, or when a run hits an AUTH issue.
---

# Salesforce auth & personas

## Persona model (`config/personas.yaml`)

```yaml
personas:
  - id: sales-rep
    username: qa.salesrep@example.com.fullcopy # test user in the sandbox
    sfAlias: fc-salesrep                     # authorized with `sf org login jwt`
    profile: Sales User
    permissionSets: [Opportunity_Edit]
    recordTypes: [Enterprise]
  - id: sales-manager
    ...
```

## API auth: OAuth 2.0 JWT Bearer via an External Client App (ECA)

- New Connected Apps are restricted since Spring '26 → use one **External Client App** with JWT Bearer enabled.
- Certificate-based, no password, **no MFA / passkey / verification prompt** → works unattended and in CI.
- Each persona's test user is pre-approved on the ECA (policy: admin-approved users pre-authorized) and authorized once:
  `sf org login jwt --client-id <eca-consumer-key> --jwt-key-file <server.key> --username <user> --alias <alias> --instance-url <url>`
- Store the private key in Windows Credential Manager / CI secret; never in Git, logs or prompts. Rotate before expiry.
- Profiles of test users must not require a High Assurance session at login (that, or step-up auth, can still prompt).

## Browser sessions

1. `auth.setup.ts` per persona: `sf org open --url-only --target-org <alias> --json` → frontdoor URL → `page.goto(url)` →
   wait for Lightning → `context.storageState({ path: '.auth/<persona>.json' })`.
2. Test projects depend on the setup project and use that storageState. Isolated contexts only; never a personal profile.
3. Refresh when older than `sessionTtlMinutes` or when a test lands on a login page.

## Identity checks (before every run, API and browser)

- `SELECT Id, IsSandbox, OrganizationType FROM Organization` → Org ID must be listed in `config/orgs.yaml`.
- `/services/oauth2/userinfo` → user must be the persona's configured username.
- Browser: after frontdoor, confirm the instance URL and the logged-in user (e.g. via `$A`-free check of the user menu or
  a UI API call with the session). Any mismatch → HARD_STOP.

## Org profiles

`sandbox-qa` (full), `dedicated-qa-prod` (production org with only test data: any record data may be created/edited/
deleted, full bulk, authorized once per Org ID; metadata, permissions, payments, real callouts still blocked), `prod-test-org` (run-tagged records only, one approval per run, no bulk/metadata/permissions/payments/
real callouts, email only if deliverability confirmed safe), `prod-readonly` (observe only). See `config/orgs.yaml`.

## Rules

- Never type passwords in UI tests; never commit `.auth/`.
- MFA: use sf-CLI-authorized sessions (frontdoor bypasses interactive MFA for an already-authenticated session).
  If MFA is still prompted → `AUTH` issue → persona BLOCKED, continue others, report it.
- Always run the identity checks above before login; an unlisted org or mismatch = HARD_STOP.
- Default persona = **System Administrator test user** (`defaultPersona` in personas.yaml): used for setup, data and
  default execution.
- Story-driven personas: the Impact & Risk Analyst lists the profiles / permission sets the story touches; the charter adds
  a persona for each. If no matching test user exists → follow `missingPersonaPolicy` (default: ask the human).
- **System Administrator bypasses FLS, sharing and CRUD** (View/Modify All Data). Any requirement about permissions,
  visibility, sharing or field access must ALSO run as a non-admin persona, otherwise the result proves nothing.
  If no non-admin persona is available, mark those cases BLOCKED-NO-PERSONA instead of passing them as admin.

## Enforcement

`config/personas.yaml` Zod schema; `auth.setup.ts` generated from it; Runner refuses tests whose persona has no state.
