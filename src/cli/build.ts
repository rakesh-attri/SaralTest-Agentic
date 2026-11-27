// qa build — Phase 4: generate Playwright specs for the APPROVED cases of a `qa design` run, review them (pass 2),
// and check that they lint, typecheck and resolve (tsc, ESLint, playwright --list, locator dry-run). No execution.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { z } from 'zod';
import type { GenerationContext, RecipeView } from '../agents/test-generator/context.js';
import { runDryRun } from '../agents/test-generator/dryRun.js';
import { buildCatalog, type PageCatalog } from '../agents/test-generator/pageObjects.js';
import { runToolchain } from '../agents/test-generator/toolchain.js';
import { projectPaths, requireConfig } from '../config/loader.js';
import { QAError } from '../core/errors.js';
import { newRunId, runPaths } from '../core/runFolder.js';
import { isAutomatable, RtmRow, TestCase } from '../core/schemas/testCase.js';
import { Autonomy, initialRunState } from '../core/state.js';
import type { BuildHook, BuildDeps } from '../graph/buildNodes.js';
import { summarizeBuild } from '../graph/buildReport.js';
import type { QAGraphStateType } from '../graph/state.js';
import { LocatorRegistry } from '../knowledge/locatorRegistry.js';
import { SnapshotStore } from '../knowledge/snapshotStore.js';
import { createSfContext } from '../sf/context.js';
import { applyCaseEdits, loadCaseEdits } from '../inputs/caseEdits.js';
import { TestCaseIdStore } from '../agents/test-planner/index.js';
import { refreshCaseWording } from '../inputs/caseRefresh.js';
import {
  refreshStaleMarks,
  registryLookup,
  staleReason,
  storyManifestFile,
} from '../agents/test-generator/staleness.js';
import { buildDataPlan, loadRecipe, RECIPE_DIR, SnapshotFacts } from '../sf/data/plan.js';
import { createRuntime, parseModelChain } from './analyze.js';
import { registryFile } from './locators.js';
import { ObservedMessageStore } from '../knowledge/observedMessages.js';
import type { ObservedMessage } from '../core/schemas/execution.js';

/** Latest UI-observed messages of an org (empty when none were captured). */
function observedFor(root: string, orgId: string): ObservedMessage[] {
  const store = new ObservedMessageStore(join(root, '.qa-memory', 'knowledge.db'));
  try {
    return store.latest(orgId);
  } finally {
    store.close();
  }
}

type Say = (msg: string) => void;

const DesignRunInfo = z.looseObject({
  runId: z.string(),
  storyKey: z.string().optional(),
  status: z.string(),
  designEnvironment: z.string().optional(),
  orgEnvironment: z.string().optional(),
  snapshotId: z.string().optional(),
});

export interface DesignRunSeed {
  runId: string;
  storyKey: string;
  testCases: TestCase[];
  info: z.infer<typeof DesignRunInfo>;
}

/** Load a `qa design` run's reviewed cases (`runs/<id>/design/test-cases.json`), Zod-validated. */
export function loadDesignRun(root: string, runId: string): DesignRunSeed {
  const dir = join(runPaths(root, runId).dir, 'design');
  const casesFile = join(dir, 'test-cases.json');
  if (!existsSync(casesFile)) {
    throw new QAError('DATA', `no design output in ${dir}`, {
      fix: `run: pnpm qa design --from-run <analysis run> --org <alias>`,
    });
  }
  const testCases = z.array(TestCase).parse(JSON.parse(readFileSync(casesFile, 'utf8')));
  const info = DesignRunInfo.parse(JSON.parse(readFileSync(join(dir, 'design-run.json'), 'utf8')));
  const storyKey = info.storyKey ?? testCases[0]?.tags.find((t) => /^@[A-Z][A-Z0-9]+-\d+$/.test(t))?.slice(1) ?? runId;
  return { runId, storyKey, testCases, info };
}

/**
 * Evidence ids a design run can cite: source sections (`<docId>#<ref>`), design evidence ids and every id those
 * entries cite. Operator-added cases (case edits `addCases`) may cite only these (CLAUDE.md rule 12).
 */
export function designEvidenceIds(root: string, runId: string): Set<string> {
  const out = new Set<string>();
  const dir = runPaths(root, runId).dir;
  const sources = join(dir, 'analysis', 'sources');
  if (existsSync(sources)) {
    for (const f of readdirSync(sources).filter((x) => x.endsWith('.json'))) {
      const doc = JSON.parse(readFileSync(join(sources, f), 'utf8')) as {
        docId?: string;
        sections?: { ref?: string }[];
      };
      for (const sec of doc.sections ?? []) if (doc.docId && sec.ref) out.add(`${doc.docId}#${sec.ref}`);
    }
  }
  const ev = join(dir, 'design', 'evidence.json');
  if (existsSync(ev)) {
    for (const e of JSON.parse(readFileSync(ev, 'utf8')) as { id?: string; sources?: string[] }[]) {
      if (e.id) out.add(e.id);
      for (const x of e.sources ?? []) out.add(x);
    }
  }
  return out;
}

export interface BuildRuntimeOptions {
  root: string;
  orgAlias: string;
  personaId?: string;
  runId: string;
  designRunId: string;
  storyKey: string;
  offline?: boolean;
  /** Partial rebuild (`--cases`): keep the other specs and manifest entries. */
  merge?: boolean;
  say: Say;
}

/** Generation inputs + checks for `qa build` (local reads; the dry-run is the only org/browser access). */
export function createBuild(
  o: BuildRuntimeOptions,
): Omit<BuildDeps, 'root' | 'router' | 'skills' | 'redactor' | 'logger' | 'say'> {
  let catalog: PageCatalog | undefined;
  const hook: BuildHook = async () => {
    const paths = projectPaths(o.root);
    const orgs = await requireConfig('orgs', paths);
    const personas = await requireConfig('personas', paths);
    const org = orgs.orgs.find((x) => x.alias === o.orgAlias);
    if (!org) throw new QAError('ENVIRONMENT', `org alias "${o.orgAlias}" is not in config/orgs.yaml`);
    const persona = o.personaId ?? personas.defaultPersona;
    const snapshots = new SnapshotStore(join(o.root, '.qa-memory', 'knowledge.db'));
    const registry = new LocatorRegistry(registryFile(o.root));
    try {
      const info = snapshots.latest(org.orgId);
      const snap = info ? snapshots.get(info.id) : undefined;
      if (!snap)
        throw new QAError('DATA', `no snapshot for ${o.orgAlias}`, { fix: `pnpm qa discover --org ${o.orgAlias}` });
      const facts = new SnapshotFacts(snap);
      catalog = buildCatalog({
        entries: registry.list({ org: org.orgId }),
        org: org.orgId,
        orgAlias: org.alias,
        environment: org.environment,
        persona,
      });
      const recipeDir = join(o.root, RECIPE_DIR);
      const recipes: RecipeView[] = [];
      const notes: string[] = [];
      for (const f of existsSync(recipeDir) ? readdirSync(recipeDir).filter((x) => /\.ya?ml$/.test(x)) : []) {
        const name = f.replace(/\.ya?ml$/, '');
        try {
          const loaded = loadRecipe(o.root, name);
          const plan = buildDataPlan({ loaded, facts, org, runId: o.runId });
          recipes.push({ name, plan });
          notes.push(
            `Recipe ${name}: ${plan.valid ? 'valid' : 'INVALID'} against ${snap.info.id} (approved by ${loaded.recipe.approvedBy}).`,
          );
        } catch (e) {
          notes.push(`Recipe ${name} not usable: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const members = catalog.pages.reduce((n, p) => n + p.members.length, 0);
      notes.unshift(
        `Page catalog: ${catalog.pages.map((p) => `${p.className}=${p.members.length}`).join(', ')} (${members} members, ${org.environment}, persona ${persona}). Snapshot facts: ${snap.info.id}.`,
      );
      const ctx: GenerationContext = {
        storyKey: o.storyKey,
        designRunId: o.designRunId,
        snapshotId: snap.info.id,
        orgAlias: org.alias,
        environment: org.environment,
        catalog,
        recipes,
        facts,
        personas: personas.personas.map((p) => p.id),
        observedMessages: observedFor(o.root, org.orgId),
      };
      if (ctx.observedMessages?.length)
        notes.push(`Observed messages (OBSERVED evidence): ${String(ctx.observedMessages.length)} for ${org.alias}.`);
      return { ctx, notes };
    } finally {
      snapshots.close();
      registry.close();
    }
  };
  return {
    build: hook,
    ...(o.merge ? { merge: true } : {}),
    toolchain: (files) => runToolchain(o.root, files),
    ...(o.offline
      ? {}
      : {
          dryRun: async (refs: string[], personaId?: string) => {
            if (!catalog) throw new QAError('UNKNOWN', 'dry-run before the build inputs were loaded');
            const persona = personaId ?? o.personaId;
            const ctx = await createSfContext({
              root: o.root,
              runId: o.runId,
              orgAlias: o.orgAlias,
              ...(persona ? { personaId: persona } : {}),
            });
            const sf = await ctx.connect();
            o.say(
              `Identity verified for the dry-run: ${sf.identity.orgId} as ${sf.identity.username} (${sf.identity.environment}).`,
            );
            return runDryRun({ ctx, sf, catalog, refs, log: () => undefined });
          },
        }),
  };
}

export function buildSummaryText(v: QAGraphStateType, root: string): string {
  const s = summarizeBuild(v, v.status);
  const lines = [
    `Build ${s.runId}: ${s.status} — ${s.specs.length} spec(s) for ${s.approvedCases} APPROVED case(s): ${s.counts.APPROVED} APPROVED, ${s.counts.REVIEW_REQUIRED} REVIEW_REQUIRED, ${s.counts.BLOCKED} BLOCKED.`,
    `  generator/judge: ${s.models.join(', ') || 'none (mechanical)'}${s.buildEnvironment === 'MOCK' ? ' [MOCK]' : ''}`,
    s.toolchain
      ? `  tsc ${s.toolchain.typecheckErrors} error(s) · ESLint ${s.toolchain.lintErrors} error(s) · listed ${s.toolchain.listed}/${s.specs.length}${s.toolchain.toolErrors.length ? ` · tool errors: ${s.toolchain.toolErrors.join('; ')}` : ''}`
      : '  toolchain: not run',
    s.dryRun
      ? `  dry-run: ${s.dryRun.ok ? 'OK' : 'FAILED'} ${s.dryRun.resolved}/${s.dryRun.checked} (${s.dryRun.environment})`
      : '  dry-run: not run (offline)',
    `  pass 2: ${s.pass2.rounds} round(s), ${s.pass2.findings} finding(s), ${s.pass2.open} open`,
    ...s.specs.map((x) => `  ${x.reviewStatus ?? '-'} ${x.path}`),
    `Report: ${join(runPaths(root, s.runId).dir, 'build', 'build-report.md')}`,
  ];
  return lines.join('\n');
}

export function registerBuild(program: Command, rootOf: () => string, say: Say): void {
  program
    .command('build')
    .description('Generate + review Playwright specs for the APPROVED cases of a qa design run (Phase 4; no execution)')
    .requiredOption('--from-run <runId>', 'qa design run whose APPROVED test cases to generate')
    .requiredOption('--org <alias>', 'org whose locator registry / snapshot / recipes apply (config/orgs.yaml)')
    .option('--persona <id>', 'persona of the page objects + dry-run (default from personas.yaml)')
    .option('--run-id <id>', 'run id (default build-<timestamp>)')
    .option('--autonomy <level>', 'L1 | L2 | L3 (default: policy.yaml / QA_AUTONOMY)')
    .option('--offline', 'no model calls and no org/browser: mechanical skeletons, no dry-run')
    .option(
      '--coder <chain>',
      'coder models for this run only, in order, no other fallback: provider/model[,provider/model…] (append :json for response_format json_object, :no-tools to inline skills)',
    )
    .option('--cases <ids>', 'rebuild only these APPROVED cases (comma-separated); other generated specs are kept')
    .option(
      '--case-edits <file>',
      'operator edits to case wording (YAML, src/inputs/caseEdits.ts), applied before generation',
    )
    .option('--stale', 'rebuild only the specs marked STALE (a rule, field or locator they use changed)')
    .action(
      async (o: {
        fromRun: string;
        org: string;
        persona?: string;
        runId?: string;
        autonomy?: string;
        offline?: boolean;
        coder?: string;
        cases?: string;
        caseEdits?: string;
        stale?: boolean;
      }) => {
        const root = rootOf();
        const seed = loadDesignRun(root, o.fromRun);
        let editChanges: string[] = [];
        if (o.caseEdits) {
          const edits = loadCaseEdits(resolve(o.caseEdits));
          if (edits.storyKey !== seed.storyKey)
            throw new QAError('DATA', `case edits are for ${edits.storyKey}, the design run is ${seed.storyKey}`);
          const r = applyCaseEdits(seed.testCases, edits, designEvidenceIds(root, o.fromRun));
          seed.testCases = r.cases;
          editChanges = r.changes.map((c) => `${c} — ${edits.decidedBy}, ${edits.decidedOn}`);
          // Operator-added case ids are reserved in the story's id store, so a later design never reuses them.
          if (edits.addCases.length) {
            const ids = new TestCaseIdStore(seed.storyKey, join(root, '.qa-memory'));
            for (const c of r.cases.filter((x) => x.origin === 'operator')) {
              const got = ids.idFor(`operator|${c.id}`);
              if (got !== c.id)
                say(`  note: id store allocated ${got} for operator case ${c.id} (ids stay unique in this design run)`);
            }
            ids.save();
          }
          say(`Applied ${String(editChanges.length)} operator case edit(s) from ${o.caseEdits}:`);
          for (const c of editChanges) say(`  ${c}`);
        }
        // Snapshot currency: newer-snapshot warning, STALE marks, case wording refreshed from the latest snapshot.
        const current = await snapshotCurrency(root, o.org, seed.storyKey, seed.testCases);
        for (const n of current.notes) say(n);
        seed.testCases = current.cases;
        editChanges = [...editChanges, ...current.refreshChanges];
        if (o.stale && o.cases) throw new QAError('DATA', 'use --stale or --cases, not both');
        if (o.stale && !current.staleCases.length) {
          say('No stale specs: nothing to rebuild.');
          return;
        }
        const only = o.stale
          ? current.staleCases
          : o.cases
              ?.split(',')
              .map((x) => x.trim())
              .filter(Boolean);
        if (only) {
          const unknown = only.filter(
            (id) => !seed.testCases.some((c) => c.id === id && c.reviewStatus === 'APPROVED'),
          );
          if (unknown.length) throw new QAError('DATA', `not APPROVED cases of ${o.fromRun}: ${unknown.join(', ')}`);
          seed.testCases = seed.testCases.filter((c) => only.includes(c.id));
        }
        const coderChain = o.coder ? parseModelChain(o.coder) : undefined;
        if (coderChain) {
          say(
            `Coder chain for this run: ${coderChain.map((m) => `${m.provider}/${m.model}${m.responseFormat ? ' (JSON mode)' : ''}${m.tools === false ? ' (no tools)' : ''}`).join(' → ')} (no other fallback).`,
          );
        }
        const approved = seed.testCases.filter(isAutomatable);
        const manualOnly = seed.testCases.filter((c) => c.reviewStatus === 'APPROVED' && c.execution === 'manual');
        if (manualOnly.length)
          say(`Manual-only (no spec generated; RTM lists them as manual): ${manualOnly.map((c) => c.id).join(', ')}`);
        say(
          `Build for ${seed.storyKey} from design run ${o.fromRun} (${seed.info.status}, ${seed.info.designEnvironment ?? '?'}): ${approved.length} APPROVED of ${seed.testCases.length} cases.`,
        );
        const runId = o.runId ?? newRunId('build');
        const rt = await createRuntime({
          root,
          say,
          logFile: runPaths(root, runId).runLog,
          ...(coderChain ? { roleChains: { coder: coderChain } } : {}),
          ...(o.offline ? { offline: true } : {}),
          build: createBuild({
            root,
            orgAlias: o.org,
            ...(o.persona ? { personaId: o.persona } : {}),
            runId,
            designRunId: o.fromRun,
            storyKey: seed.storyKey,
            ...(o.offline ? { offline: true } : {}),
            ...(only ? { merge: true } : {}),
            say,
          }),
        });
        try {
          if (rt.checkpointer.threads().includes(runId)) {
            throw new QAError(
              'DATA',
              `run id ${runId} already exists in .qa-memory/checkpoints.db — use a new --run-id`,
            );
          }
          const autonomy = Autonomy.parse(o.autonomy ?? rt.env.QA_AUTONOMY ?? rt.policy.autonomy);
          const state = {
            ...initialRunState({
              runId,
              org: o.org,
              autonomy,
              source: { type: 'file' as const, ref: `run:${o.fromRun}` },
              storyKey: seed.storyKey,
              tokenLimit: 2_000_000,
              timeLimitMin: 90,
              inputs: [],
            }),
            testCases: seed.testCases,
            designRunId: o.fromRun,
            orgEnvironment: seed.info.orgEnvironment === 'FIXTURE' ? ('FIXTURE' as const) : ('LIVE' as const),
            interactive: false,
          };
          say(`Run ${runId} — output in ${runPaths(root, runId).dir}`);
          if (editChanges.length) {
            const dir = join(runPaths(root, runId).dir, 'build');
            mkdirSync(dir, { recursive: true });
            writeFileSync(
              join(dir, 'case-edits-applied.md'),
              [
                `# Operator case edits applied (${o.caseEdits ?? ''})`,
                '',
                ...editChanges.map((c) => `- ${c}`),
                '',
              ].join('\n'),
            );
          }
          const config = { configurable: { thread_id: runId } };
          await rt.graph.invoke(state, config);
          const v = (await rt.graph.getState(config)).values as QAGraphStateType;
          process.stdout.write(`${buildSummaryText(v, root)}\n`);
          const rtm = writeAutomationRtm(root, runId, o.fromRun, seed.storyKey, seed.testCases);
          if (rtm) say(`Automation RTM: ${rtm}`);
          process.exitCode = v.status === 'BLOCKED' ? 3 : 0;
        } finally {
          await rt.close();
        }
      },
    );
}

/**
 * RTM automation view of a build: per requirement, which cases are automated (spec + review status from the story
 * manifest), which are manual-only (operator ruling), and which have no spec (not APPROVED at design).
 */
export function writeAutomationRtm(
  root: string,
  runId: string,
  designRun: string,
  storyKey: string,
  cases: readonly TestCase[],
): string | undefined {
  const rtmFile = join(root, 'runs', designRun, 'design', 'rtm.json');
  const manifestFile = join(root, 'tests', 'generated', storyKey, 'manifest.json');
  if (!existsSync(rtmFile) || !existsSync(manifestFile)) return undefined;
  const rows = z.array(RtmRow).parse(JSON.parse(readFileSync(rtmFile, 'utf8')));
  const specOf = z.object({
    kind: z.string(),
    testCaseIds: z.array(z.string()),
    reviewStatus: z.string().optional(),
  });
  const artifacts = z
    .object({ artifacts: z.array(specOf) })
    .parse(JSON.parse(readFileSync(manifestFile, 'utf8')))
    .artifacts.filter((a) => a.kind === 'spec');
  const byId = new Map(cases.map((c) => [c.id, c]));
  const out = rows.map((r) => ({
    requirementId: r.requirementId,
    status: r.status,
    automated: r.testCaseIds.flatMap((id) => {
      const a = artifacts.find((x) => x.testCaseIds.includes(id));
      return a ? [{ caseId: id, reviewStatus: a.reviewStatus ?? 'REVIEW_REQUIRED' }] : [];
    }),
    manual: r.testCaseIds
      .filter((id) => byId.get(id)?.execution === 'manual')
      .map((id) => ({ caseId: id, reason: byId.get(id)?.executionReason ?? 'manual-only' })),
    notAutomated: r.testCaseIds.filter(
      (id) => byId.get(id)?.execution !== 'manual' && !artifacts.some((x) => x.testCaseIds.includes(id)),
    ),
  }));
  const dir = join(runPaths(root, runId).dir, 'build');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'rtm-automation.json'), `${JSON.stringify(out, null, 2)}\n`);
  const md = [
    `# RTM — automation view (${storyKey}, design ${designRun}, build ${runId})`,
    '',
    '| Requirement | RTM status | Automated (spec status) | Manual-only | No spec |',
    '|---|---|---|---|---|',
    ...out.map(
      (r) =>
        `| ${r.requirementId} | ${r.status} | ${r.automated.map((a) => `${a.caseId} (${a.reviewStatus})`).join(', ')} | ${r.manual.map((m) => m.caseId).join(', ')} | ${r.notAutomated.join(', ')} |`,
    ),
    '',
  ].join('\n');
  writeFileSync(join(dir, 'rtm-automation.md'), md);
  return join(dir, 'rtm-automation.md');
}

/**
 * How current the story's specs and cases are against the org's latest snapshot: STALE marks are refreshed (specs
 * whose rules / fields / locators changed), a newer snapshot than the specs were built on is reported, and case
 * wording that quotes an outdated rule message is refreshed from the latest snapshot.
 */
export async function snapshotCurrency(
  root: string,
  orgAlias: string,
  storyKey: string,
  cases: TestCase[],
): Promise<{ notes: string[]; cases: TestCase[]; refreshChanges: string[]; staleCases: string[] }> {
  const orgs = await requireConfig('orgs', projectPaths(root));
  const org = orgs.orgs.find((x) => x.alias === orgAlias);
  if (!org) throw new QAError('ENVIRONMENT', `org alias "${orgAlias}" is not in config/orgs.yaml`);
  const store = new SnapshotStore(join(root, '.qa-memory', 'knowledge.db'));
  const registry = new LocatorRegistry(registryFile(root));
  try {
    const info = store.latest(org.orgId);
    const snap = info ? store.get(info.id) : undefined;
    if (!snap) return { notes: [], cases, refreshChanges: [], staleCases: [] };
    const latest = new SnapshotFacts(snap);
    const notes: string[] = [];
    const manifestFile = storyManifestFile(root, storyKey);
    const built = existsSync(manifestFile)
      ? z
          .object({ artifacts: z.array(z.object({ kind: z.string(), snapshotId: z.string().optional() })) })
          .parse(JSON.parse(readFileSync(manifestFile, 'utf8')))
          .artifacts.filter((a) => a.kind === 'spec')
          .map((a) => a.snapshotId ?? '?')
      : [];
    const older = [...new Set(built.filter((id) => id !== snap.info.id))];
    if (older.length)
      notes.push(
        `WARNING: a newer snapshot exists — ${snap.info.id} (${snap.info.capturedAt}); specs of ${storyKey} were built on ${older.join(', ')}.`,
      );
    const st = refreshStaleMarks({
      root,
      facts: latest,
      locator: registryLookup(registry.list({ org: org.orgId })),
      stories: [storyKey],
      orgAlias,
    });
    for (const x of st.stale) notes.push(`STALE ${x.caseId}: ${staleReason(x.stale)}`);
    if (st.untracked.length)
      notes.push(
        `Untracked (built before dependency tracking, staleness unknown): ${st.untracked.map((u) => u.caseId).join(', ')}`,
      );
    if (st.stale.length)
      notes.push(`Rebuild the stale specs with: pnpm qa build --from-run <design run> --org ${orgAlias} --stale`);
    const r = refreshCaseWording(
      cases,
      (id) => {
        const s = store.get(id);
        return s ? new SnapshotFacts(s) : undefined;
      },
      latest,
    );
    if (r.changes.length) {
      notes.push(`Case wording refreshed from ${snap.info.id}:`);
      for (const c of r.changes) notes.push(`  ${c}`);
    }
    return {
      notes,
      cases: r.cases,
      refreshChanges: r.changes,
      staleCases: [...new Set(st.stale.map((x) => x.caseId))],
    };
  } finally {
    store.close();
    registry.close();
  }
}
