import { describe, expect, it } from 'vitest';
import type { AllConfigResults } from '../config/loader.js';
import type { OrgEntry, Persona } from '../config/schemas.js';
import { HardStopError, QAError } from '../core/errors.js';
import { nullLogger } from '../core/logger.js';
import type { VerifiedIdentity } from '../sf/identity.js';
import { identityCheck } from './checks/identity.js';
import type { CheckResult, DoctorContext } from './types.js';

const org: OrgEntry = {
  orgId: '00DdN00000uQ5dKUAS',
  alias: 'qa-prod',
  profile: 'dedicated-qa-prod',
  instanceUrl: 'https://acme.my.salesforce.com',
  release: "Winter '27",
  runTagField: null,
  environment: 'LIVE',
};
const persona: Persona = {
  id: 'system-admin',
  username: 'admin@acme.example',
  sfAlias: 'qa-prod',
  profile: 'System Administrator',
  permissionSets: [],
  use: ['default-execution'],
};

function ctx(verify: (o: OrgEntry, p: Persona) => Promise<VerifiedIdentity>, offline = false): DoctorContext {
  const config = {
    orgs: { ok: true, value: { orgs: [org], profiles: {} }, file: 'orgs.yaml', unconfigured: [] },
    personas: {
      ok: true,
      value: {
        defaultPersona: 'system-admin',
        personas: [persona],
        nonAdminCheckRequiredFor: [],
        missingPersonaPolicy: 'ask',
        sessionTtlMinutes: 60,
      },
      file: 'personas.yaml',
      unconfigured: [],
    },
  } as unknown as AllConfigResults;
  return {
    config,
    options: { live: false, offline, includeOAuth: false, ci: false },
    deps: { verifyIdentity: verify },
    logger: nullLogger(),
  } as unknown as DoctorContext;
}

const ok: VerifiedIdentity = {
  orgAlias: 'qa-prod',
  orgId: org.orgId,
  profile: org.profile,
  environment: 'LIVE',
  isSandbox: false,
  organizationType: 'Enterprise Edition',
  username: persona.username,
  userId: '005x',
  personaId: persona.id,
  instanceUrl: org.instanceUrl,
  apiVersion: '68.0',
  releaseLabel: "Winter '27",
  verifiedAt: new Date().toISOString(),
  warnings: [],
};
const one = async (p: Promise<CheckResult | CheckResult[]>): Promise<CheckResult> => {
  const r = await p;
  return Array.isArray(r) ? r[0]! : r;
};

describe('doctor: live Salesforce identity check', () => {
  it('green when every org/persona verifies', async () => {
    const r = await one(identityCheck(ctx(() => Promise.resolve(ok))));
    expect(r.status).toBe('green');
    expect(r.details?.[0]).toMatch(/verified 00DdN00000uQ5dKUAS .*Enterprise Edition/);
  });
  it('red when a run would hard-stop', async () => {
    const r = await one(identityCheck(ctx(() => Promise.reject(new HardStopError('IDENTITY_MISMATCH', 'wrong user')))));
    expect(r.status).toBe('red');
    expect(r.details?.[0]).toMatch(/HARD_STOP/);
  });
  it('red with a login fix on AUTH; skipped offline', async () => {
    const r = await one(identityCheck(ctx(() => Promise.reject(new QAError('AUTH', 'expired')))));
    expect(r.status).toBe('red');
    expect(r.fix).toMatch(/qa auth login --org qa-prod/);
    expect((await one(identityCheck(ctx(() => Promise.resolve(ok), true)))).status).toBe('yellow');
  });
});
