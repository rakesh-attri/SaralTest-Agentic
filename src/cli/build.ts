// qa build — Phase 4: generate Playwright specs for the APPROVED cases of a `qa design` run, review them (pass 2),
// and check that they lint, typecheck and resolve (tsc, ESLint, playwright --list, locator dry-run). No execution.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { z } from 'zod';
import type { GenerationContext, RecipeView } from '../agents/test-generator/context.js';
import { runDryRun } from '../agents/test-generator/dryRun.js';
import { buildCatalog, type PageCatalog } from '../agents/test-generator/pageObjects.js';
import { runToolchain } from '../agents/test-generator/toolchain.js';
import { projectPaths, requireConfig } from '../config/loader.js';
import { QAError } from '../core/errors.js';
import { newRunId, runPaths } from '../core/runFolder.js';
import { TestCase } from '../core/schemas/testCase.js';
import { Autonomy, initialRunState } from '../core/state.js';
import type { BuildHook, BuildDeps } from '../graph/buildNodes.js';
import { summarizeBuild } from '../graph/buildReport.js';
import type { QAGraphStateType } from '../graph/state.js';
import { LocatorRegistry } from '../knowledge/locatorRegistry.js';
import { SnapshotStore } from '../knowledge/snapshotStore.js';
import { createSfContext } from '../sf/context.js';
import { buildDataPlan, loadRecipe, RECIPE_DIR, SnapshotFacts } from '../sf/data/plan.js';
import { createRuntime, parseModelChain } from './analyze.js';
import { registryFile } from './locators.js';

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
      };
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
          dryRun: async (refs: string[]) => {
            if (!catalog) throw new QAError('UNKNOWN', 'dry-run before the build inputs were loaded');
            const ctx = await createSfContext({
              root: o.root,
              runId: o.runId,
              orgAlias: o.orgAlias,
              ...(o.personaId ? { personaId: o.personaId } : {}),
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
      }) => {
        const root = rootOf();
        const seed = loadDesignRun(root, o.fromRun);
        const only = o.cases
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
        const approved = seed.testCases.filter((c) => c.reviewStatus === 'APPROVED');
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
          const config = { configurable: { thread_id: runId } };
          await rt.graph.invoke(state, config);
          const v = (await rt.graph.getState(config)).values as QAGraphStateType;
          process.stdout.write(`${buildSummaryText(v, root)}\n`);
          process.exitCode = v.status === 'BLOCKED' ? 3 : 0;
        } finally {
          await rt.close();
        }
      },
    );
}
