import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { z } from 'zod';
import { crossCheckEvidence, crossCheckFindings } from '../agents/sf-intelligence/crossCheck.js';
import { discoverOrg } from '../agents/sf-intelligence/discover.js';
import type { DiscoverHook } from '../graph/mainGraph.js';
import { AnalysisFinding, Requirement } from '../core/schemas/index.js';
import { newRunId } from '../core/runFolder.js';
import { SnapshotStore } from '../knowledge/snapshotStore.js';
import { createSfContext } from '../sf/context.js';
import { assetsFrom, assetsFromAnalysis, GraphStore, type TestAsset } from '../sf/graph/index.js';

type Say = (msg: string) => void;

function readList<T>(file: string, key: string, schema: z.ZodType<T>): T[] {
  if (!existsSync(file)) return [];
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const list = Array.isArray(raw) ? raw : ((raw as Record<string, unknown> | null)?.[key] ?? []);
  return Array.isArray(list) ? list.map((x) => schema.parse(x)) : [];
}

/** The analysis run whose requirements + manual tests are linked to the org graph (remembered per org). */
function assetRunFile(root: string, orgAlias: string): string {
  return join(root, '.qa-memory', 'assets', `${orgAlias}.json`);
}

export function registerDiscover(
  program: Command,
  rootOf: () => string,
  say: Say,
  extraAssets?: (root: string, orgId: string) => TestAsset[],
): void {
  program
    .command('discover')
    .description(
      'Org discovery → immutable snapshot + diff + knowledge graph + impact (+ org cross-check of requirements)',
    )
    .option('--org <alias>', 'org alias from config/orgs.yaml (default QA_DEFAULT_ORG)')
    .option('--objects <list>', 'comma-separated objects to discover', 'Account,Contact')
    .option('--persona <id>', 'persona for discovery (default from personas.yaml)')
    .option(
      '--cross-check <runId>',
      'cross-check the requirements of this `qa analyze` run against the org (remembered for later discoveries)',
    )
    .option('--baseline <snapshotId>', 'compare with this snapshot instead of the previous one')
    .option('--run-id <id>', 'run id (default discover-<timestamp>)')
    .option('--list', 'list stored snapshots of the org and exit')
    .action(
      async (o: {
        org?: string;
        objects: string;
        persona?: string;
        crossCheck?: string;
        baseline?: string;
        runId?: string;
        list?: boolean;
      }) => {
        const root = rootOf();
        const runId = o.runId ?? newRunId('discover');
        const ctx = await createSfContext({
          root,
          runId,
          ...(o.org ? { orgAlias: o.org } : {}),
          ...(o.persona ? { personaId: o.persona } : {}),
        });
        const snapshots = new SnapshotStore(join(root, '.qa-memory', 'knowledge.db'));
        const graph = new GraphStore(join(root, '.qa-memory', 'graph.db'));
        try {
          if (o.list) {
            for (const s of snapshots.list(ctx.org.orgId)) {
              process.stdout.write(
                `${s.id}  ${s.capturedAt}  ${s.environment}  ${s.objects.join(',')}  ${s.componentCount} components (${s.unknownCount} UNKNOWN)\n`,
              );
            }
            return;
          }
          say(
            `qa discover — org ${ctx.org.alias} (${ctx.org.profile}, ${ctx.org.environment}), run ${runId}. Read-only.`,
          );
          const sf = await ctx.connect();
          say(
            `Identity verified: ${sf.identity.orgId} as ${sf.identity.username}${sf.identity.releaseLabel ? `, ${sf.identity.releaseLabel}` : ''}.`,
          );
          for (const w of sf.identity.warnings) say(`  warning: ${w}`);

          const remembered = assetRunFile(root, ctx.org.alias);
          let analysisRun = o.crossCheck;
          if (analysisRun) {
            mkdirSync(join(root, '.qa-memory', 'assets'), { recursive: true });
            writeFileSync(remembered, JSON.stringify({ analysisRun }, null, 2), 'utf8');
          } else if (existsSync(remembered)) {
            analysisRun = z
              .object({ analysisRun: z.string() })
              .parse(JSON.parse(readFileSync(remembered, 'utf8'))).analysisRun;
            say(`Linking test assets from analysis run ${analysisRun} (remembered for ${ctx.org.alias}).`);
          }
          const analysisDir = analysisRun ? join(root, 'runs', analysisRun, 'analysis') : undefined;
          if (analysisDir && !existsSync(analysisDir)) throw new Error(`analysis run not found: ${analysisDir}`);
          const requirements = analysisDir
            ? readList(join(analysisDir, 'requirements.json'), 'requirements', Requirement)
            : [];
          const findings = analysisDir ? readList(join(analysisDir, 'findings.json'), 'findings', AnalysisFinding) : [];
          const assets = [
            ...(analysisRun ? assetsFromAnalysis(root, analysisRun) : []),
            ...(extraAssets?.(root, ctx.org.orgId) ?? []),
          ];

          const outcome = await discoverOrg({
            sf,
            orgAlias: ctx.org.alias,
            release: sf.identity.releaseLabel ?? ctx.org.release,
            objects: o.objects
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean),
            runId,
            root,
            snapshots,
            graph,
            assets,
            ...(o.crossCheck && requirements.length ? { requirements, findings } : {}),
            configuredPersonas: ctx.personas.personas.flatMap((p) => [p.id, p.profile]),
            ...(o.baseline ? { baselineSnapshotId: o.baseline } : {}),
            onProgress: say,
          });
          process.stdout.write(
            [
              `Snapshot ${outcome.snapshot.info.id} (${outcome.snapshot.info.environment}): ${outcome.snapshot.info.componentCount} components`,
              outcome.diff
                ? `Diff vs ${outcome.diff.fromSnapshotId}: ${outcome.diff.counts.changed} changed, ${outcome.diff.counts.added} added, ${outcome.diff.counts.removed} removed, ${outcome.diff.counts.unknown} unknown`
                : 'Baseline snapshot (nothing to compare yet)',
              `RE_VERIFY: ${outcome.reverify.length ? [...new Set(outcome.reverify.map((m) => `${m.assetType}:${m.assetId}`))].join(', ') : 'none'}`,
              ...(outcome.crossCheck ? [`Org cross-check: ${JSON.stringify(outcome.crossCheck.counts)}`] : []),
              `Saved: ${join(root, 'runs', runId, 'discovery')}`,
              '',
            ].join('\n'),
          );
        } finally {
          snapshots.close();
          graph.close();
        }
      },
    );
}

/**
 * Graph hook for `qa analyze --org <alias>`: after analysis, discover the org, cross-check the run's requirements
 * and return org findings/evidence/context to the main graph (Phase 2 Salesforce Intelligence node).
 */
export function createDiscoverHook(o: {
  root: string;
  orgAlias: string;
  objects: string[];
  personaId?: string;
}): DiscoverHook {
  return async (s) => {
    const ctx = await createSfContext({
      root: o.root,
      runId: s.runId,
      orgAlias: o.orgAlias,
      ...(o.personaId ? { personaId: o.personaId } : {}),
    });
    const snapshots = new SnapshotStore(join(o.root, '.qa-memory', 'knowledge.db'));
    const graph = new GraphStore(join(o.root, '.qa-memory', 'graph.db'));
    try {
      const sf = await ctx.connect();
      const notes: string[] = [];
      const outcome = await discoverOrg({
        sf,
        orgAlias: ctx.org.alias,
        release: sf.identity.releaseLabel ?? ctx.org.release,
        objects: o.objects,
        runId: s.runId,
        root: o.root,
        snapshots,
        graph,
        assets: assetsFrom(s.requirements, s.existingTests),
        requirements: s.requirements,
        findings: s.findings,
        configuredPersonas: ctx.personas.personas.flatMap((p) => [p.id, p.profile]),
        onProgress: (m) => notes.push(m),
      });
      const cc = outcome.crossCheck;
      return {
        org: `${ctx.org.alias} (${ctx.org.orgId}, ${sf.environment})`,
        orgContext: {
          snapshotId: outcome.snapshot.info.id,
          components: [
            ...new Set((cc?.checks ?? []).flatMap((c) => c.evidence.map((e) => `${e.componentType}:${e.apiName}`))),
          ],
          orgId: ctx.org.orgId,
          environment: sf.environment,
        },
        impact: {
          dependencies: outcome.impacted.map((i) => i.node.id),
          regressionCandidates: [...new Set(outcome.reverify.map((m) => `${m.assetType}:${m.assetId}`))],
          riskScores: {},
        },
        findings: cc ? crossCheckFindings(cc) : [],
        evidence: cc ? crossCheckEvidence(cc) : [],
        notes,
      };
    } finally {
      snapshots.close();
      graph.close();
    }
  };
}
