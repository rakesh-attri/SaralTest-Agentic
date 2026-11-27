import type { OrgEntry, OrgsConfig, Persona } from '../config/schemas.js';
import { HardStopError, QAError } from '../core/errors.js';
import type { CallContext, MutationGuard } from '../mcp/client.js';
import type { AuditLog } from '../security/audit.js';
import { createOrgPolicyGuard, type MutationIntent } from '../security/orgPolicy.js';
import { JsforceApi, type QueryOptions, type SfApi } from './api.js';
import type { SessionProvider, SfSession } from './auth/types.js';
import { verifyIdentity, type VerifiedIdentity } from './identity.js';

/** Org IDs verified in this process/run. The policy guard refuses mutations on anything else. */
export class IdentityRegistry {
  private readonly ids = new Set<string>();
  private readonly byOrg = new Map<string, VerifiedIdentity>();
  add(i: VerifiedIdentity): void {
    this.ids.add(i.orgId);
    this.byOrg.set(i.orgId, i);
  }
  verifiedOrgIds = (): ReadonlySet<string> => this.ids;
  get(orgId: string): VerifiedIdentity | undefined {
    return this.byOrg.get(orgId);
  }
}

export type WriteRequest = Omit<MutationIntent, 'category' | 'recordCount' | 'untaggedCount' | 'cleanup'> &
  Partial<Pick<MutationIntent, 'category' | 'recordCount' | 'untaggedCount' | 'cleanup'>>;

/**
 * The only Salesforce handle agents get (CLAUDE.md rule 14). Every call is tagged `observe` or `mutate`; mutations
 * pass the org-profile guard first, are audit-logged write-ahead (ALLOWED → SUCCEEDED/FAILED) and refused ones are
 * logged as REFUSED. Observe calls run only after the identity check (the constructor needs a VerifiedIdentity).
 */
export class GuardedSalesforce {
  constructor(
    private readonly api: SfApi,
    readonly identity: VerifiedIdentity,
    private readonly guard: MutationGuard,
    private readonly ctx: CallContext,
    private readonly audit?: AuditLog,
  ) {}

  get environment(): SfApi['environment'] {
    return this.api.environment;
  }
  get apiVersion(): string {
    return this.api.apiVersion;
  }

  // ---- observe
  query<T = Record<string, unknown>>(soql: string, opts?: QueryOptions): Promise<T[]> {
    return this.api.query<T>(soql, opts);
  }
  describe(sobject: string): Promise<Record<string, unknown>> {
    return this.api.describe(sobject);
  }
  describeGlobal(): Promise<Record<string, unknown>> {
    return this.api.describeGlobal();
  }
  get(path: string): Promise<unknown> {
    return this.api.get(path);
  }

  // ---- mutate
  private async mutate<T>(
    tool: string,
    intent: WriteRequest,
    recordId: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const args: Record<string, unknown> = {
      category: 'record-data',
      recordCount: 1,
      untaggedCount: 0,
      cleanup: false,
      ...intent,
    };
    const ctx: CallContext = {
      ...this.ctx,
      ...(intent.object ? { object: intent.object } : {}),
      ...(recordId ? { recordId } : {}),
    };
    const base = {
      runId: ctx.runId,
      orgId: ctx.orgId,
      user: ctx.user,
      persona: ctx.persona,
      tool: `salesforce-api.${tool}`,
      action: 'mutate' as const,
      ...(ctx.object ? { object: ctx.object } : {}),
      ...(ctx.recordId ? { recordId: ctx.recordId } : {}),
    };
    const decision = await this.guard({ server: 'salesforce-api', tool, args, ctx });
    if (!decision.allowed) {
      this.audit?.append({ ...base, outcome: 'REFUSED', before: { intent: args, reason: decision.reason } });
      if (decision.hardStop) throw new HardStopError(decision.hardStop, decision.reason);
      throw new QAError('DATA', `write refused: ${decision.reason}`, { refused: 'policy' });
    }
    const approval = decision.approvalId ? { approvalId: decision.approvalId } : {};
    this.audit?.append({ ...base, outcome: 'ALLOWED', before: { intent: args }, ...approval });
    try {
      const r = await fn();
      this.audit?.append({ ...base, outcome: 'SUCCEEDED', after: { result: r ?? null }, ...approval });
      return r;
    } catch (err) {
      this.audit?.append({
        ...base,
        outcome: 'FAILED',
        after: { error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  }

  create(object: string, record: Record<string, unknown>, intent: Partial<WriteRequest> = {}): Promise<string> {
    return this.mutate('create', { operation: 'create', object, ...intent }, undefined, () =>
      this.api.create(object, record),
    );
  }
  update(
    object: string,
    id: string,
    fields: Record<string, unknown>,
    intent: Partial<WriteRequest> = {},
  ): Promise<void> {
    return this.mutate('update', { operation: 'update', object, ...intent }, id, () =>
      this.api.update(object, id, fields),
    );
  }
  destroy(object: string, id: string, intent: Partial<WriteRequest> = {}): Promise<void> {
    return this.mutate('delete', { operation: 'delete', object, ...intent }, id, () => this.api.destroy(object, id));
  }

  /**
   * A Save the agent clicks in the browser (e.g. the Explorer provoking a validation message). It may create a record,
   * so it is a mutation: same org-profile guard and write-ahead audit (`salesforce-ui.<tool>`) as an API create.
   * `fn` runs the UI steps and returns what it observed.
   */
  uiAttempt<T>(tool: string, object: string, fn: () => Promise<T>): Promise<T> {
    return this.mutate(`ui-${tool}`, { operation: 'create', object }, undefined, fn);
  }
}

export interface ConnectOptions {
  provider: SessionProvider;
  org: OrgEntry;
  orgs: OrgsConfig;
  persona: Persona;
  runId: string;
  registry: IdentityRegistry;
  audit?: AuditLog;
  hasApproval?: (approvalId: string | undefined) => boolean;
  /** Test seam: build the API from a session (default jsforce). */
  apiFactory?: (s: SfSession, env: SfApi['environment']) => SfApi;
}

/** session → API → identity check (HARD_STOP on mismatch) → GuardedSalesforce with the org-profile guard. */
export async function connectSalesforce(o: ConnectOptions): Promise<GuardedSalesforce> {
  const session = await o.provider.session({ persona: o.persona, org: o.org });
  const api = o.apiFactory
    ? o.apiFactory(session, o.org.environment)
    : JsforceApi.fromSession(session, o.org.environment, async () => {
        const fresh = await o.provider.session({ persona: o.persona, org: o.org, refresh: true });
        return fresh.accessToken;
      });
  const identity = await verifyIdentity({ api, session, org: o.org, orgs: o.orgs, persona: o.persona });
  o.registry.add(identity);
  const guard = createOrgPolicyGuard({
    orgs: o.orgs,
    verifiedOrgIds: o.registry.verifiedOrgIds,
    ...(o.hasApproval ? { hasApproval: o.hasApproval } : {}),
  });
  const ctx: CallContext = { runId: o.runId, orgId: o.org.orgId, user: identity.username, persona: o.persona.id };
  return new GuardedSalesforce(api, identity, guard, ctx, o.audit);
}
