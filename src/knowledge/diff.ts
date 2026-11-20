import type { ComponentVersion, DiffEntry, SnapshotDiff } from '../core/schemas/knowledge.js';
import { canonicalJson } from './hash.js';

export interface DiffSide {
  id: string;
  orgId: string;
  objects: string[];
  components: ComponentVersion[];
}

const key = (c: Pick<ComponentVersion, 'type' | 'apiName'>): string => `${c.type}\u0000${c.apiName}`;

/** UNKNOWN placeholder covering `c` in `side` (`<parent>.*` for object-scoped areas, `*` for org-wide ones). */
function unknownCover(side: Map<string, ComponentVersion>, c: ComponentVersion): ComponentVersion | undefined {
  const own = side.get(key(c));
  if (own?.evidenceStatus === 'UNKNOWN') return own;
  const scoped = c.parent ? side.get(key({ type: c.type, apiName: `${c.parent}.*` })) : undefined;
  return scoped ?? side.get(key({ type: c.type, apiName: '*' }));
}

const isPlaceholder = (c: ComponentVersion): boolean => c.apiName === '*' || c.apiName.endsWith('.*');

function changedKeys(a: ComponentVersion, b: ComponentVersion): string[] {
  const ab = a.body ?? {};
  const bb = b.body ?? {};
  return [...new Set([...Object.keys(ab), ...Object.keys(bb)])]
    .filter((k) => canonicalJson(ab[k]) !== canonicalJson(bb[k]))
    .sort();
}

/**
 * Compare two snapshots of the same org by (type, apiName) (PLAN.md §7c). Only objects present in both scopes are
 * compared. A component is `unknown` — never `removed`/`added` — when its area was unreadable on either side.
 * Hashes are type-prefixed, so different artifact types are never compared.
 */
export function diffSnapshots(prev: DiffSide, next: DiffSide): SnapshotDiff {
  if (prev.orgId !== next.orgId)
    throw new Error(`cannot diff snapshots of different orgs (${prev.orgId} vs ${next.orgId})`);
  const scope = new Set(prev.objects.filter((o) => next.objects.includes(o)));
  const inScope = (c: ComponentVersion): boolean => !c.parent || scope.has(c.parent);
  const a = new Map(prev.components.filter(inScope).map((c) => [key(c), c]));
  const b = new Map(next.components.filter(inScope).map((c) => [key(c), c]));
  const entries: DiffEntry[] = [];

  for (const [k, before] of a) {
    if (isPlaceholder(before)) continue;
    const after = b.get(k);
    const base = { type: before.type, apiName: before.apiName, ...(before.parent ? { parent: before.parent } : {}) };
    if (!after) {
      const cover = unknownCover(b, before);
      entries.push(
        cover
          ? {
              ...base,
              change: 'unknown',
              beforeHash: before.hash,
              reason: `not readable in ${next.id}: ${typeof cover.body?.['reason'] === 'string' ? cover.body['reason'] : 'UNKNOWN'}`,
            }
          : { ...base, change: 'removed', beforeHash: before.hash },
      );
      continue;
    }
    if (before.evidenceStatus === 'UNKNOWN' || after.evidenceStatus === 'UNKNOWN') {
      if (before.hash !== after.hash)
        entries.push({
          ...base,
          change: 'unknown',
          beforeHash: before.hash,
          afterHash: after.hash,
          reason: 'UNKNOWN evidence',
        });
      continue;
    }
    if (before.hash !== after.hash) {
      entries.push({
        ...base,
        change: 'changed',
        beforeHash: before.hash,
        afterHash: after.hash,
        changedKeys: changedKeys(before, after),
      });
    }
  }
  for (const [k, after] of b) {
    if (a.has(k) || isPlaceholder(after)) continue;
    const base = { type: after.type, apiName: after.apiName, ...(after.parent ? { parent: after.parent } : {}) };
    const cover = unknownCover(a, after);
    entries.push(
      cover
        ? { ...base, change: 'unknown', afterHash: after.hash, reason: `not readable in ${prev.id}` }
        : { ...base, change: 'added', afterHash: after.hash },
    );
  }
  entries.sort((x, y) => x.type.localeCompare(y.type) || x.apiName.localeCompare(y.apiName));
  const count = (c: DiffEntry['change']): number => entries.filter((e) => e.change === c).length;
  return {
    fromSnapshotId: prev.id,
    toSnapshotId: next.id,
    orgId: next.orgId,
    comparedObjects: [...scope].sort(),
    entries,
    counts: { added: count('added'), removed: count('removed'), changed: count('changed'), unknown: count('unknown') },
  };
}
