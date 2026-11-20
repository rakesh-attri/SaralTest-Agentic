import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnalysisFinding, Requirement } from '../../core/schemas/index.js';
import type { ReverifyMark, SnapshotDiff } from '../../core/schemas/knowledge.js';
import { diffSnapshots } from '../../knowledge/diff.js';
import type { LocatorRegistry } from '../../knowledge/locatorRegistry.js';
import type { SnapshotStore, StoredSnapshot } from '../../knowledge/snapshotStore.js';
import type { GuardedSalesforce } from '../../sf/client.js';
import { runDiscovery, type DiscoveryResult } from '../../sf/discovery/index.js';
import { GraphStore, impactOfDiff, rebuildGraph, type ImpactItem, type TestAsset } from '../../sf/graph/index.js';
import { crossCheckRequirements } from './crossCheck.js';
import type { OrgCrossCheck } from './schema.js';

export interface DiscoverInput {
  sf: GuardedSalesforce;
  orgAlias: string;
  release: string;
  objects: string[];
  runId: string;
  root: string;
  snapshots: SnapshotStore;
  graph: GraphStore;
  /** Test assets to link (Phase 1 requirements + manual tests, registry locators). */
  assets?: readonly TestAsset[];
  requirements?: readonly Requirement[];
  findings?: readonly AnalysisFinding[];
  configuredPersonas?: readonly string[];
  /** Locator registry: locators impacted by a change are set to RE_VERIFY. */
  registry?: LocatorRegistry;
  /** Compare with this snapshot instead of the org's previous one. */
  baselineSnapshotId?: string;
  onProgress?: (msg: string) => void;
}

export interface DiscoverOutcome {
  snapshot: StoredSnapshot;
  discovery: DiscoveryResult;
  baseline?: StoredSnapshot;
  diff?: SnapshotDiff;
  impacted: ImpactItem[];
  reverify: ReverifyMark[];
  crossCheck?: OrgCrossCheck;
  graph: { nodes: number; edges: number };
  outputs: string[];
}

/**
 * Salesforce Intelligence pipeline (PLAN.md §11 Phase 2): discovery → immutable snapshot → diff with the previous
 * snapshot → knowledge graph → impact of changes → RE_VERIFY marks → org cross-check of requirements → reports in
 * `runs/<runId>/discovery/`. Read-only against the org. Everything is labelled LIVE or FIXTURE.
 */
export async function discoverOrg(i: DiscoverInput): Promise<DiscoverOutcome> {
  const say = i.onProgress ?? (() => undefined);
  const env = i.sf.environment;
  say(`Discovering ${i.objects.join(', ')} on ${i.orgAlias} (${env}, API v${i.sf.apiVersion})…`);
  const discovery = await runDiscovery({
    sf: i.sf,
    environment: env,
    orgId: i.sf.identity.orgId,
    apiVersion: i.sf.apiVersion,
    objects: i.objects,
    onProgress: say,
  });
  const snapshot = i.snapshots.save({
    discovery,
    orgAlias: i.orgAlias,
    release: i.release,
    persona: i.sf.identity.personaId,
    runId: i.runId,
  });
  say(
    `Snapshot ${snapshot.info.id}: ${snapshot.info.componentCount} components (${snapshot.info.unknownCount} UNKNOWN).`,
  );

  const baselineInfo = i.baselineSnapshotId
    ? i.snapshots.list(snapshot.info.orgId).find((s) => s.id === i.baselineSnapshotId)
    : i.snapshots.latest(snapshot.info.orgId, snapshot.info.id);
  const baseline = baselineInfo ? i.snapshots.get(baselineInfo.id) : undefined;
  const diff = baseline
    ? diffSnapshots(
        {
          id: baseline.info.id,
          orgId: baseline.info.orgId,
          objects: baseline.info.objects,
          components: baseline.components,
        },
        {
          id: snapshot.info.id,
          orgId: snapshot.info.orgId,
          objects: snapshot.info.objects,
          components: snapshot.components,
        },
      )
    : undefined;
  if (diff) {
    say(
      `Diff vs ${diff.fromSnapshotId}: ${diff.counts.changed} changed, ${diff.counts.added} added, ${diff.counts.removed} removed, ${diff.counts.unknown} unknown.`,
    );
  } else {
    say('No earlier snapshot of this org: this is the baseline.');
  }

  const graph = rebuildGraph(i.graph, snapshot, i.assets ?? []);
  say(`Knowledge graph: ${graph.nodes} nodes, ${graph.edges} edges.`);
  const impact = diff ? impactOfDiff(i.graph, diff) : { seeds: [], impacted: [], reverify: [] };
  const reverify = i.snapshots.markReverify(impact.reverify);
  for (const m of reverify.filter((x) => x.assetType === 'locator'))
    i.registry?.markAssetReverify(snapshot.info.orgId, m.assetId);
  if (reverify.length) say(`RE_VERIFY: ${[...new Set(reverify.map((m) => `${m.assetType}:${m.assetId}`))].join(', ')}`);

  const crossCheck = i.requirements?.length
    ? crossCheckRequirements({
        snapshot,
        requirements: i.requirements,
        ...(i.findings ? { findings: i.findings } : {}),
        ...(i.configuredPersonas ? { configuredPersonas: i.configuredPersonas } : {}),
      })
    : undefined;
  if (crossCheck) {
    const c = crossCheck.counts;
    say(
      `Org cross-check: ${c.EXISTS} exist, ${c.CONSISTENT} consistent, ${c.NOT_FOUND} not found, ${c.CONFLICT} conflicts, ${c.UNKNOWN} unknown.`,
    );
  }

  const outcome: DiscoverOutcome = {
    snapshot,
    discovery,
    ...(baseline ? { baseline } : {}),
    ...(diff ? { diff } : {}),
    impacted: impact.impacted,
    reverify,
    ...(crossCheck ? { crossCheck } : {}),
    graph,
    outputs: [],
  };
  outcome.outputs = writeDiscoveryReport(i.root, i.runId, outcome, i.orgAlias);
  say(`Report: ${outcome.outputs.find((f) => f.endsWith('.md')) ?? ''}`);
  return outcome;
}

const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function writeDiscoveryReport(root: string, runId: string, o: DiscoverOutcome, orgAlias: string): string[] {
  const dir = join(root, 'runs', runId, 'discovery');
  mkdirSync(dir, { recursive: true });
  const env = o.snapshot.info.environment;
  const files: string[] = [];
  const write = (name: string, data: unknown): void => {
    const f = join(dir, name);
    writeFileSync(f, typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    files.push(f);
  };
  const byType: Record<string, number> = {};
  for (const c of o.snapshot.components) byType[c.type] = (byType[c.type] ?? 0) + 1;
  write('snapshot-summary.json', {
    ...o.snapshot.info,
    componentsByType: byType,
    areas: o.discovery.areas,
  });
  write('diff.json', o.diff ?? { environment: env, note: 'baseline snapshot: nothing to compare' });
  write('impact.json', { environment: env, impacted: o.impacted, reverify: o.reverify });
  if (o.crossCheck) write('org-crosscheck.json', o.crossCheck);

  const L: string[] = [];
  L.push(`# Discovery report — ${orgAlias} (${env})`, '');
  if (env !== 'LIVE')
    L.push(`> **${env}** — offline fixture data. Never live Salesforce evidence (CLAUDE.md rule 13).`, '');
  L.push(`- Run: \`${runId}\``);
  L.push(
    `- Org: \`${o.snapshot.info.orgId}\` · release ${o.snapshot.info.release} · API v${o.snapshot.info.apiVersion}`,
  );
  L.push(
    `- Snapshot: \`${o.snapshot.info.id}\` (${o.snapshot.info.capturedAt}) · persona ${o.snapshot.info.persona ?? '?'}`,
  );
  L.push(`- Scope: ${o.snapshot.info.objects.join(', ')} + related org-wide components`);
  L.push(`- Knowledge graph: ${o.graph.nodes} nodes, ${o.graph.edges} edges`, '');
  L.push('## Components', '', '| Type | Count |', '|---|---|');
  for (const [t, n] of Object.entries(byType).sort()) L.push(`| ${t} | ${n} |`);
  const failed = o.discovery.areas.filter((a) => !a.ok);
  L.push('', `Areas: ${o.discovery.areas.length - failed.length}/${o.discovery.areas.length} read.`);
  for (const a of failed)
    L.push(`- **UNKNOWN** ${a.area}: ${esc(a.error ?? '')} (recorded as UNKNOWN, never as missing)`);
  const hidden = o.snapshot.components.filter(
    (c) => c.evidenceStatus === 'UNKNOWN' && o.discovery.areas.every((a) => a.ok),
  );
  for (const h of hidden)
    L.push(`- UNKNOWN ${h.type} ${h.apiName}: ${esc(typeof h.body?.['reason'] === 'string' ? h.body['reason'] : '')}`);

  L.push('', '## Changes since the previous snapshot', '');
  if (!o.diff) L.push('Baseline snapshot — no earlier snapshot of this org to compare.');
  else {
    L.push(
      `Compared with \`${o.diff.fromSnapshotId}\` on ${o.diff.comparedObjects.join(', ')}: ${o.diff.counts.changed} changed, ${o.diff.counts.added} added, ${o.diff.counts.removed} removed, ${o.diff.counts.unknown} unknown.`,
      '',
    );
    if (o.diff.entries.length) {
      L.push('| Change | Type | Component | Changed keys / reason |', '|---|---|---|---|');
      for (const e of o.diff.entries)
        L.push(
          `| ${e.change} | ${e.type} | ${esc(e.apiName)} | ${esc((e.changedKeys ?? []).join(', ') || e.reason || '')} |`,
        );
    }
  }
  L.push('', '## Impact and RE_VERIFY', '');
  if (!o.reverify.length)
    L.push(
      o.diff?.entries.length ? 'No linked test asset depends on the changed components.' : 'Nothing to re-verify.',
    );
  else {
    L.push('| Asset | Because | Evidence (graph path) |', '|---|---|---|');
    for (const m of o.reverify)
      L.push(
        `| ${m.assetType} ${m.assetId} | ${m.change} ${m.componentType} ${esc(m.componentName)} | ${esc(m.path.join(' ; '))} |`,
      );
  }
  if (o.impacted.length) {
    L.push(
      '',
      `Dependents of the changes (depth ≤ 3): ${o.impacted.map((i) => `${i.node.id} (d${i.depth})`).join(', ')}`,
    );
  }
  if (o.crossCheck) {
    const c = o.crossCheck;
    L.push('', '## Org cross-check of requirements', '');
    L.push(
      `${c.counts.EXISTS} exist · ${c.counts.CONSISTENT} consistent · ${c.counts.NOT_FOUND} not found · ${c.counts.CONFLICT} conflicts · ${c.counts.UNKNOWN} unknown`,
      '',
    );
    L.push('| Id | Refs | Check | Result | What the org shows |', '|---|---|---|---|---|');
    for (const k of c.checks)
      L.push(
        `| ${k.id} | ${esc(k.refs.join(', ') || k.requirementIds.join(', '))} | ${esc(k.subject)} | **${k.result}** | ${esc(k.orgFact)} |`,
      );
    const qs = c.checks.filter((k) => k.question);
    if (qs.length) {
      L.push('', '### Questions for the product owner', '');
      qs.forEach((k, n) => L.push(`${n + 1}. ${k.question ?? ''} _(${k.id})_`));
    }
    L.push(
      '',
      'Settled results are `DECLARED_CONFIG` evidence; everything else is `UNKNOWN_OR_CONTRADICTORY` and cannot become an assertion (PLAN.md §7f).',
    );
  }
  write('discovery-report.md', `${L.join('\n')}\n`);
  return files;
}
