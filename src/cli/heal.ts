// `qa heal` (Phase 7 Self-Healer): plan / apply locator and wait repairs for investigated script failures;
// `qa heal revert --repair <id>` undoes one exactly; `qa heal list` shows the repair history.
import { join } from 'node:path';
import type { Command } from 'commander';
import { projectPaths, requireConfig } from '../config/loader.js';
import { HardStopError } from '../core/errors.js';
import { newRunId, runPaths } from '../core/runFolder.js';
import { Autonomy } from '../core/state.js';
import { createProviders } from '../agents/failure-investigator/providers.js';
import { ledgerFile } from '../agents/failure-investigator/run.js';
import { readCatalog, readRepairs, revertRepair } from '../agents/self-healer/index.js';
import { healRun, readInvestigations } from '../agents/self-healer/run.js';
import { EvidenceLedger } from '../knowledge/evidenceLedger.js';
import { ApprovalStore } from '../security/approvals.js';
import { AuditLog } from '../security/audit.js';
import { Redactor } from '../security/redact.js';
import { createSfContext } from '../sf/context.js';
import { orgOfRun } from './investigate.js';
import { registryFile } from './locators.js';

type Say = (msg: string) => void;

export function registerHeal(program: Command, rootOf: () => string, say: Say): void {
  const heal = program
    .command('heal')
    .description(
      'Self-Healer: repair locators / waits of SCRIPT_* failures (assertions never change); plan only without --apply',
    )
    .option('--investigation <id>', 'investigation run (qa investigate) whose script failures to heal')
    .option('--apply', 'apply the repairs, verify each by a rerun, revert on failure')
    .option('--approve-by <name>', 'approve behaviour-changing locator repairs (operator name, recorded)')
    .option('--org <alias>', 'org alias (default: the org of the investigated run)')
    .option('--autonomy <level>', 'L1 | L2 | L3 (default: policy)')
    .option('--run-id <id>', 'heal run id (default heal-<timestamp>)')
    .action(
      async (o: {
        investigation?: string;
        apply?: boolean;
        approveBy?: string;
        org?: string;
        autonomy?: string;
        runId?: string;
      }) => {
        if (!o.investigation) {
          heal.help();
          return;
        }
        const root = rootOf();
        const runId = o.runId ?? newRunId('heal');
        const policy = await requireConfig('policy', projectPaths(root));
        const inv = readInvestigations(root, o.investigation);
        const orgAlias = o.org ?? orgOfRun(root, inv.sourceRun);
        const autonomy = Autonomy.parse(o.autonomy ?? policy.autonomy);
        const ledger = new EvidenceLedger(ledgerFile(root));
        const catalog = readCatalog(root);
        try {
          let rerun: Parameters<typeof healRun>[1]['rerun'];
          let audit: AuditLog | undefined;
          let orgId = catalog?.org ?? '00D000000000000AAA';
          if (o.apply && orgAlias) {
            try {
              const ctx = await createSfContext({ root, runId, orgAlias });
              const sf = await ctx.connect();
              orgId = ctx.org.orgId;
              audit = ctx.audit;
              rerun = createProviders({ root, runId, orgAlias, ctx, sf, reruns: true, say }).rerun;
            } catch (e) {
              if (e instanceof HardStopError) throw e;
              say(
                `Org not reachable (${e instanceof Error ? e.message : String(e)}): repairs cannot be verified, so none is applied.`,
              );
              process.exitCode = 1;
              return;
            }
          }
          audit ??= new AuditLog(runPaths(root, runId).auditLog, new Redactor({ secrets: [] }));
          const res = await healRun(
            { investigationRun: o.investigation, apply: Boolean(o.apply) },
            {
              root,
              runId,
              environment: inv.environment,
              autonomy,
              policy,
              registryFile: registryFile(root),
              approvals: new ApprovalStore(join(root, '.qa-memory', 'approvals.jsonl')),
              ledger,
              audit,
              orgIdForApprovals: orgId,
              ...(o.approveBy ? { approvedBy: o.approveBy } : {}),
              ...(rerun ? { rerun } : {}),
              say,
            },
          );
          ledger.exportRun(runId, join(root, 'runs', runId, 'evidence', 'evidence.json'));
          const changed = res.repairs.filter((r) => !r.assertionsUnchanged).length;
          say(
            `Repairs: ${res.repairs.length} (${res.repairs.filter((r) => r.status === 'VERIFIED').length} verified) · assertion changes: ${changed}`,
          );
          for (const f of res.files) say(`Saved: ${f}`);
        } finally {
          ledger.close();
        }
      },
    );

  heal
    .command('revert')
    .description('Undo one repair exactly (files restored byte-for-byte, registry rows put back)')
    .requiredOption('--repair <id>', 'repair id (HR-…)')
    .action((o: { repair: string }) => {
      const root = rootOf();
      const runId = newRunId('heal');
      const audit = new AuditLog(runPaths(root, runId).auditLog, new Redactor({ secrets: [] }));
      const r = revertRepair(root, o.repair, {
        registryFile: registryFile(root),
        audit,
        runId,
        orgIdForApprovals: readCatalog(root)?.org ?? '00D000000000000AAA',
        say,
      });
      say(`Reverted: ${r.revertOf ?? ''} (${r.caseId}).`);
    });

  heal
    .command('list')
    .description('Repair history (.qa-memory/heal/repairs.jsonl)')
    .action(() => {
      const rs = readRepairs(rootOf());
      if (!rs.length) say('No repairs.');
      for (const r of rs) say(`${r.id}  ${r.status.padEnd(9)} ${r.environment.padEnd(7)} ${r.caseId}  ${r.reason}`);
    });
}
