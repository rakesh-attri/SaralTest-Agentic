import type { OrgEntry, Persona } from '../../config/schemas.js';
import { classifyError } from '../../core/classifyError.js';
import { HardStopError } from '../../core/errors.js';
import { SfCliSessionProvider } from '../../sf/auth/sfCli.js';
import { connectSalesforce, IdentityRegistry } from '../../sf/client.js';
import type { VerifiedIdentity } from '../../sf/identity.js';
import type { Check, CheckResult, DoctorContext } from '../types.js';

const isPlaceholder = (o: OrgEntry): boolean => /<[^<>]+>/.test(o.instanceUrl) || /^00D0{12}/.test(o.orgId);

/** Default: sf CLI session (JWT re-login when needed) → Organization + userinfo identity check. */
export async function defaultVerifyIdentity(
  ctx: DoctorContext,
  org: OrgEntry,
  persona: Persona,
): Promise<VerifiedIdentity> {
  if (!ctx.config.orgs.ok) throw new Error('config/orgs.yaml invalid');
  const provider = new SfCliSessionProvider({ runner: ctx.deps.run, secrets: ctx.secrets, ttlMinutes: 5 });
  const sf = await connectSalesforce({
    provider,
    org,
    orgs: ctx.config.orgs.value,
    persona,
    runId: 'doctor',
    registry: new IdentityRegistry(),
  });
  return sf.identity;
}

/**
 * Live identity check per configured org and persona (PLAN.md §7b): the same check every run performs before it
 * touches Salesforce. Red = a run on that org would HARD_STOP.
 */
export const identityCheck: Check = async (ctx) => {
  const base = { id: 'salesforce-identity', title: 'Salesforce identity (org + user)' };
  if (ctx.options.offline) return { ...base, status: 'yellow', summary: 'skipped (--offline)' };
  if (!ctx.config.orgs.ok || !ctx.config.personas.ok) {
    return { ...base, status: 'red', summary: 'orgs.yaml or personas.yaml invalid' };
  }
  const orgs = ctx.config.orgs.value.orgs.filter((o) => o.environment === 'LIVE' && !isPlaceholder(o));
  if (!orgs.length) return { ...base, status: 'yellow', summary: 'no live org configured yet' };
  const personas = ctx.config.personas.value.personas;
  const verify = ctx.deps.verifyIdentity ?? ((org: OrgEntry, p: Persona) => defaultVerifyIdentity(ctx, org, p));

  const details: string[] = [];
  let status: CheckResult['status'] = 'green';
  let fix: string | undefined;
  for (const org of orgs) {
    const forOrg = personas.filter((p) => p.sfAlias === org.alias || p.sfAlias.startsWith(`${org.alias}-`));
    if (!forOrg.length) {
      details.push(`${org.alias}: no persona in personas.yaml uses this org's alias`);
      if (status === 'green') status = 'yellow';
      continue;
    }
    for (const p of forOrg) {
      try {
        const id = await verify(org, p);
        details.push(
          `${org.alias}/${p.id}: verified ${id.orgId} (${id.organizationType}, IsSandbox=${String(id.isSandbox)}) as ${id.username}` +
            (id.releaseLabel ? `, release ${id.releaseLabel}` : ''),
        );
        for (const w of id.warnings) {
          details.push(`${org.alias}/${p.id}: warning — ${w}`);
          if (status === 'green') status = 'yellow';
        }
      } catch (err) {
        if (err instanceof HardStopError) {
          details.push(`${org.alias}/${p.id}: ${err.message} (runs would HARD_STOP)`);
          status = 'red';
          fix ??= 'Fix config/orgs.yaml / personas.yaml or re-authorize the alias with sf org login jwt';
        } else {
          const c = classifyError(err);
          details.push(`${org.alias}/${p.id}: ${c.kind} — ${c.message}`);
          if (status !== 'red') status = c.kind === 'AUTH' ? 'red' : 'yellow';
          fix ??= c.kind === 'AUTH' ? 'pnpm qa auth login --org ' + org.alias : undefined;
        }
      }
    }
  }
  return {
    ...base,
    status,
    summary:
      status === 'green'
        ? 'every live org/persona verified'
        : status === 'red'
          ? 'identity check failed'
          : 'verified with warnings',
    details,
    ...(fix ? { fix } : {}),
  };
};
