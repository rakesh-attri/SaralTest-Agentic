// `qa run --story <key> --org <alias> --plan-only`: the execution gate the Phase 5 runner uses, without executing.
// Staleness is re-checked against the org's latest snapshot and locator registry first; a stale spec is BLOCKED
// ("stale: <component> changed in <snapshot>") and never run. Execution itself arrives in Phase 5.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { z } from 'zod';
import { storyManifestFile } from '../agents/test-generator/staleness.js';
import { projectPaths, requireConfig } from '../config/loader.js';
import { QAError } from '../core/errors.js';
import { newRunId, runPaths } from '../core/runFolder.js';
import { GeneratedArtifact } from '../core/schemas/generation.js';
import { SnapshotStore } from '../knowledge/snapshotStore.js';
import { executionPlan, type GateItem } from '../runner/gate.js';
import { SnapshotFacts } from '../sf/data/plan.js';
import { markStaleSpecs } from './discover.js';

type Say = (msg: string) => void;

const Manifest = z.object({
  artifacts: z.array(GeneratedArtifact),
  manualOnly: z.array(z.object({ caseId: z.string(), reason: z.string() })).default([]),
});

/** Refresh STALE marks against the latest snapshot, then decide what may execute. */
export async function planExecution(root: string, orgAlias: string, storyKey: string): Promise<GateItem[]> {
  const orgs = await requireConfig('orgs', projectPaths(root));
  const org = orgs.orgs.find((x) => x.alias === orgAlias);
  if (!org) throw new QAError('ENVIRONMENT', `org alias "${orgAlias}" is not in config/orgs.yaml`);
  const file = storyManifestFile(root, storyKey);
  if (!existsSync(file)) throw new QAError('DATA', `no generated specs for ${storyKey}`, { fix: 'run qa build first' });
  const store = new SnapshotStore(join(root, '.qa-memory', 'knowledge.db'));
  try {
    const info = store.latest(org.orgId);
    const snap = info ? store.get(info.id) : undefined;
    if (!snap) throw new QAError('DATA', `no snapshot for ${orgAlias}`, { fix: `pnpm qa discover --org ${orgAlias}` });
    markStaleSpecs(root, org.orgId, new SnapshotFacts(snap));
  } finally {
    store.close();
  }
  return executionPlan(Manifest.parse(JSON.parse(readFileSync(file, 'utf8'))));
}

export function registerRun(program: Command, rootOf: () => string, say: Say): void {
  program
    .command('run')
    .description('Execution gate: which generated specs may run (stale → BLOCKED). Execution arrives in Phase 5.')
    .requiredOption('--story <key>', 'story whose generated specs to plan (tests/generated/<key>)')
    .requiredOption('--org <alias>', 'org whose latest snapshot / locator registry the staleness check uses')
    .option('--plan-only', 'decide and report only; no test is executed')
    .option('--run-id <id>', 'run id (default run-<timestamp>)')
    .action(async (o: { story: string; org: string; planOnly?: boolean; runId?: string }) => {
      const root = rootOf();
      const items = await planExecution(root, o.org, o.story);
      const runId = o.runId ?? newRunId('run');
      const dir = join(runPaths(root, runId).dir, 'run');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'execution-plan.json'), `${JSON.stringify(items, null, 2)}\n`);
      const count = (d: string): number => items.filter((i) => i.decision === d).length;
      say(
        `Execution plan for ${o.story} on ${o.org}: ${count('EXECUTE')} EXECUTE · ${count('BLOCKED')} BLOCKED · ${count('NOT_APPROVED')} NOT_APPROVED · ${count('MANUAL')} MANUAL`,
      );
      for (const i of items) say(`  ${i.decision.padEnd(12)} ${i.caseId}  ${i.reason}`);
      say(`Saved: ${join(dir, 'execution-plan.json')}`);
      if (!o.planOnly) {
        say('Test execution arrives in Phase 5 (PLAN.md §11): nothing was executed. Use --plan-only for the gate.');
        process.exitCode = 2;
      }
    });
}
