// `qa report --run <id> [--analysis-run <id>]`: rebuild the Phase 5 reports of an execution run from its run folder
// (no org, no model). The JIRA comment draft / publication is `qa report comment` (src/cli/jiraComment.ts).
import { join } from 'node:path';
import type { Command } from 'commander';
import { loadEnv } from '../config/env.js';
import { QAError } from '../core/errors.js';
import { runPaths } from '../core/runFolder.js';
import { loadReportData, releaseConfidence, writeExecutionReports } from '../report/execution.js';

type Say = (msg: string) => void;

/** JIRA browse base from .env, ignoring the `<placeholder>` of the example file. */
export async function jiraBaseUrl(root: string): Promise<string | undefined> {
  const env = await loadEnv(root);
  const v = env.JIRA_BASE_URL;
  return v && !/<[^>]+>/.test(v) ? v : undefined;
}

export function registerReport(program: Command, rootOf: () => string, say: Say): Command {
  const report = program
    .command('report')
    .enablePositionalOptions()
    .description('Rebuild the reports of an execution run (execution, release confidence, cleanup, coverage, history)')
    .option('--run <id>', 'run id of a `qa run`')
    .option('--analysis-run <id>', 'analysis run of the design (assumptions), for design runs that predate the link')
    .action(async (o: { run?: string; analysisRun?: string }) => {
      if (!o.run) throw new QAError('DATA', 'qa report needs --run <id> (a `qa run` run id)');
      const root = rootOf();
      const jira = await jiraBaseUrl(root);
      const d = loadReportData({
        root,
        runId: o.run,
        ...(o.analysisRun ? { analysisRun: o.analysisRun } : {}),
        ...(jira ? { jiraBaseUrl: jira } : {}),
      });
      const files = await writeExecutionReports(d);
      const rc = releaseConfidence(d);
      say(`Run ${o.run} (${d.summary.environment}, ${d.summary.orgAlias}): ${rc.verdict} — ${rc.why}`);
      for (const f of files) say(`  ${f}`);
      say(`Playwright HTML: ${join(runPaths(root, o.run).dir, 'playwright-report', 'index.html')}`);
    });
  return report;
}
