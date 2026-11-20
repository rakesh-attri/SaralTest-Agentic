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

  const orgRows = await api.query('SELECT Id, IsSandbox, OrganizationType FROM Organization');
  const orgRow = OrgRow.parse(orgRows[0] ?? {});
  if (!same18(orgRow.Id, org.orgId)) mismatch(`Organization.Id is ${orgRow.Id}, orgs.yaml says ${org.orgId}`);

  const info = UserInfo.parse(await api.userinfo());
  if (!same18(info.organization_id, org.orgId)) mismatch(`userinfo org ${info.organization_id} ≠ ${org.orgId}`);
  if (info.preferred_username.toLowerCase() !== persona.username.toLowerCase()) {
    mismatch(`logged-in user ${info.preferred_username} is not persona ${persona.id} (${persona.username})`);
  }

  const sessionHost = new URL(session.instanceUrl).host;
  const configuredHost = new URL(org.instanceUrl).host;
  if (sessionHost !== configuredHost) mismatch(`instance ${sessionHost} ≠ orgs.yaml ${configuredHost}`);

  const isSandbox = orgRow.IsSandbox ?? false;
  const expected = EXPECT_SANDBOX[org.profile];
  if (org.environment === 'LIVE' && expected !== undefined && expected !== isSandbox) {
    mismatch(`profile ${org.profile} expects IsSandbox=${String(expected)}, org reports ${String(isSandbox)}`);
  }

  const warnings: string[] = [];
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
    verifiedAt: (i.now?.() ?? new Date()).toISOString(),
    warnings,
  };
}
