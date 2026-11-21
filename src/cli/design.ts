import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { Command } from 'commander';
import { z } from 'zod';
import { crossCheckRequirements } from '../agents/sf-intelligence/crossCheck.js';
import { buildContext, type DesignHook } from '../graph/designNodes.js';
import { summarizeDesign, writeDesignReport } from '../graph/designReport.js';
import { reviewRound, settleFindings } from '../agents/test-reviewer/index.js';
import { buildCases, buildRtm, mechanicalDrafts, TestCaseIdStore } from '../agents/test-planner/index.js';
import { projectPaths, requireConfig } from '../config/loader.js';
import { QAError } from '../core/errors.js';
import { newRunId, runPaths } from '../core/runFolder.js';
import {
  AnalysisFinding,
  Clarification,
  DefectRecord,
  ManualTestCase,
  Requirement,
  SourceDocument,
} from '../core/schemas/index.js';
import { Autonomy, initialRunState } from '../core/state.js';
import { diffSnapshots } from '../knowledge/diff.js';
import { LocatorRegistry } from '../knowledge/locatorRegistry.js';
import { SnapshotStore } from '../knowledge/snapshotStore.js';
import { GraphStore } from '../sf/graph/index.js';
import type { QAGraphStateType } from '../graph/state.js';
import { createRuntime } from './analyze.js';

type Say = (msg: string) => void;

/**
 * Phase 3 design inputs for an org: the stored snapshot (latest or a given id), a fresh deterministic cross-check of
 * the run's requirements against it, the diff with the previous snapshot + graph impact, open RE_VERIFY marks, the
 * locator registry, personas.yaml and the data recipes. Local reads only — no Salesforce call, no mutation.
 */
export function createDesignHook(o: { root: string; orgAlias: string; snapshotId?: string }): DesignHook {
  return async (s) => {
    const paths = projectPaths(o.root);
    const orgs = await requireConfig('orgs', paths);
    const personas = await requireConfig('personas', paths);
    const org = orgs.orgs.find((x) => x.alias === o.orgAlias);
    if (!org) {
      throw new QAError('ENVIRONMENT', `org alias "${o.orgAlias}" is not in config/orgs.yaml`, {
        known: orgs.orgs.map((x) => x.alias),
      });
    }
    const mem = join(o.root, '.qa-memory');
    const snapshots = new SnapshotStore(join(mem, 'knowledge.db'));
    const graph = existsSync(join(mem, 'graph.db')) ? new GraphStore(join(mem, 'graph.db')) : undefined;
    const registry = existsSync(join(mem, 'locators.db')) ? new LocatorRegistry(join(mem, 'locators.db')) : undefined;
    try {
      const info =
        o.snapshotId && o.snapshotId !== 'latest' ? snapshots.get(o.snapshotId)?.info : snapshots.latest(org.orgId);
      const snap = info ? snapshots.get(info.id) : undefined;
      if (!snap) {
        throw new QAError(
          'DATA',
          `no stored snapshot ${o.snapshotId && o.snapshotId !== 'latest' ? o.snapshotId : 'yet'} for org ${o.orgAlias}`,
          {
            fix: `run: pnpm qa discover --org ${o.orgAlias}`,
          },
        );
      }
      if (snap.info.orgId !== org.orgId) {
        throw new QAError(
          'ENVIRONMENT',
          `snapshot ${snap.info.id} belongs to org ${snap.info.orgId}, not ${o.orgAlias} (${org.orgId})`,
        );
      }
      const configured = personas.personas.map((p) => ({ id: p.id, profile: p.profile }));
      const cc = crossCheckRequirements({
        snapshot: snap,
        requirements: s.requirements,
        findings: s.findings,
        configuredPersonas: configured.flatMap((p) => [p.id, p.profile]),
      });
      const prevInfo = snapshots.latest(org.orgId, snap.info.id);
      const prev = prevInfo ? snapshots.get(prevInfo.id) : undefined;
      const diff = prev
        ? diffSnapshots(
            { id: prev.info.id, orgId: prev.info.orgId, objects: prev.info.objects, components: prev.components },
            { id: snap.info.id, orgId: snap.info.orgId, objects: snap.info.objects, components: snap.components },
          )
        : undefined;
      const changed = (diff?.entries ?? []).filter((e) => e.change !== 'unknown').map((e) => `${e.type}:${e.apiName}`);
      const impacted = graph && changed.length ? graph.impact(org.orgId, changed, 3) : [];
      const orgSnapIds = new Set(snapshots.list(org.orgId).map((x) => x.id));
      const reverify = [
        ...new Set(
          snapshots
            .openReverify()
            .filter((m) => orgSnapIds.has(m.snapshotId))
            .map((m) => `${m.assetType}:${m.assetId}`),
        ),
      ];
      const locators = registry?.list({ org: org.orgId }) ?? [];
      const recipeDir = join(o.root, 'examples', 'recipes');
      const recipes = existsSync(recipeDir)
        ? readdirSync(recipeDir)
            .filter((f) => /\.ya?ml$/i.test(f))
            .map((f) => basename(f, extname(f)))
        : [];
      return {
        snapshotId: snap.info.id,
        snapshotEnvironment: snap.info.environment,
        components: snap.components,
        orgChecks: cc.checks,
        locators,
        impact: {
          dependencies: impacted.map((i) => i.node.id),
          regressionCandidates: reverify,
          riskScores: {},
          changed,
          impacted: impacted.map((i) => ({ node: i.node.id, depth: i.depth, path: i.path })),
          reverify,
        },
        personas: configured,
        defaultPersona: personas.defaultPersona,
        recipes,
        notes: [
          `Design inputs: snapshot ${snap.info.id} (${snap.info.environment}, ${snap.info.capturedAt}, ${String(snap.components.length)} components, objects ${snap.info.objects.join(', ')})`,
          `  cross-check: ${Object.entries(cc.counts)
            .map(([k, v]) => `${k} ${String(v)}`)
            .join(
              ', ',
            )} · ${String(locators.length)} registry locators · ${String(reverify.length)} open RE_VERIFY marks · ${String(changed.length)} components changed since the previous snapshot`,
        ],
      };
    } finally {
      snapshots.close();
      graph?.close();
      registry?.close();
    }
  };
}

export interface SeedState {
  storyKey: string;
  sourceType: 'jira' | 'ado' | 'chat' | 'file';
  sources: SourceDocument[];
  requirements: Requirement[];
  findings: AnalysisFinding[];
  clarifications: Clarification[];
  existingTests: ManualTestCase[];
  defectHistory: DefectRecord[];
  story?: QAGraphStateType['story'];
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8')) as unknown;
const list = <T>(file: string, schema: z.ZodType<T>): T[] =>
  existsSync(file) ? z.array(schema).parse(readJson(file)) : [];

/** Load the outputs of an earlier `qa analyze` run (Zod-validated) to seed a design run. */
export function loadAnalysisRun(root: string, runId: string): SeedState {
  const dir = join(runPaths(root, runId).dir, 'analysis');
  if (!existsSync(join(dir, 'requirements.json'))) {
    throw new QAError('DATA', `run ${runId} has no analysis output (${join(dir, 'requirements.json')})`, {
      fix: 'run qa analyze first, or pass the id of a run that has runs/<id>/analysis/requirements.json',
    });
  }
  const srcDir = join(dir, 'sources');
  const sources = existsSync(srcDir)
    ? readdirSync(srcDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => SourceDocument.parse(readJson(join(srcDir, f))))
    : [];
  const run = existsSync(join(dir, 'run.json'))
    ? z.looseObject({ storyKey: z.string().optional() }).parse(readJson(join(dir, 'run.json')))
    : {};
  const requirements = list(join(dir, 'requirements.json'), Requirement);
  const jira = sources.find((d) => d.source.type === 'jira');
  const primary = jira ?? sources.find((d) => d.source.type !== 'manual-test');
  const storyKey = run.storyKey ?? primary?.docId ?? requirements[0]?.id.replace(/-R\d+$/, '') ?? runId;
  return {
    storyKey,
    sourceType: primary?.source.type === 'jira' ? 'jira' : primary?.source.type === 'ado' ? 'ado' : 'file',
    sources,
    requirements,
    findings: list(join(dir, 'findings.json'), AnalysisFinding),
    clarifications: list(join(dir, 'clarifications.json'), Clarification),
    existingTests: list(join(dir, 'existing-tests.json'), ManualTestCase),
    defectHistory: list(join(dir, 'defect-history.json'), DefectRecord),
    ...(jira
      ? {
          story: {
            key: jira.docId,
            summary: jira.title,
            acceptanceCriteria: jira.sections.filter((x) => x.kind === 'ac').map((x) => `${x.ref}: ${x.text}`),
            links: [],
          },
        }
      : {}),
  };
}

export function designSummary(v: QAGraphStateType, root: string): string {
  const sum = summarizeDesign(v);
  const dir = join(runPaths(root, v.runId).dir, 'design');
  const label =
    v.designEnvironment === 'MOCK'
      ? '  [MOCK model output]'
      : v.designEnvironment === 'NONE'
        ? '  [mechanical: no model]'
        : '';
  const lines = [
    '',
    `=== Test design ${v.storyKey ?? v.runId}: ${v.status} ===${label}${v.orgEnvironment === 'FIXTURE' ? '  [FIXTURE org]' : ''}`,
    `Snapshot: ${v.charter?.snapshotId ?? '—'} (${v.orgEnvironment}) · models: ${v.designModels.join(', ') || 'none'}`,
    `Risks: ${String(v.risks.length)} (${String(v.risks.filter((r) => r.tier === 'mandatory').length)} mandatory, ${String(v.risks.filter((r) => r.tier === 'recommended').length)} recommended, ${String(v.risks.filter((r) => r.tier === 'optional').length)} optional) · obligations: ${String(v.obligations.length)}`,
    `Cases: ${String(v.testCases.length)} — ${String(sum.status.APPROVED)} APPROVED, ${String(sum.status.REVIEW_REQUIRED)} REVIEW_REQUIRED, ${String(sum.status.BLOCKED)} BLOCKED`,
    `Exit criteria:`,
    `  [${sum.acCoverage.covered === sum.acCoverage.total ? 'x' : ' '}] every AC covered: ${String(sum.acCoverage.covered)}/${String(sum.acCoverage.total)} (${sum.acs.map((a) => `${a.ref}→${a.caseIds.length ? a.caseIds.join('+') : 'NONE'}`).join(', ')})`,
    `  [${sum.unlabelled === 0 ? 'x' : ' '}] every expectation evidence-labelled: ${String(sum.steps - sum.unlabelled)}/${String(sum.steps)} (${Object.entries(
      sum.levels,
    )
      .map(([k, n]) => `${k} ${String(n)}`)
      .join(', ')})`,
    `  [${sum.findings.open === 0 ? 'x' : ' '}] reviewer findings resolved or justified: ${String(sum.findings.resolved)} resolved, ${String(sum.findings.justified)} justified (${String(sum.findings.escalated)} escalated), ${String(sum.findings.open)} open`,
  ];
  if (v.issues.length) {
    lines.push(`Issues: ${String(v.issues.length)}`);
    for (const i of v.issues)
      lines.push(`  ${i.kind} at ${i.node}: ${i.message.slice(0, 200)} → ${i.resolution ?? 'unresolved'}`);
  }
  lines.push(`Design output: ${existsSync(dir) ? dir : '(not written)'}`);
  return lines.join('\n');
}

export function registerDesign(program: Command, rootOf: () => string, say: Say): void {
  program
    .command('design')
    .description(
      'Test design (Phase 3): risk model, coverage obligations, Test Planner, Reviewer pass 1, plan/cases/RTM',
    )
    .requiredOption('--from-run <runId>', 'earlier qa analyze run whose requirements and manual tests to design for')
    .requiredOption('--org <alias>', 'org whose stored snapshot provides the org facts (config/orgs.yaml)')
    .option('--snapshot <id>', 'snapshot id to design against (default: latest of the org)', 'latest')
    .option('--run-id <id>', 'run id (default design-<timestamp>)')
    .option('--autonomy <level>', 'L1 | L2 | L3 (default: policy.yaml / QA_AUTONOMY)')
    .option('--offline', 'no model calls: mechanical drafting + deterministic review only')
    .action(
      async (o: {
        fromRun: string;
        org: string;
        snapshot: string;
        runId?: string;
        autonomy?: string;
        offline?: boolean;
      }) => {
        const root = rootOf();
        const seed = loadAnalysisRun(root, o.fromRun);
        say(
          `Design for ${seed.storyKey} from run ${o.fromRun}: ${String(seed.requirements.length)} requirements, ${String(seed.existingTests.length)} manual tests, ${String(seed.sources.length)} sources`,
        );
        const runId = o.runId ?? newRunId('design');
        const rt = await createRuntime({
          root,
          say,
          logFile: runPaths(root, runId).runLog,
          ...(o.offline ? { offline: true } : {}),
          design: createDesignHook({ root, orgAlias: o.org, snapshotId: o.snapshot }),
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
              source: { type: seed.sourceType, ref: `run:${o.fromRun}` },
              storyKey: seed.storyKey,
              tokenLimit: 2_000_000,
              timeLimitMin: 90,
              inputs: [],
            }),
            sources: seed.sources,
            requirements: seed.requirements,
            findings: seed.findings,
            clarifications: seed.clarifications,
            existingTests: seed.existingTests,
            defectHistory: seed.defectHistory,
            ...(seed.story ? { story: seed.story } : {}),
            interactive: false,
          };
          say(`Run ${runId} — output in ${runPaths(root, runId).dir}`);
          const config = { configurable: { thread_id: runId } };
          await rt.graph.invoke(state, config);
          const v = (await rt.graph.getState(config)).values as QAGraphStateType;
          process.stdout.write(`${designSummary(v, root)}\n`);
          process.exitCode = v.status === 'BLOCKED' ? 3 : 0;
        } finally {
          await rt.close();
        }
      },
    );

  program
    .command('review')
    .description(
      'Test Reviewer pass 1 again on an existing design run (writes design/review-recheck.json, rebuilds outputs)',
    )
    .requiredOption('--run <runId>', 'design run to review')
    .option('--org <alias>', "org for the org facts (default: the run's org)")
    .option('--offline', 'deterministic review only (no judge model)')
    .action(async (o: { run: string; org?: string; offline?: boolean }) => {
      const root = rootOf();
      const rt = await createRuntime({ root, say, ...(o.offline ? { offline: true } : {}) });
      try {
        const snap = await rt.graph.getState({ configurable: { thread_id: o.run } });
        const v = snap.values as QAGraphStateType;
        if (!v.testCases.length) {
          throw new QAError('DATA', `run ${o.run} has no test design in .qa-memory/checkpoints.db`, {
            fix: 'run qa design first',
          });
        }
        const org = o.org ?? v.org;
        const inputs = await createDesignHook({ root, orgAlias: org, snapshotId: v.charter?.snapshotId ?? 'latest' })(
          v,
        );
        const { ctx } = buildContext(v, inputs);
        say(`Re-reviewing ${String(v.testCases.length)} cases of ${o.run} against snapshot ${inputs.snapshotId} …`);
        const r = await reviewRound(
          {
            ctx,
            cases: v.testCases,
            prior: v.reviewFindings,
            round: v.reviewRound + 1,
            mode: o.offline || !rt.deps.router ? 'mechanical' : 'llm',
          },
          {
            ...(rt.deps.router ? { router: rt.deps.router } : {}),
            ...(rt.deps.skills ? { skills: rt.deps.skills } : {}),
            logger: rt.deps.logger,
          },
        );
        const restoreIds = new TestCaseIdStore(v.storyKey ?? 'REQ', join(root, '.qa-memory'));
        const settled = settleFindings(ctx, r.findings, v.testCases, (obIds) => {
          const added = buildCases(
            ctx,
            mechanicalDrafts(
              ctx,
              ctx.obligations.filter((x) => obIds.includes(x.id)),
            ),
            'mechanical',
            restoreIds,
          );
          restoreIds.save();
          return added;
        });
        const next: QAGraphStateType = {
          ...v,
          reviewFindings: settled.findings,
          testCases: settled.cases,
          rtm: buildRtm(ctx, settled.cases),
          reviewRound: v.reviewRound + 1,
        };
        const dir = runPaths(root, o.run).dir;
        await writeFile(
          join(dir, 'design', 'review-recheck.json'),
          JSON.stringify(
            { round: next.reviewRound, environment: r.environment, models: r.models, findings: settled.findings },
            null,
            2,
          ),
        );
        await writeDesignReport(next, dir, v.status);
        process.stdout.write(`${designSummary(next, root)}\n`);
      } finally {
        await rt.close();
      }
    });
}
