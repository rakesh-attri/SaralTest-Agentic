// `qa explore` (Phase 7 Autonomous Explorer): one time-boxed charter, approved actions only, read-mostly.
//   qa explore --org <alias> [--charter contact-create] [--minutes 10] [--model]
//   qa explore promote --run <id> --finding <XF-…> --by "<name>"   (human; never automatic)
//   qa explore list --run <id>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { projectPaths, requireConfig } from '../config/loader.js';
import { QAError } from '../core/errors.js';
import { newRunId } from '../core/runFolder.js';
import { ExplorationCharter, RtmRow, TestCase, type Environment } from '../core/schemas/index.js';
import type { Autonomy } from '../core/state.js';
import { contactCreateCatalog } from '../agents/autonomous-explorer/catalog.js';
import { playwrightDriver } from '../agents/autonomous-explorer/driver.js';
import { runCharter } from '../agents/autonomous-explorer/index.js';
import { renderExplorationHtml, renderExplorationMd } from '../agents/autonomous-explorer/report.js';
import {
  draftCase,
  exploreDir,
  promoteFinding,
  readExploration,
  reviewDraft,
  type DraftCase,
} from '../agents/autonomous-explorer/review.js';
import { ledgerFile } from '../agents/failure-investigator/run.js';
import { EvidenceLedger } from '../knowledge/evidenceLedger.js';
import { SnapshotStore } from '../knowledge/snapshotStore.js';
import { ensureStorageState, playwrightLauncher } from '../sf/auth/browserState.js';
import { soqlString } from '../sf/data/engine.js';
import { SnapshotFacts } from '../sf/data/plan.js';
import { openDataSession } from '../sf/dataFactory.js';
import { createModelDeps } from './modelDeps.js';
import { z } from 'zod';

type Say = (msg: string) => void;

/** Requirements the charter targets and why (RTM of the story's design run: rows without APPROVED coverage). */
export function charterReason(
  root: string,
  storyKey: string,
): { requirementIds: string[]; reason: string; design: TestCase[] } {
  const mf = join(root, 'tests', 'generated', storyKey, 'manifest.json');
  const designRun = existsSync(mf)
    ? (JSON.parse(readFileSync(mf, 'utf8')) as { designRun?: string }).designRun
    : undefined;
  const dir = designRun ? join(root, 'runs', designRun, 'design') : undefined;
  if (!dir || !existsSync(join(dir, 'rtm.json')))
    return { requirementIds: [], reason: "Contact creation is the story's core flow (no RTM available)", design: [] };
  const rtm = z.array(RtmRow).safeParse(JSON.parse(readFileSync(join(dir, 'rtm.json'), 'utf8')));
  const design = z.array(TestCase).safeParse(JSON.parse(readFileSync(join(dir, 'test-cases.json'), 'utf8')));
  const rows = rtm.success ? rtm.data : [];
  const open = rows.filter((r) => r.status !== 'designed' && r.status !== 'excluded');
  return {
    requirementIds: open.map((r) => r.requirementId).slice(0, 12),
    reason: `${String(open.length)} of ${String(rows.length)} requirements of ${storyKey} have no APPROVED design coverage (RTM ${designRun ?? '?'}: review-required / blocked / gap) — Contact creation carries most of them`,
    design: design.success ? design.data : [],
  };
}

export function registerExplore(program: Command, rootOf: () => string, say: Say): void {
  const explore = program
    .command('explore')
    .description(
      'Autonomous Explorer: one time-boxed, read-mostly charter; findings become draft cases a human promotes',
    )
    .option('--org <alias>', 'org alias from config/orgs.yaml')
    .option('--charter <id>', 'charter (contact-create)', 'contact-create')
    .option('--story <key>', 'story whose RTM explains the charter', 'SF-219')
    .option('--minutes <n>', 'time box (default policy.exploration.charterMinutes)')
    .option('--autonomy <level>', 'L1 | L2 | L3 (default: policy)')
    .option('--model', 'let the reasoning model pick among the top-scored actions')
    .option('--run-id <id>', 'run id (default explore-<timestamp>)')
    .action(
      async (o: {
        org?: string;
        charter: string;
        story: string;
        minutes?: string;
        autonomy?: Autonomy;
        model?: boolean;
        runId?: string;
      }) => {
        if (!o.org) {
          explore.help();
          return;
        }
        if (o.charter !== 'contact-create')
          throw new QAError('DATA', `unknown charter ${o.charter} (available: contact-create)`);
        const root = rootOf();
        const runId = o.runId ?? newRunId('explore');
        const policy = await requireConfig('policy', projectPaths(root));
        const why = charterReason(root, o.story);
        // Seed Account from the approved recipe (refused here when the recipe version is not approved for the org).
        const session = await openDataSession({
          root,
          runId,
          recipe: 'account-contact',
          orgAlias: o.org,
          ...(o.autonomy ? { autonomy: o.autonomy } : {}),
          log: () => undefined,
        });
        const { ctx, sf, engine } = session;
        const environment: Environment = ctx.org.environment;
        say(`Identity verified: ${sf.identity.orgId} (${environment}).`);
        const charter = ExplorationCharter.parse({
          id: `CH-${o.charter}`,
          area: o.charter,
          persona: ctx.persona.id,
          resources: 'New Contact dialog opened from a run-tagged Account (approved recipe account-contact)',
          risk: 'Contact rules (required fields, formats, validation rules) not enforced or explained in the UI',
          mission: `Explore Contact creation as ${ctx.persona.id} with a run-tagged Account to discover whether the org's declared Contact rules are enforced and explained in the New Contact dialog`,
          timeBoxMin: Number(o.minutes ?? policy.exploration.charterMinutes),
          maxSteps: policy.exploration.maxStepsPerCharter,
          maxSaves: policy.exploration.maxSavesPerCharter,
          saturationSteps: policy.exploration.saturationSteps,
          stopConditions: [
            'time-box',
            'max-steps',
            'saturation',
            'error-budget (3 failed actions)',
            'off-domain navigation',
            'hard stop',
            'catalog done',
          ],
          reason: why.reason,
          requirementIds: why.requirementIds,
        });
        say(`Charter: ${charter.mission}`);
        say(`  why: ${charter.reason}`);
        say(
          `  limits: ${String(charter.timeBoxMin)} min · ${String(charter.maxSteps)} steps · ${String(charter.maxSaves)} guarded saves`,
        );
        const snapshots = new SnapshotStore(join(root, '.qa-memory', 'knowledge.db'));
        const info = snapshots.latest(ctx.org.orgId);
        const snap = info ? snapshots.get(info.id) : undefined;
        snapshots.close();
        const facts = snap ? new SnapshotFacts(snap) : undefined;
        await engine.create(['Account']);
        const accountId = engine.recordId('Account');
        const started = new Date(Date.now() - 5 * 60_000);
        const state = await ensureStorageState({
          provider: ctx.provider,
          request: { persona: ctx.persona, org: ctx.org },
          authDir: ctx.authDir,
          ttlMinutes: ctx.personas.sessionTtlMinutes,
          browser: ctx.execution.browser,
          headless: ctx.execution.headless,
        });
        const baseUrl =
          new URL(ctx.org.instanceUrl).hostname === state.landedHost
            ? ctx.org.instanceUrl.replace(/\/+$/, '')
            : `${new URL(ctx.org.instanceUrl).protocol}//${state.landedHost}${new URL(ctx.org.instanceUrl).port ? `:${new URL(ctx.org.instanceUrl).port}` : ''}`;
        const browser = await playwrightLauncher({ browser: ctx.execution.browser, headless: ctx.execution.headless });
        const m = await createModelDeps({ root, say, noModel: !o.model, roles: o.model ? ['reasoning'] : [] });
        const ledger = new EvidenceLedger(ledgerFile(root));
        const dir = exploreDir(root, runId);
        try {
          ledger.removeRun(runId, ['exploration']);
          const driver = await playwrightDriver({
            browser,
            storageStatePath: state.path,
            baseUrl,
            accountId,
            evidenceDir: join(dir, 'evidence'),
            root,
            redact: (s) => ctx.redactor.redactText(s),
          });
          const report = await runCharter(
            {
              root,
              runId,
              orgAlias: ctx.org.alias,
              environment,
              charter,
              catalog: contactCreateCatalog(),
              runPrefix: `QA-${runId}`.slice(0, 40),
              useModel: Boolean(o.model),
            },
            {
              driver,
              facts,
              ledger,
              ...(m.router ? { router: m.router } : {}),
              redactor: ctx.redactor,
              logger: m.logger,
              say,
              org: {
                host: new URL(baseUrl).host,
                contactsOnAccount: async () =>
                  (
                    await sf.query<{ Id: string }>(`SELECT Id FROM Contact WHERE AccountId = ${soqlString(accountId)}`)
                  ).map((r) => r.Id),
                adopt: async (id, label) => {
                  await engine.adoptCreated(label, 'Contact', id, sf.identity.userId, started);
                },
                uiAttempt: (fn) => sf.uiAttempt('explore-save-attempt', 'Contact', fn),
                cleanup: async () => ((await engine.cleanup()).status === 'CLEAN' ? 'CLEAN' : 'INCOMPLETE'),
              },
            },
          );
          const drafts: DraftCase[] = report.findings.map((f) => {
            const tc = draftCase(f, {
              storyKey: o.story,
              persona: ctx.persona.id,
              snapshotId: snap?.info.id ?? 'none',
              requirementIds: charter.requirementIds.slice(0, 3),
            });
            return { findingId: f.id, testCase: tc, review: reviewDraft(f, tc, why.design) };
          });
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'exploration.json'), `${JSON.stringify(report, null, 2)}\n`);
          writeFileSync(join(dir, 'draft-cases.json'), `${JSON.stringify(drafts, null, 2)}\n`);
          writeFileSync(join(dir, 'exploration-report.md'), renderExplorationMd(report, drafts));
          writeFileSync(join(dir, 'exploration-report.html'), renderExplorationHtml(report, drafts));
          ledger.exportRun(runId, join(root, 'runs', runId, 'evidence', 'evidence.json'));
          say(`${report.coverageNote}; data ${report.dataCleanup}`);
          for (const f of report.findings) say(`  ${f.id} ${f.kind} (${f.suggestion}): ${f.title}`);
          say(`Report: ${join(dir, 'exploration-report.md')} (${environment})`);
          say(`Audit: ${ctx.run.auditLog}`);
          process.exitCode = report.dataCleanup === 'CLEAN' ? 0 : 1;
        } finally {
          ledger.close();
          await browser.close().catch(() => undefined);
        }
      },
    );

  explore
    .command('list')
    .description('Findings of an exploration run and their review / promotion state')
    .requiredOption('--run <id>', 'exploration run id')
    .action((o: { run: string }) => {
      const { report, drafts } = readExploration(rootOf(), o.run);
      say(`${report.runId} [${report.environment}] ${report.coverageNote}`);
      for (const f of report.findings) {
        const d = drafts.find((x) => x.findingId === f.id);
        const blocking = d?.review.filter((n) => n.blocking).length ?? 0;
        say(
          `  ${f.id} ${f.kind} — ${f.title} · ${f.promoted ? `promoted to ${f.testCaseId ?? '?'}` : blocking ? `${String(blocking)} blocking review note(s)` : 'ready for human promotion'}`,
        );
      }
    });

  explore
    .command('promote')
    .description(
      'Human promotion of a reviewed finding into a story test case (APPROVED only if every expectation is assertable)',
    )
    .requiredOption('--run <id>', 'exploration run id')
    .requiredOption('--finding <id>', 'finding id (XF-…)')
    .requiredOption('--by <name>', 'who reviewed and promotes it (a name or role, never an email)')
    .option('--story <key>', 'story the case belongs to', 'SF-219')
    .action(async (o: { run: string; finding: string; by: string; story: string }) => {
      const root = rootOf();
      const { report } = readExploration(root, o.run);
      const orgs = await requireConfig('orgs', projectPaths(root));
      const org = orgs.orgs.find((x) => x.alias === report.org);
      const r = promoteFinding({
        root,
        runId: o.run,
        findingId: o.finding,
        by: o.by,
        storyKey: o.story,
        orgId: org?.orgId ?? '00D000000000000AAA',
      });
      say(`${o.finding} → ${r.caseId} (${r.reviewStatus}) · approval ${r.approvalId} · ${r.editsFile}`);
      say(
        `Build it with: pnpm qa build --from-run <design run> --org ${report.org} --case-edits examples/case-edits/${o.story}.yaml,${r.editsFile.split(/[\\/]/).pop() ?? ''} --cases ${r.caseId}`,
      );
    });
}
