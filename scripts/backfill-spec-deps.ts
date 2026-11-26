// One-time migration (2026-11-26): record `dependsOn` for generated specs built before dependency tracking.
// Deterministic, no model and no org access: each spec's IR (runs/<buildRun>/build/ir/<case>.json), the snapshot it
// was built on (artifact.snapshotId) and the page catalog committed with it (tests/pages/page-catalog.json).
// Usage: pnpm tsx scripts/backfill-spec-deps.ts <storyKey> [--org qa-prod]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bindRecipe, type GenerationContext, type RecipeView } from '../src/agents/test-generator/context.js';
import { specDependencies } from '../src/agents/test-generator/dependencies.js';
import { CATALOG_FILE, PageCatalog } from '../src/agents/test-generator/pageObjects.js';
import { storyManifestFile } from '../src/agents/test-generator/staleness.js';
import { projectPaths, requireConfig } from '../src/config/loader.js';
import { TestIR, type GeneratedArtifact } from '../src/core/schemas/generation.js';
import { TestCase } from '../src/core/schemas/testCase.js';
import { SnapshotStore } from '../src/knowledge/snapshotStore.js';
import { buildDataPlan, loadRecipe, SnapshotFacts } from '../src/sf/data/plan.js';
import { z } from 'zod';

const root = process.cwd();
const story = process.argv[2];
const orgAlias = process.argv.includes('--org') ? process.argv[process.argv.indexOf('--org') + 1] : 'qa-prod';
if (!story) throw new Error('usage: backfill-spec-deps.ts <storyKey> [--org <alias>]');

const orgs = await requireConfig('orgs', projectPaths(root));
const org = orgs.orgs.find((x) => x.alias === orgAlias);
if (!org) throw new Error(`org ${String(orgAlias)} not in config/orgs.yaml`);
const file = storyManifestFile(root, story);
const manifest = JSON.parse(readFileSync(file, 'utf8')) as {
  designRun?: string;
  buildRun?: string;
  artifacts: (GeneratedArtifact & { buildRun?: string })[];
};
const catalog = PageCatalog.parse(JSON.parse(readFileSync(join(root, CATALOG_FILE), 'utf8')));
const cases = manifest.designRun
  ? z
      .array(TestCase)
      .parse(JSON.parse(readFileSync(join(root, 'runs', manifest.designRun, 'design', 'test-cases.json'), 'utf8')))
  : [];
const store = new SnapshotStore(join(root, '.qa-memory', 'knowledge.db'));
const ctxCache = new Map<string, GenerationContext>();
let done = 0;
try {
  for (const a of manifest.artifacts) {
    if (a.kind !== 'spec' || a.dependsOn) continue;
    const caseId = a.testCaseIds[0] ?? '';
    if (a.origin === 'mechanical') {
      a.dependsOn = []; // a skeleton (test.fixme) asserts nothing
      done++;
      continue;
    }
    const run = a.buildRun ?? manifest.buildRun;
    const irFile = run ? join(root, 'runs', run, 'build', 'ir', `${caseId}.json`) : '';
    const snap = a.snapshotId ? store.get(a.snapshotId) : undefined;
    if (!run || !existsSync(irFile) || !snap) {
      console.log(`skip ${caseId}: ${!snap ? `snapshot ${a.snapshotId ?? '?'} not stored` : `no IR in ${run ?? '?'}`}`);
      continue;
    }
    let ctx = ctxCache.get(snap.info.id);
    if (!ctx) {
      const facts = new SnapshotFacts(snap);
      const recipes: RecipeView[] = [];
      for (const name of a.dataBindings) {
        recipes.push({ name, plan: buildDataPlan({ loaded: loadRecipe(root, name), facts, org, runId: 'backfill' }) });
      }
      ctx = {
        storyKey: story,
        designRunId: manifest.designRun ?? '',
        snapshotId: snap.info.id,
        orgAlias: org.alias,
        environment: org.environment,
        catalog,
        recipes,
        facts,
        personas: [],
      };
      ctxCache.set(snap.info.id, ctx);
    }
    const tc = cases.find((c) => c.id === caseId);
    const recipe = ctx.recipes.find((r) => a.dataBindings.includes(r.name)) ?? (tc ? bindRecipe(tc, ctx) : undefined);
    const ir = TestIR.parse(JSON.parse(readFileSync(irFile, 'utf8')));
    a.dependsOn = specDependencies(ir, ctx, recipe);
    done++;
    console.log(`${caseId}: ${String(a.dependsOn.length)} dependencies (snapshot ${snap.info.id}, IR ${run})`);
  }
} finally {
  store.close();
}
writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`backfilled ${String(done)} spec(s) in ${file}`);
