// The only way tests and agents create Salesforce data (salesforce-test-data skill, Enforcement).
// Opens a session: identity check (HARD_STOP on mismatch) → latest snapshot → approved recipe → validated plan →
// human checkpoint (new recipe/mutation type) → DataEngine over GuardedSalesforce + the run's WriteLedger.
import { join } from 'node:path';
import { QAError } from '../core/errors.js';
import type { DataPlan } from '../core/schemas/data.js';
import type { Autonomy } from '../core/state.js';
import { SnapshotStore } from '../knowledge/snapshotStore.js';
import { ApprovalStore, checkpointRequired, NEW_RECIPE_CHECKPOINT, recipeSubject } from '../security/approvals.js';
import { WriteLedger } from '../security/idempotency.js';
import type { Approval } from '../core/schemas/data.js';
import type { GuardedSalesforce } from './client.js';
import { createSfContext, type SfContext } from './context.js';
import { DataEngine } from './data/engine.js';
import { buildDataPlan, loadRecipe, SnapshotFacts, type LoadedRecipe } from './data/plan.js';

export { DataEngine, sfErrorCodes, soqlString } from './data/engine.js';
export { buildDataPlan, loadRecipe, SnapshotFacts } from './data/plan.js';
export { writeDataOutputs, renderDataReport, maskId } from './data/report.js';

export const approvalsFile = (root: string): string => join(root, '.qa-memory', 'approvals.jsonl');
export const dataDir = (runDir: string): string => join(runDir, 'data');
export const ledgerFile = (runDir: string): string => join(dataDir(runDir), 'writes.jsonl');

export interface PlanDataInput {
  ctx: SfContext;
  recipe: string;
  snapshotId?: string;
  /** Data run id (run tag value); default the context's run id. Per-test sub-runs keep parallel tests apart. */
  runId?: string;
}

/** Plan only (observe): no org call beyond what `ctx` already did. */
export function planData(i: PlanDataInput): { plan: DataPlan; loaded: LoadedRecipe } {
  const loaded = loadRecipe(i.ctx.root, i.recipe);
  const store = new SnapshotStore(join(i.ctx.root, '.qa-memory', 'knowledge.db'));
  try {
    const id = i.snapshotId ?? store.latest(i.ctx.org.orgId)?.id;
    const snap = id ? store.get(id) : undefined;
    if (!snap) {
      throw new QAError('DATA', `no snapshot for ${i.ctx.org.alias}`, {
        fix: `pnpm qa discover --org ${i.ctx.org.alias}`,
      });
    }
    const plan = buildDataPlan({
      loaded,
      facts: new SnapshotFacts(snap),
      org: i.ctx.org,
      runId: i.runId ?? i.ctx.run.runId,
    });
    return { plan, loaded };
  } finally {
    store.close();
  }
}

export interface ApprovalStatus {
  required: boolean;
  approval?: Approval;
  subject: string;
  /** Command that records the approval (shown when it is missing). */
  command: string;
}

export function recipeApproval(ctx: SfContext, plan: DataPlan, autonomy: Autonomy): ApprovalStatus {
  const subject = recipeSubject(plan.recipe, plan.recipeHash);
  const required = checkpointRequired(ctx.policy, autonomy, NEW_RECIPE_CHECKPOINT);
  const approval = new ApprovalStore(approvalsFile(ctx.root)).find(NEW_RECIPE_CHECKPOINT, subject, ctx.org.orgId);
  return {
    required,
    ...(approval ? { approval } : {}),
    subject,
    command: `pnpm qa data approve --recipe ${plan.recipe} --org ${ctx.org.alias} --by "<your name>"`,
  };
}

export interface DataSession {
  ctx: SfContext;
  sf: GuardedSalesforce;
  plan: DataPlan;
  engine: DataEngine;
  ledger: WriteLedger;
  approval?: Approval;
  dir: string;
}

export interface OpenDataSessionInput {
  root: string;
  runId: string;
  recipe: string;
  orgAlias?: string;
  personaId?: string;
  autonomy?: Autonomy;
  ctx?: SfContext;
  log?: (m: string) => void;
}

/**
 * Open a data session. Refuses (DATA issue, nothing written) when the plan is invalid or the recipe version has no
 * recorded approval while the checkpoint applies at this autonomy level.
 */
export async function openDataSession(i: OpenDataSessionInput): Promise<DataSession> {
  const ctx =
    i.ctx ??
    (await createSfContext({
      root: i.root,
      runId: i.runId,
      ...(i.orgAlias ? { orgAlias: i.orgAlias } : {}),
      ...(i.personaId ? { personaId: i.personaId } : {}),
    }));
  const sf = await ctx.connect();
  const { plan } = planData({ ctx, recipe: i.recipe });
  if (!plan.valid) {
    const errors = plan.issues.filter((x) => x.severity === 'ERROR').map((x) => `${x.code}: ${x.message}`);
    throw new QAError('DATA', `data plan for ${plan.recipe} is invalid: ${errors.join('; ')}`, { errors });
  }
  const status = recipeApproval(ctx, plan, i.autonomy ?? ctx.policy.autonomy);
  if (status.required && !status.approval) {
    throw new QAError('DATA', `recipe ${plan.recipe} (${plan.recipeHash}) is not approved for ${ctx.org.alias}`, {
      checkpoint: NEW_RECIPE_CHECKPOINT,
      fix: status.command,
    });
  }
  const ledger = new WriteLedger(ledgerFile(ctx.run.dir));
  const engine = new DataEngine({ sf, plan, ledger, org: ctx.org, ...(i.log ? { log: i.log } : {}) });
  return {
    ctx,
    sf,
    plan,
    engine,
    ledger,
    ...(status.approval ? { approval: status.approval } : {}),
    dir: dataDir(ctx.run.dir),
  };
}
