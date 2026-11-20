import type { ComponentVersion } from '../../core/schemas/knowledge.js';
import { nodeId, type GraphEdge, type GraphNode } from './graphStore.js';

/** A test asset that can depend on org components (Phase 2: requirements, manual tests, locators). */
export interface TestAsset {
  type: 'Requirement' | 'ManualTest' | 'Locator' | 'Learning';
  id: string;
  label: string;
  /** Free text the linker scans (titles, steps, rules, expected results). */
  text: string;
  /** Explicit component links (e.g. a locator verified against a field label) — no text matching needed. */
  explicit?: { type: string; apiName: string; kind: string; evidence?: string }[];
}

const SYSTEM_FIELDS = new Set([
  'Id',
  'IsDeleted',
  'CreatedById',
  'CreatedDate',
  'LastModifiedById',
  'LastModifiedDate',
  'SystemModstamp',
  'LastActivityDate',
  'LastViewedDate',
  'LastReferencedDate',
  'MasterRecordId',
  'PhotoUrl',
  'Jigsaw',
  'JigsawContactId',
  'JigsawCompanyId',
]);

/** Field API names too generic to match on their own ("Name" is inside "Last Name"); their labels still match. */
const GENERIC_FIELD_NAMES = new Set(['Name', 'Type', 'Status', 'Description', 'Title__c']);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phrase = (term: string): RegExp => new RegExp(`(?<![A-Za-z0-9_])${escapeRe(term)}(?![A-Za-z0-9_])`, 'i');

const ASSET_EDGE: Record<TestAsset['type'], string> = {
  Requirement: 'mentions',
  ManualTest: 'covers',
  Locator: 'locates',
  Learning: 'about',
};

/**
 * Deterministic asset → component links by exact field/object label or API name (word-bounded). Candidate fields are
 * limited to the objects the asset text names (all scope objects when it names none). Every edge keeps the matched
 * term as evidence and `source: text-match`; these links select regression candidates, they never become assertions.
 */
export function linkAssets(
  assets: readonly TestAsset[],
  components: readonly ComponentVersion[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const objects = components.filter((c) => c.type === 'SObject' && c.evidenceStatus !== 'UNKNOWN');
  const fields = components.filter(
    (c) => c.type === 'Field' && c.evidenceStatus !== 'UNKNOWN' && !SYSTEM_FIELDS.has(c.apiName.split('.')[1] ?? ''),
  );
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const a of assets) {
    const id = nodeId(a.type, a.id);
    nodes.push({ id, type: a.type, apiName: a.id, label: a.label });
    for (const x of a.explicit ?? []) {
      edges.push({
        from: id,
        to: nodeId(x.type, x.apiName),
        kind: x.kind,
        source: 'explicit',
        ...(x.evidence ? { evidence: x.evidence } : {}),
      });
    }
    if (!a.text.trim()) continue;
    const named = objects.filter((o) => {
      const label = o.label ?? o.apiName;
      const plural = typeof o.body?.['labelPlural'] === 'string' ? o.body['labelPlural'] : `${label}s`;
      return phrase(o.apiName).test(a.text) || phrase(label).test(a.text) || phrase(plural).test(a.text);
    });
    for (const o of named)
      edges.push({
        from: id,
        to: nodeId('SObject', o.apiName),
        kind: `${ASSET_EDGE[a.type]}-object`,
        source: 'text-match',
        evidence: o.label ?? o.apiName,
      });
    const scope = new Set((named.length ? named : objects).map((o) => o.apiName));
    for (const f of fields) {
      if (!f.parent || !scope.has(f.parent)) continue;
      const fieldName = f.apiName.split('.')[1] ?? '';
      const label = f.label ?? '';
      const term =
        (fieldName.length >= 3 && !GENERIC_FIELD_NAMES.has(fieldName) && phrase(fieldName).test(a.text) && fieldName) ||
        (label.length >= 4 && phrase(label).test(a.text) && label) ||
        (phrase(f.apiName).test(a.text) && f.apiName) ||
        undefined;
      if (term)
        edges.push({
          from: id,
          to: nodeId('Field', f.apiName),
          kind: ASSET_EDGE[a.type],
          source: 'text-match',
          evidence: term,
        });
    }
  }
  return { nodes, edges };
}
