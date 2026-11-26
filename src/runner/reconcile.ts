// Post-run data reconciliation (Phase 5). Every test owns a data sub-run (`runs/<id>/data/<hash>/`, written by the
// Playwright `data` fixture). After the tests:
//   1. each sub-run with a plan + ledger goes through the data engine's cleanup again: uncertain writes reconciled,
//      anything still CONFIRMED deleted (tag re-checked per record), re-query per sub-run tag;
//   2. a run-wide re-query per object finds anything still tagged `<runId>-…` (nothing is ever deleted by that
//      prefix query — leftovers are reported for `qa cleanup --run`, because deleting needs the exact sub-run tag).
// A sub-run with a ledger but no plan (crash before planning finished) is INCOMPLETE and listed.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { OrgEntry } from '../config/schemas.js';
import { DataPlan, type CleanupReport, type CreatedRecord } from '../core/schemas/data.js';
import { WriteLedger } from '../security/idempotency.js';
import { DataEngine, soqlString, type DataClient } from '../sf/data/engine.js';
import { writeDataOutputs } from '../sf/data/report.js';

export interface SubRunOutcome {
  dir: string;
  /** Run tag value of the sub-run (`<runId>-<hash>`). */
  tag?: string;
  status: CleanupReport['status'] | 'NO_PLAN';
  created: CreatedRecord[];
  remaining: { object: string; recordId: string }[];
  note?: string;
}

export interface ReconcileReport {
  runId: string;
  orgId: string;
  subRuns: SubRunOutcome[];
  /** Run-wide re-query (tag prefix) per object. */
  queries: string[];
  remaining: { object: string; recordId: string }[];
  status: 'CLEAN' | 'INCOMPLETE' | 'KEPT' | 'NONE';
}

/** Sub-run folders of a run (`data/<hash>/` holding a writes.jsonl). */
export function subRunDirs(runDir: string): string[] {
  const root = join(runDir, 'data');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((n) => join(root, n))
    .filter((d) => statSync(d).isDirectory() && existsSync(join(d, 'writes.jsonl')))
    .sort();
}

export async function reconcileRun(o: {
  runId: string;
  runDir: string;
  org: OrgEntry;
  sf: DataClient;
  keep?: boolean;
  log?: (m: string) => void;
}): Promise<ReconcileReport> {
  const subRuns: SubRunOutcome[] = [];
  const objects = new Set<string>();
  for (const dir of subRunDirs(o.runDir)) {
    const planFile = join(dir, 'data-plan.json');
    const ledger = new WriteLedger(join(dir, 'writes.jsonl'));
    if (!existsSync(planFile)) {
      const open = ledger.all().filter((w) => w.state === 'CONFIRMED' || w.state === 'UNCERTAIN');
      subRuns.push({
        dir,
        status: open.length ? 'NO_PLAN' : 'CLEAN',
        created: [],
        remaining: open.map((w) => ({ object: w.object, recordId: w.recordId ?? '(uncertain)' })),
        ...(open.length ? { note: 'ledger without a data plan: clean up by hand or with qa cleanup' } : {}),
      });
      continue;
    }
    const plan = DataPlan.parse(JSON.parse(readFileSync(planFile, 'utf8')));
    for (const s of plan.steps) objects.add(s.object);
    for (const w of ledger.all()) objects.add(w.object);
    const engine = new DataEngine({ sf: o.sf, plan, ledger, org: o.org, ...(o.log ? { log: o.log } : {}) });
    const cleanup = await engine.cleanup({ keep: o.keep === true });
    const created = engine.createdRecords();
    writeDataOutputs(dir, { plan, created, cleanup });
    subRuns.push({
      dir,
      tag: plan.runTag.value,
      status: cleanup.status,
      created,
      remaining: cleanup.verify.remaining,
    });
  }

  const queries: string[] = [];
  const remaining = new Map<string, { object: string; recordId: string }>();
  const field = o.org.runTagField;
  if (field && !o.keep) {
    for (const object of [...objects].sort()) {
      const q = `SELECT Id FROM ${object} WHERE ${field} LIKE ${soqlString(`${o.runId}-%`)}`;
      queries.push(q);
      for (const r of await o.sf.query<{ Id: string }>(q))
        remaining.set(`${object}:${r.Id}`, { object, recordId: r.Id });
    }
  }
  for (const s of subRuns) for (const r of s.remaining) remaining.set(`${r.object}:${r.recordId}`, r);
  const status: ReconcileReport['status'] = !subRuns.length
    ? 'NONE'
    : o.keep
      ? 'KEPT'
      : remaining.size === 0 && subRuns.every((s) => s.status === 'CLEAN')
        ? 'CLEAN'
        : 'INCOMPLETE';
  return { runId: o.runId, orgId: o.org.orgId, subRuns, queries, remaining: [...remaining.values()], status };
}
