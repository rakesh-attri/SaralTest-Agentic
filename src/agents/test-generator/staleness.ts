// STALE marks on generated specs (tests/generated/<story>/manifest.json). A spec is stale when a component it
// depends on (rule, field, locator) changed after it was built. `qa discover` and `qa build` refresh the marks;
// only a rebuild of the spec clears them (its new manifest entry has fresh dependencies and no mark).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GeneratedArtifact, SpecStale } from '../../core/schemas/generation.js';
import type { LocatorEntry } from '../../knowledge/locatorRegistry.js';
import type { SnapshotFacts } from '../../sf/data/plan.js';
import { locatorHash, staleDependencies, type LocatorLookup } from './dependencies.js';

export interface StaleSpec {
  storyKey: string;
  caseId: string;
  path: string;
  stale: SpecStale;
  /** true when this refresh added the mark or new components to it. */
  changed: boolean;
}

export interface StaleRefresh {
  stale: StaleSpec[];
  /** Specs built before dependency tracking: staleness unknown (rebuild or backfill them). */
  untracked: { storyKey: string; caseId: string; path: string }[];
}

type ManifestArtifact = GeneratedArtifact & { buildRun?: string };
interface ManifestFile {
  storyKey?: string;
  artifacts?: ManifestArtifact[];
  [k: string]: unknown;
}

export const storyManifestFile = (root: string, storyKey: string): string =>
  join(root, 'tests', 'generated', storyKey, 'manifest.json');

/** Story keys with a generated-spec manifest. */
export function storiesWithManifest(root: string): string[] {
  const dir = join(root, 'tests', 'generated');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((s) => existsSync(storyManifestFile(root, s)));
}

/** Registry rows → locator lookup (prefers the row whose expression the spec saw; RETIRED rows count as gone). */
export function registryLookup(entries: readonly LocatorEntry[]): LocatorLookup {
  return (page, element) => {
    const rows = entries.filter((e) => e.page === page && e.element === element && e.status !== 'RETIRED');
    const row = rows.find((r) => r.status === 'ACTIVE') ?? rows[0];
    return row ? { expression: row.expression, status: row.status } : undefined;
  };
}

/**
 * Re-checks every spec's dependencies against `facts` (the latest snapshot) and the registry, and writes STALE marks
 * into the manifests. Marks are only added or extended here — never removed (a rebuild replaces the entry).
 */
export function refreshStaleMarks(o: {
  root: string;
  facts: SnapshotFacts;
  locator: LocatorLookup;
  stories?: string[];
  now?: Date;
}): StaleRefresh {
  const out: StaleRefresh = { stale: [], untracked: [] };
  const at = (o.now ?? new Date()).toISOString();
  for (const story of o.stories ?? storiesWithManifest(o.root)) {
    const file = storyManifestFile(o.root, story);
    if (!existsSync(file)) continue;
    const m = JSON.parse(readFileSync(file, 'utf8')) as ManifestFile;
    let dirty = false;
    for (const a of m.artifacts ?? []) {
      if (a.kind !== 'spec') continue;
      const caseId = a.testCaseIds[0] ?? '';
      if (!a.dependsOn) {
        out.untracked.push({ storyKey: story, caseId, path: a.path });
        continue;
      }
      const now = staleDependencies(a.dependsOn, o.facts, o.locator);
      const before = a.stale?.components ?? [];
      const merged = [...new Set([...before, ...now])];
      if (!merged.length) continue;
      const changed = merged.length !== before.length;
      if (changed) {
        a.stale = { components: merged, snapshotId: o.facts.snapshotId, markedAt: at };
        dirty = true;
      }
      out.stale.push({
        storyKey: story,
        caseId,
        path: a.path,
        stale: a.stale ?? { components: merged, snapshotId: o.facts.snapshotId, markedAt: at },
        changed,
      });
    }
    if (dirty) writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
  }
  return out;
}

/** `stale: <component> changed in <snapshot>` — the reason a stale spec is reported with. */
export function staleReason(s: SpecStale): string {
  return s.components.map((c) => `stale: ${c} in ${s.snapshotId}`).join('; ');
}

export { locatorHash };
