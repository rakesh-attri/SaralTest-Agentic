import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ReverifyMark, SnapshotDiff } from '../../core/schemas/knowledge.js';
import type { StoredSnapshot } from '../../knowledge/snapshotStore.js';
import { linkAssets, type TestAsset } from './assetLinks.js';
import { nodeId, type GraphEdge, type GraphNode, type GraphStore, type ImpactItem } from './graphStore.js';

export { GraphStore, GOVERNS, nodeId, type GraphEdge, type GraphNode, type ImpactItem } from './graphStore.js';
export { linkAssets, type TestAsset } from './assetLinks.js';

/** Nodes + edges from a snapshot (components + dependencies) and the test assets linked to it. */
export function graphFromSnapshot(
  snap: StoredSnapshot,
  assets: readonly TestAsset[] = [],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = new Map<string, GraphNode>();
  for (const c of snap.components) {
    if (c.apiName === '*' || c.apiName.endsWith('.*')) continue; // UNKNOWN placeholders are not graph nodes
    nodes.set(nodeId(c.type, c.apiName), {
      id: nodeId(c.type, c.apiName),
      type: c.type,
      apiName: c.apiName,
      ...(c.label ? { label: c.label } : {}),
    });
  }
  const edges: GraphEdge[] = [];
  for (const d of snap.dependencies) {
    const from = nodeId(d.fromType, d.fromName);
    const to = nodeId(d.toType, d.toName);
    // Dependencies may point at components outside the discovery scope: keep them as stub nodes (still citable).
    for (const [id, type, name] of [
      [from, d.fromType, d.fromName],
      [to, d.toType, d.toName],
    ] as const) {
      if (!nodes.has(id)) nodes.set(id, { id, type, apiName: name, meta: { stub: true } });
    }
    edges.push({ from, to, kind: d.kind, source: d.source });
  }
  const linked = linkAssets(assets, snap.components);
  for (const n of linked.nodes) nodes.set(n.id, n);
  edges.push(...linked.edges.filter((e) => nodes.has(e.to)));
  return { nodes: [...nodes.values()], edges };
}

/** Build/replace the org graph from a snapshot. */
export function rebuildGraph(
  store: GraphStore,
  snap: StoredSnapshot,
  assets: readonly TestAsset[] = [],
): { nodes: number; edges: number } {
  const g = graphFromSnapshot(snap, assets);
  store.replaceOrg(snap.info.orgId, snap.info.id, g.nodes, g.edges);
  return store.counts(snap.info.orgId);
}

const ASSET_TYPES: Record<string, ReverifyMark['assetType']> = {
  Requirement: 'requirement',
  ManualTest: 'manual-test',
  Locator: 'locator',
  Learning: 'learning',
};

export interface ImpactResult {
  /** Changed/added/removed components that were used as seeds. */
  seeds: string[];
  impacted: ImpactItem[];
  /** Test assets that must be re-verified, with the edge path as evidence. */
  reverify: Omit<ReverifyMark, 'createdAt' | 'status'>[];
}

/** Impact of a snapshot diff: changed + removed + added components → dependents → test assets to RE_VERIFY. */
export function impactOfDiff(store: GraphStore, diff: SnapshotDiff, maxDepth = 3): ImpactResult {
  const relevant = diff.entries.filter((e) => e.change !== 'unknown');
  const seeds = relevant.map((e) => nodeId(e.type, e.apiName));
  const impacted: ImpactItem[] = [];
  const reverify: ImpactResult['reverify'] = [];
  for (const e of relevant) {
    const seed = nodeId(e.type, e.apiName);
    for (const item of store.impact(diff.orgId, [seed], maxDepth)) {
      if (!impacted.some((x) => x.node.id === item.node.id)) impacted.push(item);
      const assetType = ASSET_TYPES[item.node.type];
      if (assetType) {
        reverify.push({
          assetType,
          assetId: item.node.apiName,
          componentType: e.type,
          componentName: e.apiName,
          change: e.change,
          path: item.path,
          snapshotId: diff.toSnapshotId,
        });
      }
    }
  }
  impacted.sort((a, b) => a.depth - b.depth || a.node.id.localeCompare(b.node.id));
  return { seeds, impacted, reverify };
}

// ------------------------------------------------------------------ test assets from a Phase 1 analysis run
const ReqRow = z.looseObject({
  id: z.string(),
  title: z.string().optional(),
  businessObjective: z.string().optional(),
  actions: z.array(z.string()).optional(),
  businessRules: z.array(z.string()).optional(),
  expectedOutcomes: z.array(z.string()).optional(),
  preconditions: z.array(z.string()).optional(),
  dataRequirements: z.array(z.string()).optional(),
});
const MtcRow = z.looseObject({
  id: z.string(),
  title: z.string(),
  steps: z.array(z.string()).optional(),
  expected: z.string().optional(),
  preconditions: z.array(z.string()).optional(),
});

function readJsonArray(file: string, key: string): unknown[] {
  if (!existsSync(file)) return [];
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (Array.isArray(raw)) return raw;
  const inner = (raw as Record<string, unknown> | null)?.[key];
  return Array.isArray(inner) ? inner : [];
}

/** Requirements + manual test cases as linkable test assets. */
export function assetsFrom(
  reqs: readonly z.infer<typeof ReqRow>[],
  tests: readonly z.infer<typeof MtcRow>[],
): TestAsset[] {
  return [
    ...reqs.map((r): TestAsset => ({
      type: 'Requirement',
      id: r.id,
      label: r.title ?? r.id,
      text: [
        r.title,
        r.businessObjective,
        ...(r.actions ?? []),
        ...(r.businessRules ?? []),
        ...(r.expectedOutcomes ?? []),
        ...(r.preconditions ?? []),
        ...(r.dataRequirements ?? []),
      ]
        .filter(Boolean)
        .join('\n'),
    })),
    ...tests.map((t): TestAsset => ({
      type: 'ManualTest',
      id: t.id,
      label: t.title,
      text: [t.title, ...(t.preconditions ?? []), ...(t.steps ?? []), t.expected].filter(Boolean).join('\n'),
    })),
  ];
}

/** Requirements + manual test cases written by `qa analyze` (runs/<runId>/analysis/). */
export function assetsFromAnalysis(root: string, runId: string): TestAsset[] {
  const dir = join(root, 'runs', runId, 'analysis');
  const reqs = readJsonArray(join(dir, 'requirements.json'), 'requirements').map((r) => ReqRow.parse(r));
  const tests = readJsonArray(join(dir, 'existing-tests.json'), 'tests').map((t) => MtcRow.parse(t));
  return assetsFrom(reqs, tests);
}
