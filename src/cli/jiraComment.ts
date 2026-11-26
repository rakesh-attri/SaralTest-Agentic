// `qa report comment draft|approve|publish --run <id>`: the JIRA run comment (reporting skill). Draft → the human reads
// the exact text → `approve --by "<name>"` records the approval bound to its sha256 → `publish` posts it through Rovo MCP
// (add mode) or JIRA REST. Nothing is posted without that approval; the same text is never posted twice.
import { join } from 'node:path';
import type { Command } from 'commander';
import { projectPaths, requireConfig } from '../config/loader.js';
import { loadEnv, secretValues } from '../config/env.js';
import { QAError } from '../core/errors.js';
import { runPaths } from '../core/runFolder.js';
import { loadMcpJson, McpHub } from '../mcp/client.js';
import { ToolAllowList } from '../mcp/allowList.js';
import { loadReportData } from '../report/execution.js';
import {
  commentSubject,
  draftJiraComment,
  PUBLISH_CHECKPOINT,
  publicationGuard,
  publishJiraComment,
  readDraft,
} from '../report/jiraComment.js';
import { ApprovalStore } from '../security/approvals.js';
import { AuditLog } from '../security/audit.js';
import { Redactor } from '../security/redact.js';
import { SecretStore } from '../security/secretStore.js';
import { approvalsFile } from '../sf/dataFactory.js';
import { jiraBaseUrl } from './report.js';

type Say = (msg: string) => void;

async function runOrgId(root: string, orgAlias: string): Promise<string> {
  const orgs = await requireConfig('orgs', projectPaths(root));
  const org = orgs.orgs.find((o) => o.alias === orgAlias);
  if (!org) throw new QAError('ENVIRONMENT', `org alias "${orgAlias}" is not in config/orgs.yaml`);
  return org.orgId;
}

export function registerJiraComment(report: Command, rootOf: () => string, say: Say): void {
  const comment = report.command('comment').description('JIRA run comment: draft → human approval → publish');

  comment
    .command('draft')
    .description('Render the comment text for a run (nothing is sent)')
    .requiredOption('--run <id>', 'run id of a `qa run`')
    .option('--analysis-run <id>', 'analysis run of the design (assumptions)')
    .action(async (o: { run: string; analysisRun?: string }) => {
      const root = rootOf();
      const env = await loadEnv(root);
      const jira = await jiraBaseUrl(root);
      const d = loadReportData({
        root,
        runId: o.run,
        ...(o.analysisRun ? { analysisRun: o.analysisRun } : {}),
        ...(jira ? { jiraBaseUrl: jira } : {}),
      });
      const draft = draftJiraComment(d, new Redactor({ secrets: secretValues(env) }));
      say(`--- JIRA comment for ${draft.storyKey} (run ${draft.runId}, sha256 ${draft.sha256.slice(0, 16)}…) ---`);
      say(draft.text);
      say('--- end ---');
      say(`Saved: ${join(runPaths(root, o.run).dir, 'report', 'jira-comment.md')}`);
      say(
        `Nothing was sent. To approve this exact text: pnpm qa report comment approve --run ${o.run} --by "<your name>"`,
      );
    });

  comment
    .command('approve')
    .description('Record a human approval of the drafted text (checkpoint publish-run-comment, bound to its sha256)')
    .requiredOption('--run <id>', 'run id')
    .requiredOption('--by <name>', 'who approved the text (a name or role, never an email)')
    .action(async (o: { run: string; by: string }) => {
      const root = rootOf();
      const draft = readDraft(runPaths(root, o.run).dir);
      const d = loadReportData({ root, runId: o.run });
      const store = new ApprovalStore(approvalsFile(root));
      const a = store.record({
        checkpoint: PUBLISH_CHECKPOINT,
        subject: commentSubject(draft.storyKey, draft.sha256),
        orgId: await runOrgId(root, d.summary.orgAlias),
        approvedBy: o.by,
        runId: o.run,
        note: `JIRA comment on ${draft.storyKey} (${String(draft.text.length)} chars)`,
      });
      say(`Approval ${a.id} recorded for the comment of ${o.run} (sha256 ${draft.sha256.slice(0, 16)}…) by ${o.by}.`);
    });

  comment
    .command('publish')
    .description('Post the approved comment: Rovo MCP first (add mode), JIRA REST as fallback; audited')
    .requiredOption('--run <id>', 'run id')
    .option('--rest-only', 'skip the MCP path')
    .action(async (o: { run: string; restOnly?: boolean }) => {
      const root = rootOf();
      const dir = runPaths(root, o.run).dir;
      const draft = readDraft(dir);
      const d = loadReportData({ root, runId: o.run });
      const orgId = await runOrgId(root, d.summary.orgAlias);
      const approval = new ApprovalStore(approvalsFile(root)).find(
        PUBLISH_CHECKPOINT,
        commentSubject(draft.storyKey, draft.sha256),
        orgId,
      );
      const env0 = await loadEnv(root);
      const token = (await new SecretStore(env0).get('JIRA_API_TOKEN')).value;
      const env = { ...env0, ...(token ? { JIRA_API_TOKEN: token } : {}) };
      const redactor = new Redactor({ secrets: secretValues(env) });
      const audit = new AuditLog(runPaths(root, o.run).auditLog, redactor);
      let hub: McpHub | undefined;
      if (!o.restOnly && approval) {
        const servers = (await loadMcpJson(root)).mcpServers;
        if (servers['atlassian-rovo']) {
          hub = new McpHub({
            servers: { 'atlassian-rovo': servers['atlassian-rovo'] },
            allowList: new ToolAllowList(await requireConfig('mcp-tools', projectPaths(root))),
            audit,
            redactor,
            mutationGuard: publicationGuard({ storyKey: draft.storyKey, approval, text: draft.text }),
            connectTimeoutMs: 120_000,
          });
        }
      }
      try {
        const r = await publishJiraComment({
          draft,
          approval,
          ...(hub ? { mcp: hub } : {}),
          env: { JIRA_BASE_URL: env.JIRA_BASE_URL, JIRA_EMAIL: env.JIRA_EMAIL, JIRA_API_TOKEN: env.JIRA_API_TOKEN },
          audit,
          ctx: { runId: o.run, orgId, user: 'sf-qa-agent', persona: 'reporter' },
          ledgerFile: join(root, '.qa-memory', 'publications.jsonl'),
          log: say,
        });
        say(
          `Posted to ${draft.storyKey} via ${r.via === 'mcp' ? 'Atlassian Rovo MCP' : 'JIRA REST'}${r.commentId ? ` (comment ${r.commentId})` : ''}${r.mcpError ? ` — MCP was not used: ${r.mcpError}` : ''}.`,
        );
        say(`Audit: ${runPaths(root, o.run).auditLog}`);
      } finally {
        await hub?.close();
      }
    });
}
