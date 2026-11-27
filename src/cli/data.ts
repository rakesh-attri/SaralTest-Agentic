// qa data plan | approve | run, qa cleanup — the test data engine from the command line (PLAN.md §7e).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { reconcileRun, subRunDirs } from '../runner/reconcile.js';
import { QAError } from '../core/errors.js';
import { DataPlan, type CleanupReport } from '../core/schemas/data.js';
import { newRunId } from '../core/runFolder.js';
import { Autonomy } from '../core/state.js';
import { ApprovalStore, NEW_RECIPE_CHECKPOINT, recipeSubject } from '../security/approvals.js';
import { WriteLedger } from '../security/idempotency.js';
import { createSfContext } from '../sf/context.js';
import { DataEngine } from '../sf/data/engine.js';
import {
  approvalsFile,
  dataDir,
  ledgerFile,
  maskId,
  openDataSession,
  planData,
  recipeApproval,
  writeDataOutputs,
} from '../sf/dataFactory.js';

type Say = (msg: string) => void;

function sayPlan(say: Say, plan: DataPlan): void {
  say(
    `Plan ${plan.valid ? 'VALID' : 'INVALID'} — recipe ${plan.recipe} (${plan.recipeHash}, approved by ${plan.approvedBy}), snapshot ${plan.snapshotId}`,
  );
  say(
    `  run tag: ${plan.runTag.field ? `${plan.runTag.field} = ${plan.runTag.value}` : `name prefix QA-${plan.runTag.value}-`}`,
  );
  for (const s of plan.steps) {
    const fields = Object.entries(s.fields)
      .map(
        ([k, v]) =>
          `${k}=${typeof v === 'string' && v.length > 40 ? `${v.slice(0, 37)}…` : String(v)} (${s.fieldSources[k] ?? 'recipe'})`,
      )
      .join(', ');
    say(
      `  ${s.order + 1}. ${s.object} [${s.stepId}]${s.parent ? ` ${s.parent.field} → ${s.parent.stepId}` : ''}: ${fields}`,
    );
  }
  for (const n of plan.negatives) {
    say(
      `  negative ${n.name}: ${n.object} without ${n.removed.join(', ')} → must be rejected (${n.expectedErrorCodes.join(' | ')})`,
    );
  }
  for (const i of plan.issues) say(`  ${i.severity} ${i.code}${i.stepId ? ` [${i.stepId}]` : ''}: ${i.message}`);
}

function sayCleanup(say: Say, c: CleanupReport): void {
  say(
    `Cleanup ${c.status}: ${c.entries.map((e) => `${e.object} ${maskId(e.recordId)} ${e.action}`).join(', ') || 'nothing to clean'}`,
  );
  say(`  re-query: ${c.verify.queries.length} queries, ${c.verify.remaining.length} record(s) remaining`);
}

export function registerData(program: Command, rootOf: () => string, say: Say): void {
  const data = program
    .command('data')
    .description('Test data engine: approved recipes → plan → create/verify → cleanup');

  data
    .command('plan')
    .description('Validate a recipe against the latest snapshot and show the plan (observe only, nothing written)')
    .requiredOption('--recipe <name>', 'recipe in examples/recipes/<name>.yaml')
    .option('--org <alias>', 'org alias (default QA_DEFAULT_ORG)')
    .option('--run-id <id>', 'run id', newRunId('data'))
    .option('--autonomy <level>', 'L1 | L2 | L3 (default from policy.yaml)')
    .action(async (o: { recipe: string; org?: string; runId: string; autonomy?: string }) => {
      const root = rootOf();
      const ctx = await createSfContext({ root, runId: o.runId, ...(o.org ? { orgAlias: o.org } : {}) });
      const sf = await ctx.connect();
      say(`Identity verified: ${sf.identity.orgId} as ${sf.identity.username} (${ctx.org.environment}).`);
      const { plan } = planData({ ctx, recipe: o.recipe });
      sayPlan(say, plan);
      const st = recipeApproval(ctx, plan, Autonomy.parse(o.autonomy ?? ctx.policy.autonomy));
      say(
        st.required
          ? st.approval
            ? `Approval: ${st.approval.id} by ${st.approval.approvedBy} (${st.approval.approvedAt}).`
            : `Approval needed (checkpoint ${NEW_RECIPE_CHECKPOINT}): ${st.command}`
          : 'Approval: not required at this autonomy level.',
      );
      const files = writeDataOutputs(dataDir(ctx.run.dir), { plan });
      say(`Saved: ${files.join(', ')}`);
      process.exitCode = plan.valid ? 0 : 1;
    });

  data
    .command('approve')
    .description(`Record a human approval of this recipe version for an org (checkpoint ${NEW_RECIPE_CHECKPOINT})`)
    .requiredOption('--recipe <name>', 'recipe name')
    .requiredOption('--by <name>', 'who approves (recorded in .qa-memory/approvals.jsonl and the audit trail)')
    .option('--org <alias>', 'org alias (default QA_DEFAULT_ORG)')
    .option('--note <text>', 'note stored with the approval')
    .action(async (o: { recipe: string; by: string; org?: string; note?: string }) => {
      const root = rootOf();
      const ctx = await createSfContext({ root, runId: newRunId('approve'), ...(o.org ? { orgAlias: o.org } : {}) });
      const { plan } = planData({ ctx, recipe: o.recipe });
      if (!plan.valid) {
        sayPlan(say, plan);
        say('The plan is invalid: fix the recipe before approving it.');
        process.exitCode = 1;
        return;
      }
      sayPlan(say, plan);
      const store = new ApprovalStore(approvalsFile(root));
      const a = store.record({
        checkpoint: NEW_RECIPE_CHECKPOINT,
        subject: recipeSubject(plan.recipe, plan.recipeHash),
        orgId: ctx.org.orgId,
        approvedBy: o.by,
        ...(o.note ? { note: o.note } : {}),
      });
      say(`Approved: ${a.id} — ${a.subject} on ${ctx.org.alias} by ${a.approvedBy} (${a.approvedAt}).`);
    });

  data
    .command('run')
    .description('Create the recipe data, verify it, run negative variants, clean up and confirm the cleanup')
    .requiredOption('--recipe <name>', 'recipe name')
    .option('--org <alias>', 'org alias (default QA_DEFAULT_ORG)')
    .option('--run-id <id>', 'run id', newRunId('data'))
    .option('--autonomy <level>', 'L1 | L2 | L3 (default from policy.yaml)')
    .option('--keep', 'keep the records (no cleanup); clean later with qa cleanup --run <id>')
    .action(async (o: { recipe: string; org?: string; runId: string; autonomy?: string; keep?: boolean }) => {
      const root = rootOf();
      say(`qa data run — recipe ${o.recipe}, run ${o.runId}.`);
      let session;
      try {
        session = await openDataSession({
          root,
          runId: o.runId,
          recipe: o.recipe,
          ...(o.org ? { orgAlias: o.org } : {}),
          ...(o.autonomy ? { autonomy: Autonomy.parse(o.autonomy) } : {}),
          log: say,
        });
      } catch (e) {
        if (e instanceof QAError && e.detail && typeof e.detail === 'object' && 'fix' in e.detail) {
          say(`Blocked: ${e.message}\n  → ${String((e.detail as { fix: unknown }).fix)}`);
          process.exitCode = 2;
          return;
        }
        throw e;
      }
      const { ctx, plan, engine } = session;
      say(
        `Identity verified: ${session.sf.identity.orgId} as ${session.sf.identity.username} (${ctx.org.environment}).`,
      );
      sayPlan(say, plan);
      if (session.approval) say(`Approval ${session.approval.id} by ${session.approval.approvedBy}.`);
      const keep = o.keep === true;
      let created, verify, negatives, failure: unknown;
      try {
        say('Creating (dependency order)…');
        created = await engine.create();
        say('Verifying (read back)…');
        verify = await engine.verify();
        for (const v of verify) say(`  ${v.stepId}: ${v.ok ? 'verified' : 'MISMATCH'} (${v.checks.length} fields)`);
        say('Negative variants…');
        negatives = await engine.negatives();
      } catch (e) {
        failure = e;
        say(`Failed: ${e instanceof Error ? e.message : String(e)} — cleaning up what exists.`);
      }
      const keepNow = keep || (failure !== undefined && ctx.org.keepDataOnFailure === true);
      say(keepNow ? 'Keeping data (no cleanup).' : 'Cleaning up (reverse order, run-owned only)…');
      const cleanup = await engine.cleanup({ keep: keepNow });
      sayCleanup(say, cleanup);
      const files = writeDataOutputs(session.dir, {
        plan,
        created: engine.createdRecords(),
        ...(verify ? { verify } : {}),
        ...(negatives ? { negatives } : {}),
        cleanup,
        ...(session.approval ? { approvalId: session.approval.id } : {}),
      });
      say(`Audit: ${ctx.run.auditLog}`);
      say(`Saved: ${files.join(', ')}`);
      const ok =
        !failure &&
        created !== undefined &&
        (verify ?? []).every((v) => v.ok) &&
        (negatives ?? []).every((n) => n.outcome === 'REJECTED_AS_EXPECTED') &&
        (cleanup.status === 'CLEAN' || (keep && cleanup.status === 'KEPT'));
      say(ok ? `Data cycle OK (${plan.environment}).` : `Data cycle NOT OK (${plan.environment}).`);
      process.exitCode = ok ? 0 : 1;
      if (failure) throw failure instanceof Error ? failure : new QAError('DATA', 'data cycle failed');
    });

  program
    .command('cleanup')
    .description("Clean up a run's data: reconcile uncertain writes, delete run-owned records, re-query")
    .requiredOption('--run <id>', 'run id whose data to clean')
    .option('--org <alias>', 'org alias (default QA_DEFAULT_ORG)')
    .action(async (o: { run: string; org?: string }) => {
      const root = rootOf();
      const ctx = await createSfContext({ root, runId: o.run, ...(o.org ? { orgAlias: o.org } : {}) });
      const planFile = join(dataDir(ctx.run.dir), 'data-plan.json');
      if (subRunDirs(ctx.run.dir).length) {
        // A `qa run`: one data sub-run per test (data/<hash>/). Reconcile + clean each, then re-query the run tag.
        const sf = await ctx.connect();
        say(`Identity verified: ${sf.identity.orgId} as ${sf.identity.username}.`);
        const r = await reconcileRun({ runId: o.run, runDir: ctx.run.dir, org: ctx.org, sf, log: say });
        for (const x of r.subRuns) say(`  ${x.tag ?? x.dir}: ${x.status}${x.note ? ` — ${x.note}` : ''}`);
        for (const q of r.queries) say(`  re-query: ${q}`);
        say(`Data of run ${o.run}: ${r.status} (${r.remaining.length} record(s) remaining)`);
        process.exitCode = r.status === 'CLEAN' ? 0 : 1;
        return;
      }
      if (!existsSync(planFile) || !existsSync(ledgerFile(ctx.run.dir))) {
        say(`No data plan / ledger in ${dataDir(ctx.run.dir)}: nothing this run created is known.`);
        process.exitCode = 2;
        return;
      }
      const plan = DataPlan.parse(JSON.parse(readFileSync(planFile, 'utf8')));
      if (plan.orgId !== ctx.org.orgId) {
        say(`Run ${o.run} belongs to ${plan.orgAlias}, not ${ctx.org.alias}.`);
        process.exitCode = 2;
        return;
      }
      const sf = await ctx.connect();
      say(`Identity verified: ${sf.identity.orgId} as ${sf.identity.username}.`);
      const engine = new DataEngine({
        sf,
        plan,
        ledger: new WriteLedger(ledgerFile(ctx.run.dir)),
        org: ctx.org,
        log: say,
      });
      const cleanup = await engine.cleanup();
      sayCleanup(say, cleanup);
      const files = writeDataOutputs(dataDir(ctx.run.dir), { plan, created: engine.createdRecords(), cleanup });
      say(`Saved: ${files.join(', ')}`);
      process.exitCode = cleanup.status === 'CLEAN' ? 0 : 1;
    });
}
