import { z } from 'zod';
import type { OrgEntry, OrgsConfig, Persona } from '../config/schemas.js';
import { HardStopError } from '../core/errors.js';
import type { SfApi } from './api.js';
import type { SfSession } from './auth/types.js';

/** Proof that the session talks to the configured org as the configured user (PLAN.md §7b). No tokens inside. */
export interface VerifiedIdentity {
  orgAlias: string;
  orgId: string;
  profile: OrgEntry['profile'];
  environment: OrgEntry['environment'];
  isSandbox: boolean;
  organizationType: string;
  username: string;
  userId: string;
  personaId: string;
  instanceUrl: string;
  apiVersion: string;
  /** Release label from `/services/data` (e.g. "Winter '27"), when the org reports one. */
  releaseLabel?: string;
  verifiedAt: string;
  /** Non-fatal observations (e.g. orgs.yaml release differs from the org's release). */
  warnings: string[];
}

const OrgRow = z.looseObject({
  Id: z.string(),
  IsSandbox: z.boolean().optional(),
  OrganizationType: z.string().optional(),
});
const UserInfo = z.looseObject({
  organization_id: z.string(),
  preferred_username: z.string(),
  user_id: z.string(),
});

const same18 = (a: string, b: string): boolean => a.length >= 15 && b.length >= 15 && a.slice(0, 15) === b.slice(0, 15);

/** Profiles that must point at a production org (IsSandbox = false) or a sandbox (true). */
const EXPECT_SANDBOX: Partial<Record<OrgEntry['profile'], boolean>> = {
  'sandbox-qa': true,
  'dedicated-qa-prod': false,
  'prod-test-org': false,
};

/**
 * Org facts proven by a full identity check (one that could read Organization) in THIS process. A low-privilege persona
 * that cannot read Organization (e.g. Limited Access User) reuses them for IsSandbox — never across processes, never
 * from config (operator decision 2026-11-26).
 */
export interface VerifiedOrgFacts {
  orgId: string;
  isSandbox: boolean;
  organizationType: string;
  verifiedBy: string;
  verifiedAt: string;
}
const ORG_FACTS = new Map<string, VerifiedOrgFacts>();
const key15 = (id: string): string => id.slice(0, 15);
export const verifiedOrgFacts = (orgId: string): VerifiedOrgFacts | undefined => ORG_FACTS.get(key15(orgId));
/** Test seam. */
export const resetVerifiedOrgFacts = (): void => {
  ORG_FACTS.clear();
};

/** The persona's profile cannot query Organization at all (not a transient or permission-on-field error). */
export function organizationNotQueryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { errorCode?: unknown } | null)?.errorCode;
  return (
    /sObject type 'Organization' is not supported/i.test(msg) || (code === 'INVALID_TYPE' && /Organization/i.test(msg))
  );
}

export interface VerifyIdentityInput {
  api: SfApi;
  session: SfSession;
  org: OrgEntry;
  orgs: OrgsConfig;
  persona: Persona;
  now?: () => Date;
}

/**
 * Identity check before every run (salesforce-auth-personas skill). Any mismatch is a HARD_STOP:
 * unlisted org → UNLISTED_ORG; wrong org / user / instance / sandbox-ness → IDENTITY_MISMATCH.
 */
export async function verifyIdentity(i: VerifyIdentityInput): Promise<VerifiedIdentity> {
  const { api, session, org, orgs, persona } = i;
  const mismatch = (what: string): never => {
    throw new HardStopError('IDENTITY_MISMATCH', `${org.alias}: ${what}`);
  };

  const listed = orgs.orgs.find((o) => same18(o.orgId, session.orgId));
  if (!listed) {
    throw new HardStopError('UNLISTED_ORG', `session org ${session.orgId} is not in config/orgs.yaml`);
  }
  if (listed.alias !== org.alias) mismatch(`session belongs to org "${listed.alias}", not "${org.alias}"`);

  const warnings: string[] = [];
  let orgRow: z.infer<typeof OrgRow>;
  let fullCheck = true;
  try {
    const orgRows = await api.query('SELECT Id, IsSandbox, OrganizationType FROM Organization');
    orgRow = OrgRow.parse(orgRows[0] ?? {});
  } catch (err) {
    if (!organizationNotQueryable(err)) throw err;
    // Low-privilege persona: the org ID is still checked through its own userinfo below; IsSandbox comes only from a
    // full identity check of the same org ID in this process.
    const known = verifiedOrgFacts(org.orgId);
    if (!known) {
      mismatch(
        `persona ${persona.id} cannot read Organization (${err instanceof Error ? err.message : String(err)}) and no full identity check of ${org.orgId} ran in this process — verify the default persona first`,
      );
    }
    orgRow = { Id: org.orgId, IsSandbox: known?.isSandbox, OrganizationType: known?.organizationType };
    fullCheck = false;
    warnings.push(
      `persona ${persona.id} cannot read Organization: org ID verified through userinfo; IsSandbox=${String(known?.isSandbox)} from the identity of ${known?.verifiedBy ?? '?'} verified at ${known?.verifiedAt ?? '?'} (same process)`,
    );
  }
  if (!same18(orgRow.Id, org.orgId)) mismatch(`Organization.Id is ${orgRow.Id}, orgs.yaml says ${org.orgId}`);

  const info = UserInfo.parse(await api.userinfo());
  if (!same18(info.organization_id, org.orgId)) mismatch(`userinfo org ${info.organization_id} ≠ ${org.orgId}`);
  // Live orgs: the persona's configured username. Fixture: the seed user the persona id maps to (personas.yaml
  // usernames belong to the live org; the fixture has its own users).
  const expectedUser = org.environment === 'FIXTURE' ? session.username : persona.username;
  if (info.preferred_username.toLowerCase() !== expectedUser.toLowerCase()) {
    mismatch(`logged-in user ${info.preferred_username} is not persona ${persona.id} (${expectedUser})`);
  }

  const sessionHost = new URL(session.instanceUrl).host;
  const configuredHost = new URL(org.instanceUrl).host;
  if (sessionHost !== configuredHost) mismatch(`instance ${sessionHost} ≠ orgs.yaml ${configuredHost}`);

  const isSandbox = orgRow.IsSandbox ?? false;
  const expected = EXPECT_SANDBOX[org.profile];
  if (org.environment === 'LIVE' && expected !== undefined && expected !== isSandbox) {
    mismatch(`profile ${org.profile} expects IsSandbox=${String(expected)}, org reports ${String(isSandbox)}`);
  }

  let releaseLabel: string | undefined;
  try {
    const versions = await api.apiVersions();
    releaseLabel = versions.find((v) => v.version === session.apiVersion)?.label ?? versions.at(-1)?.label;
    if (releaseLabel && org.environment === 'LIVE' && releaseLabel !== org.release) {
      warnings.push(`orgs.yaml release "${org.release}" differs from the org's release "${releaseLabel}"`);
    }
  } catch {
    warnings.push('could not read the release label from /services/data');
  }

  const verifiedAt = (i.now?.() ?? new Date()).toISOString();
  if (fullCheck) {
    ORG_FACTS.set(key15(org.orgId), {
      orgId: org.orgId,
      isSandbox,
      organizationType: orgRow.OrganizationType ?? 'unknown',
      verifiedBy: info.preferred_username,
      verifiedAt,
    });
  }
  return {
    orgAlias: org.alias,
    orgId: org.orgId,
    profile: org.profile,
    environment: org.environment,
    isSandbox,
    organizationType: orgRow.OrganizationType ?? 'unknown',
    username: info.preferred_username,
    userId: info.user_id,
    personaId: persona.id,
    instanceUrl: session.instanceUrl,
    apiVersion: session.apiVersion,
    ...(releaseLabel ? { releaseLabel } : {}),
    verifiedAt,
    warnings,
  };
}
