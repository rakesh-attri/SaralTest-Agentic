// `qa visual run | approve | status` (PLAN.md §7g, Phase 6).
// Exit codes (run): 0 = every region MATCH, no a11y failure, data CLEAN; 1 = candidates / a11y failures / data not
// clean (a human reviews the visual-diff report); 2 = the suite did not complete; 3 = BLOCKED (hard stop, missing
// data approval, no session).
import type { Command } from 'commander';
import { loadConfigFile, projectPaths, requireConfig } from '../config/loader.js';
import { QAError } from '../core/errors.js';
import { newRunId, runPaths } from '../core/runFolder.js';
import { Autonomy } from '../core/state.js';
import { ExecutionConfig, type OrgEntry } from '../config/schemas.js';
import type { VisualRunSummary } from '../core/schemas/visual.js';
import { approvalsFile } from '../sf/dataFactory.js';
import { approvable, approveBaselines } from '../visual/approve.js';
import { baselineFolder, loadBaselines, trustBaseline } from '../visual/baselines.js';
import { writeVisualReport } from '../visual/report.js';
import { loadVisualSummary, runVisual } from '../visual/run.js';

type Say = (msg: string) => void;

const list = (v?: string): string[] | undefined =>
  v
    ?.split(',')
    .map((x) => x.trim())
    .filter(Boolean);

async function executionConfig(root: string): Promise<ExecutionConfig> {
  const f = await loadConfigFile('execution', projectPaths(root));
  if (!f.ok)
    throw new QAError('ENVIRONMENT', 'config/execution.yaml is missing or invalid', {
      fix: 'copy config/execution.example.yaml',
    });
  return ExecutionConfig.parse(f.value);
}

async function orgOf(root: string, alias: string): Promise<OrgEntry> {
  const orgs = await requireConfig('orgs', projectPaths(root));
  const org = orgs.orgs.find((o) => o.alias === alias);
  if (!org) throw new QAError('ENVIRONMENT', `org alias "${alias}" is not in config/orgs.yaml`);
  return org;
}

export function visualSummaryText(s: VisualRunSummary, root: string): string {
  const L: string[] = [];
  L.push('', `Visual run ${s.runId} — ${s.environment} · ${s.org} · release ${s.release} · ${s.browser}`);
  if (s.environment !== 'LIVE')
    L.push(`  ${s.environment}: offline fixture images — never a Salesforce visual result.`);
  for (const c of s.candidates) L.push(`  ${c.status.padEnd(12)} ${c.name.padEnd(42)} ${c.reason}`);
  L.push(
    `  screenshots: ${s.counts.match} MATCH · ${s.counts.candidates} candidate(s) · layout findings ${s.counts.layout} (FAIL ${s.counts.layoutFail}, new Salesforce-owned ${s.counts.layoutNewStandard}) · a11y FAIL ${s.counts.a11yFail} · a11y new Salesforce-owned ${s.counts.a11yNewStandard}`,
  );
  for (const t of s.tests.filter((x) => x.state !== 'passed'))
    L.push(`  test ${t.state}: ${t.title}${t.error ? ` — ${t.error}` : ''}`);
  const dir = runPaths(root, s.runId).dir;
  L.push(`  visual-diff report: ${dir}\\report\\visual-diff.html (and .md)`);
  if (s.counts.candidates) {
    L.push(
      `  Candidates need a human decision (checkpoint approve-visual-baseline): review the report, then`,
      `    pnpm qa visual approve --run ${s.runId} --by "<your name>"   (add --only <name,…> to approve some, --a11y / --layout to accept new Salesforce-owned a11y rules / layout findings)`,
    );
  }
  return L.join('\n');
}

export function registerVisual(program: Command, rootOf: () => string, say: Say): void {
  const visual = program.command('visual').description('Visual baselines, layout checks and accessibility (Phase 6)');

  visual
    .command('run')
    .description('Run the visual + a11y suite and report candidates (never updates a baseline)')
    .option('--org <alias>', 'org alias (default QA_DEFAULT_ORG)')
    .option('--run-id <id>', 'run id', newRunId('visual'))
    .option('--persona <id>', 'persona', 'system-admin')
    .option('--viewports <names>', 'comma-separated viewport names (default: execution.yaml visual.viewports)')
    .option('--browser <name>', 'chromium | chrome | msedge')
    .option('--autonomy <level>', 'L1 | L2 | L3 (default from policy.yaml)')
    .action(
      async (o: {
        org?: string;
        runId: string;
        persona: string;
        viewports?: string;
        browser?: string;
        autonomy?: string;
      }) => {
        const root = rootOf();
        const orgAlias = o.org ?? process.env['QA_DEFAULT_ORG'];
        if (!orgAlias) throw new QAError('ENVIRONMENT', 'no org given: pass --org <alias> or set QA_DEFAULT_ORG');
        const viewports = list(o.viewports);
        const r = await runVisual({
          root,
          runId: o.runId,
          orgAlias,
          persona: o.persona,
          ...(viewports ? { viewports } : {}),
          ...(o.browser ? { browser: o.browser } : {}),
          ...(o.autonomy ? { autonomy: Autonomy.parse(o.autonomy) } : {}),
          say,
        });
        if (r.status === 'BLOCKED') {
          say(`BLOCKED: ${r.blockedReason ?? 'preflight failed'}`);
          process.exitCode = 3;
          return;
        }
        if (!r.summary) {
          say(`The suite did not complete: ${r.blockedReason ?? 'no summary'}`);
          process.exitCode = 2;
          return;
        }
        const files = writeVisualReport(runPaths(root, o.runId).dir, r.summary, r.reconcile);
        say(visualSummaryText(r.summary, root));
        say(`  data: ${r.reconcile?.status ?? 'NONE'} · files: ${files.join(', ')}`);
        const clean =
          r.summary.counts.candidates === 0 &&
          r.summary.counts.a11yFail === 0 &&
          r.summary.counts.layoutFail === 0 &&
          r.reconcile?.status === 'CLEAN';
        process.exitCode = r.status !== 'COMPLETE' ? 2 : clean ? 0 : 1;
      },
    );

  visual
    .command('approve')
    .description('Approve the candidate images of a visual run as baselines (human checkpoint approve-visual-baseline)')
    .requiredOption('--run <id>', 'visual run id')
    .requiredOption('--by <name>', 'who approves (recorded in .qa-memory/approvals.jsonl and the audit trail)')
    .option('--only <names>', 'comma-separated snapshot names to approve (default: all candidates)')
    .option('--a11y', 'also accept the new Salesforce-owned a11y rules of the run')
    .option('--layout', 'also accept the new Salesforce-owned layout findings of the run')
    .option('--note <text>', 'note stored with the approval')
    .option('--dry-run', 'show what would be approved, change nothing')
    .action(
      (o: {
        run: string;
        by: string;
        only?: string;
        a11y?: boolean;
        layout?: boolean;
        note?: string;
        dryRun?: boolean;
      }) =>
        (async () => {
          const root = rootOf();
          const s = loadVisualSummary(runPaths(root, o.run).dir);
          const org = await orgOf(root, s.org);
          const exec = await executionConfig(root);
          const only = list(o.only);
          if (o.dryRun) {
            const { take, skipped } = approvable(s, runPaths(root, o.run).dir, only);
            say(`Would approve ${take.length} baseline(s) on ${s.org} (${s.environment}):`);
            for (const c of take) say(`  ${c.status.padEnd(12)} ${c.name}`);
            for (const k of skipped) say(`  skipped ${k.name}: ${k.reason}`);
            if (o.a11y)
              for (const f of s.a11y.filter((x) => x.status === 'NEW_STANDARD'))
                say(`  a11y ${f.region}/${f.viewport}: ${f.ruleId}`);
            if (o.layout)
              for (const f of s.layout.filter((x) => x.status === 'NEW_STANDARD'))
                say(`  layout ${f.region}/${f.viewport}: ${f.kind} ${f.elements.join(' / ')}`);
            return;
          }
          const r = approveBaselines({
            root,
            runId: o.run,
            org,
            baselineDir: exec.visual.baselineDir,
            approvedBy: o.by,
            ...(only ? { only } : {}),
            ...(o.a11y ? { a11y: true } : {}),
            ...(o.layout ? { layout: true } : {}),
            ...(o.note ? { note: o.note } : {}),
            approvalsFile: approvalsFile(root),
          });
          if (!r.approval) {
            say(`Nothing to approve in ${o.run}.`);
            for (const k of r.skipped) say(`  skipped ${k.name}: ${k.reason}`);
            return;
          }
          say(
            `Approved ${r.approval.id} by ${r.approval.approvedBy} (${r.approval.approvedAt}) on ${s.org} (${s.environment}):`,
          );
          for (const b of r.approved)
            say(`  baseline ${b.name}  sha256 ${b.sha256.slice(0, 12)}…  release ${b.release}`);
          for (const a of r.a11yAccepted) say(`  a11y ${a.region}/${a.viewport}: ${a.ruleIds.join(', ')}`);
          for (const a of r.layoutAccepted) say(`  layout ${a.region}/${a.viewport}: ${a.keys.join(', ')}`);
          for (const k of r.skipped) say(`  skipped ${k.name}: ${k.reason}`);
          say(`  manifest: ${r.manifestFile ?? '-'} · audit: ${runPaths(root, o.run).auditLog}`);
          say('  Re-run `qa visual run` to confirm the candidates are cleared.');
        })(),
    );

  visual
    .command('status')
    .description('Approved baselines of an org and whether each is still trusted')
    .option('--org <alias>', 'org alias (default QA_DEFAULT_ORG)')
    .option('--release <label>', 'release to check against (default: orgs.yaml release; FIXTURE for the fixture)')
    .action((o: { org?: string; release?: string }) =>
      (async () => {
        const root = rootOf();
        const alias = o.org ?? process.env['QA_DEFAULT_ORG'];
        if (!alias) throw new QAError('ENVIRONMENT', 'no org given: pass --org <alias> or set QA_DEFAULT_ORG');
        const org = await orgOf(root, alias);
        const exec = await executionConfig(root);
        const folder = baselineFolder(root, exec.visual.baselineDir, alias);
        const m = loadBaselines(folder, org);
        const release = o.release ?? (org.environment === 'LIVE' ? org.release : org.environment);
        say(`Baselines for ${alias} (${org.environment}) in ${folder}: ${m.baselines.length}`);
        for (const b of m.baselines) {
          const t = trustBaseline(folder, m, b.name, release);
          say(
            `  ${t.ok ? 'OK        ' : 'RE_APPROVE'} ${b.name}  ${b.approvalId} by ${b.approvedBy} · ${b.release}${t.ok ? '' : ` — ${t.reason}`}`,
          );
        }
        for (const a of m.a11y) say(`  a11y accepted ${a.region}/${a.viewport}: ${a.ruleIds.join(', ') || '(none)'}`);
      })(),
    );
}
