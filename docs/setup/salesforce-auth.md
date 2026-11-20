# Salesforce auth guide (External Client App + JWT)

This guide covers how sf-qa-agent logs in to Salesforce without passwords or MFA prompts, how it proves it is in the
right org, and how org profiles limit what it may change.

Source code:
- `src/sf/auth/` — sessions and browser state
- `src/sf/identity.ts` — identity check
- `src/security/orgPolicy.ts` — org-profile guard
- `src/sf/client.ts` — guarded client
- `src/cli/auth.ts` — CLI

## 1. One-time admin setup (per org)

1. **Create one External Client App (ECA).** New Connected Apps are restricted since Spring '26. Turn on OAuth with
   **JWT Bearer**, upload the certificate (`server.crt`), and give it the scopes `api` and `refresh_token`.
2. **Pre-approve** each persona's test user on the ECA (admin-approved users only).
3. **Session policy:** test-user profiles must not require *High Assurance* at login, because that brings back an MFA
   prompt.
4. **Key storage:** keep the private key (`server.key`) outside the repo, preferably in Windows Credential Manager
   (service `sf-qa-agent`, account `SF_JWT_KEY_PATH` holds the path). In `.env`:

   ```
   SF_ECA_CLIENT_ID=<consumer key>
   # keep comments on their own line
   SF_JWT_KEY_PATH=C:\Secrets\server.key
   ```

5. **Rotation:** rotate the certificate before it expires. The current qa-prod certificate `CN=SaralTest-QA` expires
   on 2027-11-20.

## 2. Configure the org and personas

- `config/orgs.yaml`: the exact 18-char Org ID, alias, profile, My Domain `instanceUrl` and `release`. Any org that
  is not listed is a HARD_STOP.
- `config/personas.yaml`: one entry per test user (`id`, `username`, `sfAlias`, `profile`, `permissionSets`).

## 3. How a session is made

| Need | How | Where |
|---|---|---|
| API session (discovery, SOQL, data) | OAuth 2.0 **JWT Bearer grant**, signed in-process (RS256, 3-minute assertion). `aud` is `login.salesforce.com`, or `test.salesforce.com` for sandboxes. The token stays in memory and goes to the Redactor as a secret. | `SfCliSessionProvider.session()` |
| sf CLI alias (frontdoor, Salesforce DX MCP) | `sf org login jwt --client-id … --jwt-key-file … --username … --alias … --instance-url …` | `jwtLogin()` |
| Browser session per persona | `sf org open --url-only` gives a one-time frontdoor URL. It is opened in an isolated Playwright context, waits for Lightning, and saves `.auth/<orgAlias>/<persona>.json`. That file is reused for `sessionTtlMinutes`. | `ensureStorageState()` |

Notes:
- **sf CLI 2.159 redacts access tokens** in `--json` output (`[REDACTED…]`). That is why API sessions use the JWT
  grant directly instead of reading `sf org display`.
- A login or MFA page after frontdoor raises an `AUTH` issue: that persona is BLOCKED and other personas continue.
  The agent never types a password.
- When an API call fails with `INVALID_SESSION_ID`, the client gets a new JWT grant once and retries the call.

## 4. Identity check (before any Salesforce work)

`verifyIdentity()` runs `SELECT Id, IsSandbox, OrganizationType FROM Organization` and calls
`/services/oauth2/userinfo`. It then compares the results with orgs.yaml and personas.yaml.

| Check | Mismatch → |
|---|---|
| Session org is listed in orgs.yaml | `HARD_STOP: UNLISTED_ORG` |
| Organization.Id = userinfo org = orgs.yaml org | `HARD_STOP: IDENTITY_MISMATCH` |
| Logged-in user = persona username | `HARD_STOP: IDENTITY_MISMATCH` |
| Instance host = orgs.yaml `instanceUrl` host | `HARD_STOP: IDENTITY_MISMATCH` |
| `IsSandbox` matches the profile (sandbox-qa → true; dedicated-qa-prod / prod-test-org → false) | `HARD_STOP: IDENTITY_MISMATCH` |
| orgs.yaml `release` = release label from `/services/data` | warning only |

The browser side has its own check: after frontdoor, the browser must land on the org's My Domain
(`<mydomain>.lightning.force.com`). Anything else is IDENTITY_MISMATCH.

## 5. Org-profile enforcement (every mutation)

`createOrgPolicyGuard()` is the MutationGuard. It is used both by `GuardedSalesforce` (jsforce record writes) and by
the Salesforce DX MCP hub (`createSalesforceHub`). It refuses a mutation when:

- the org is unlisted or its identity was not verified in this run (hard stop);
- the change is to metadata (`METADATA_WRITE` hard stop on every profile);
- the profile allows no mutations (`prod-readonly`) or the category is in the profile's `blocked` list (permission
  changes, payments, real callouts, email outside allowed domains);
- on `prod-test-org`: it touches records without this run's tag (`UNTAGGED_CLEANUP` / forbidden), or the per-run
  approval is missing;
- on `dedicated-qa-prod`: it deletes more than `confirmBulkDeleteOver` (200) existing records without one
  confirmation;
- on `sandbox-qa`: a cleanup would delete untagged records (hard stop).

Every allowed mutation is audit-logged before it runs (`ALLOWED`), then as `SUCCEEDED` or `FAILED`. Refusals are
logged as `REFUSED` (`runs/<runId>/audit.jsonl`). An MCP mutate tool with no policy category is refused by default.

## 6. Commands

```
pnpm qa auth status --org qa-prod          # identity check only
pnpm qa auth login  --org qa-prod          # JWT login + identity + browser storageState
pnpm qa doctor                             # includes the live identity check per org/persona
```

## 7. Current state (qa-prod)

- ECA + JWT: working. The live identity check passes for `00DdN00000uQ5dKUAS` as the configured user (Winter '27).
- Gaps:
  - The only persona is a named administrator's account; no dedicated sales-rep or read-only test users exist yet.
  - `QA_Run_Id__c` (orgs.yaml `runTagField`) does not exist in qa-prod. It is needed before Phase 4 data creation:
    either create the field (an admin action) or set `runTagField: null` to use the `QA-<runId>-` name prefix.
