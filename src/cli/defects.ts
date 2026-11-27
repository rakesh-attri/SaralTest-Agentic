// `qa defects` (Phase 7): Defect Judge drafts + the operator's publication flow.
//   judge    — PRODUCT_DEFECT / PERMISSION_CONFIG investigations → gate → judge model → bug draft (nothing is posted)
//   show     — print a draft exactly as it would be posted
//   approve  — record the operator's approval of that exact text (checkpoint publish-defect, bound to its sha256)
//   publish  — post an approved, CONFIRMED, LIVE draft (refused unless policy.defectPublication names the project)
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { projectPaths, requireConfig } from '../config/loader.js';
import { loadEnv, secretValues } from '../config/env.js';
import { runPaths } from '../core/runFolder.js';
import { judgeInvestigation, readDefect } from '../agents/defect-judge/index.js';
import {
  defectSubject,
  publicationRefusals,
  publishDefect,
  PUBLISH_DEFECT_CHECKPOINT,
  BUG_TOOL,
} from '../agents/defect-judge/publish.js';
import { ledgerFile, loadRunResults } from '../agents/failure-investigator/run.js';
import { readInvestigations } from '../agents/self-healer/run.js';
import { EvidenceLedger } from '../knowledge/evidenceLedger.js';
import { loadMcpJson, McpHub, type MutationGuard } from '../mcp/client.js';
import { ToolAllowList } from '../mcp/allowList.js';
import { ApprovalStore } from '../security/approvals.js';
import { AuditLog } from '../security/audit.js';
import { Redactor } from '../security/redact.js';
import { SecretStore } from '../security/secretStore.js';
import { approvalsFile } from '../sf/dataFactory.js';
import { orgOfRun } from './investigate.js';
import { createModelDeps } from './modelDeps.js';

type Say = (msg: string) => void;

async function orgFacts(
  root: string,
  alias: string | undefined,
): Promise<{ alias: string; orgId: string; profile: string }> {
  const orgs = await requireConfig('orgs', projectPaths(root));
  const org = orgs.orgs.find((o) => o.alias === alias);
  return { alias: alias ?? '?', orgId: org?.orgId ?? '00D000000000000AAA', profile: org?.profile ?? '?' };
}

export function registerDefects(program: Command, rootOf: () => string, say: Say): void {
  const defects = program
    .command('defects')
    .description('Defect Judge drafts and their (operator-approved) publication');

  defects
    .command('judge')
    .description(
      'Judge the PRODUCT_DEFECT / PERMISSION_CONFIG verdicts of an investigation run and draft bugs (nothing is posted)',
    )
    .requiredOption('--investigation <id>', 'investigation run (qa investigate)')
    .option('--no-model', 'no judge model: drafts stay SUSPECTED for a human')
    .action(async (o: { investigation: string; model: boolean }) => {
      const root = rootOf();
      const inv = readInvestigations(root, o.investigation);
      const policy = await requireConfig('policy', projectPaths(root));
      const org = await orgFacts(root, orgOfRun(root, inv.sourceRun));
      const results = loadRunResults(root, inv.sourceRun);
      const m = await createModelDeps({
        root,
        say,
        noModel: !o.model,
        logFile: runPaths(root, o.investigation).runLog,
        roles: ['reasoning', 'judge'],
      });
      const ledger = new EvidenceLedger(ledgerFile(root));
      try {
        const targets = inv.investigations.filter(
          (i) => i.verdict === 'PRODUCT_DEFECT' || i.verdict === 'PERMISSION_CONFIG',
        );
        if (!targets.length) say('No PRODUCT_DEFECT / PERMISSION_CONFIG verdict to judge.');
        for (const i of targets) {
          const result = results.find((r) => (r.caseId ?? r.testId) === i.caseId);
          const out = await judgeInvestigation(
            i,
            {
              root,
              runId: o.investigation,
              environment: inv.environment,
              org,
              reproductions: policy.investigation.reproductions,
              ...(result ? { result } : {}),
              sourceRun: inv.sourceRun,
            },
            {
              ...(m.router ? { router: m.router } : {}),
              skills: m.skills,
              redactor: m.redactor,
              logger: m.logger,
              ledger,
            },
          );
          const j = out.draft.judge;
          say(`${out.draft.id} [${inv.environment}] ${out.draft.status}: ${out.draft.title}`);
          say(
            `  judge: ${j?.decision ?? '-'} by ${j?.model ?? '-'}${j?.gate.missing.length ? ` · gate missing: ${j.gate.missing.join('; ')}` : ' · gate passed'}`,
          );
          for (const f of out.files) say(`  Saved: ${f}`);
        }
        ledger.exportRun(o.investigation, join(root, 'runs', o.investigation, 'evidence', 'evidence.json'));
        say(`Nothing was posted. Read a draft: pnpm qa defects show --run ${o.investigation} --id <DEF-…>`);
      } finally {
        ledger.close();
      }
    });

  defects
    .command('list')
    .description('Drafts of a run')
    .requiredOption('--run <id>', 'run holding runs/<id>/defects')
    .action((o: { run: string }) => {
      const root = rootOf();
      const dir = join(root, 'runs', o.run, 'defects');
      const ids = (() => {
        try {
          return readdirSync(dir)
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.slice(0, -5));
        } catch {
          return [];
        }
      })();
      if (!ids.length) say('No defect drafts.');
      for (const id of ids) {
        const { draft } = readDefect(root, o.run, id);
        say(
          `${id}  ${draft.status ?? '?'}  ${draft.environment ?? '?'}  ${draft.published ? 'published' : 'draft'}  ${draft.title}`,
        );
      }
    });

  defects
    .command('show')
    .description('Print a bug draft exactly as it would be posted (and what still blocks publication)')
    .requiredOption('--run <id>', 'run holding the draft')
    .requiredOption('--id <id>', 'defect id (DEF-…)')
    .action(async (o: { run: string; id: string }) => {
      const root = rootOf();
      const { draft, text } = readDefect(root, o.run, o.id);
      process.stdout.write(`${text}\n`);
      const org = await orgFacts(root, draft.org);
      const policy = await requireConfig('policy', projectPaths(root));
      const approval = new ApprovalStore(approvalsFile(root)).find(
        PUBLISH_DEFECT_CHECKPOINT,
        defectSubject(draft.id, draft.sha256 ?? ''),
        org.orgId,
      );
      const refusals = publicationRefusals({ draft, approval, policy });
      say(
        `sha256 ${draft.sha256?.slice(0, 16) ?? '?'}… · ${refusals.length ? `not publishable yet: ${refusals.join('; ')}` : 'publishable'}`,
      );
    });

  defects
    .command('approve')
    .description('Record the operator approval of this exact bug text (checkpoint publish-defect, bound to its sha256)')
    .requiredOption('--run <id>', 'run holding the draft')
    .requiredOption('--id <id>', 'defect id (DEF-…)')
    .requiredOption('--by <name>', 'who approved the text (a name or role, never an email)')
    .action(async (o: { run: string; id: string; by: string }) => {
      const root = rootOf();
      const { draft } = readDefect(root, o.run, o.id);
      const org = await orgFacts(root, draft.org);
      const a = new ApprovalStore(approvalsFile(root)).record({
        checkpoint: PUBLISH_DEFECT_CHECKPOINT,
        subject: defectSubject(draft.id, draft.sha256 ?? ''),
        orgId: org.orgId,
        approvedBy: o.by,
        runId: o.run,
        note: `bug ${draft.id}: ${draft.title}`,
      });
      say(
        `Approval ${a.id} recorded for ${draft.id} (sha256 ${draft.sha256?.slice(0, 16) ?? '?'}…) by ${o.by}. Publishing still needs policy.defectPublication (project + field mapping).`,
      );
    });

  defects
    .command('publish')
    .description(
      'Post an approved, CONFIRMED, LIVE bug: Rovo MCP createJiraIssue with --mcp, else JIRA REST; audited, never twice',
    )
    .requiredOption('--run <id>', 'run holding the draft')
    .requiredOption('--id <id>', 'defect id (DEF-…)')
    .option('--mcp', 'try Atlassian Rovo MCP first')
    .action(async (o: { run: string; id: string; mcp?: boolean }) => {
      const root = rootOf();
      const { draft, text } = readDefect(root, o.run, o.id);
      const org = await orgFacts(root, draft.org);
      const policy = await requireConfig('policy', projectPaths(root));
      const approval = new ApprovalStore(approvalsFile(root)).find(
        PUBLISH_DEFECT_CHECKPOINT,
        defectSubject(draft.id, draft.sha256 ?? ''),
        org.orgId,
      );
      const env0 = await loadEnv(root);
      const token = (await new SecretStore(env0).get('JIRA_API_TOKEN')).value;
      const env = { ...env0, ...(token ? { JIRA_API_TOKEN: token } : {}) };
      const redactor = new Redactor({ secrets: secretValues(env) });
      const audit = new AuditLog(runPaths(root, o.run).auditLog, redactor);
      let hub: McpHub | undefined;
      if (o.mcp && approval) {
        const guard: MutationGuard = ({ server, tool, args }) =>
          Promise.resolve(
            server === 'atlassian-rovo' && tool === BUG_TOOL && args['description'] === text
              ? { allowed: true as const, approvalId: approval.id }
              : { allowed: false as const, reason: 'only the approved bug text may be created' },
          );
        const servers = (await loadMcpJson(root)).mcpServers;
        if (servers['atlassian-rovo']) {
          hub = new McpHub({
            servers: { 'atlassian-rovo': servers['atlassian-rovo'] },
            allowList: new ToolAllowList(await requireConfig('mcp-tools', projectPaths(root))),
            audit,
            redactor,
            mutationGuard: guard,
            connectTimeoutMs: 120_000,
          });
        }
      }
      try {
        const r = await publishDefect({
          draft,
          text,
          approval,
          policy,
          env: { JIRA_BASE_URL: env.JIRA_BASE_URL, JIRA_EMAIL: env.JIRA_EMAIL, JIRA_API_TOKEN: env.JIRA_API_TOKEN },
          audit,
          ctx: { runId: o.run, orgId: org.orgId, user: 'sf-qa-agent', persona: 'defect-judge' },
          ledgerFile: join(root, '.qa-memory', 'publications.jsonl'),
          ...(hub ? { mcp: hub } : {}),
          log: say,
        });
        say(
          `Posted ${draft.id} as ${r.key} via ${r.via === 'mcp' ? 'Atlassian Rovo MCP' : 'JIRA REST'}${r.url ? ` — ${r.url}` : ''}.`,
        );
      } finally {
        await hub?.close();
      }
    });
}
