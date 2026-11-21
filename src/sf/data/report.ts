// Data engine outputs (runs/<runId>/data/): plan, ledger, verification, negatives, cleanup/reconciliation report.
// JSON files keep raw record ids (local run folder); the Markdown report masks them.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CleanupReport,
  CreatedRecord,
  DataPlan,
  NegativeOutcome,
  RecordVerification,
} from '../../core/schemas/data.js';

export interface DataRunOutputs {
  plan: DataPlan;
  created?: CreatedRecord[];
  verify?: RecordVerification[];
  negatives?: NegativeOutcome[];
  cleanup?: CleanupReport;
  approvalId?: string;
}

/** `001dN00000AbCdEFGH` → `001…FGH` (enough to correlate, not enough to look up). */
export const maskId = (id: string): string => (id.length >= 15 ? `${id.slice(0, 3)}…${id.slice(-3)}` : id);

/** Mask quoted 15/18-character record ids inside a SOQL string. */
export const maskIdsIn = (soql: string): string =>
  soql.replace(/'([a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?)'/g, (_m, id: string) => `'${maskId(id)}'`);

const json = (dir: string, name: string, v: unknown): string => {
  const f = join(dir, name);
  writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`, 'utf8');
  return f;
};

export function renderDataReport(o: DataRunOutputs): string {
  const p = o.plan;
  const label = p.environment === 'LIVE' ? 'LIVE' : 'FIXTURE — offline fixture, not Salesforce';
  const L: string[] = [];
  L.push(`# Test data report — ${p.runId}`, '');
  L.push(`- Environment: **${label}** · org ${p.orgAlias} · snapshot \`${p.snapshotId}\``);
  L.push(
    `- Recipe: \`${p.recipe}\` (hash \`${p.recipeHash}\`, approved by ${p.approvedBy})${o.approvalId ? ` · run approval ${o.approvalId}` : ''}`,
  );
  L.push(
    `- Run tag: ${p.runTag.field ? `\`${p.runTag.field}\` = \`${p.runTag.value}\`` : `name prefix QA-${p.runTag.value}-`}`,
  );
  L.push(
    `- Plan: ${p.valid ? 'valid' : '**INVALID**'} · ${p.steps.length} step(s) · ${p.negatives.length} negative variant(s)`,
    '',
  );
  if (p.issues.length) {
    L.push('## Plan issues', '', '| Severity | Code | Step | Message |', '|---|---|---|---|');
    for (const i of p.issues)
      L.push(`| ${i.severity} | ${i.code} | ${i.stepId ?? ''} | ${i.message.replace(/\|/g, '\\|')} |`);
    L.push('');
  }
  L.push('## Plan', '', '| # | Step | Object | Parent | Fields (source) | Unique key |', '|---|---|---|---|---|---|');
  for (const s of p.steps) {
    const fields = Object.keys(s.fields)
      .map((f) => `${f} (${s.fieldSources[f] ?? 'recipe'})`)
      .join(', ');
    L.push(
      `| ${s.order} | ${s.stepId} | ${s.object} | ${s.parent ? `${s.parent.field} → ${s.parent.stepId}` : ''} | ${fields} | ${s.uniqueKey.field} |`,
    );
  }
  L.push('');
  if (o.created) {
    L.push('## Created (dependency order)', '', '| Order | Step | Object | Record | Via |', '|---|---|---|---|---|');
    for (const c of [...o.created].sort((a, b) => a.order - b.order)) {
      L.push(`| ${c.order} | ${c.step ?? ''} | ${c.object} | ${maskId(c.recordId)} | ${c.via} |`);
    }
    L.push('');
  }
  if (o.verify) {
    L.push('## Read-back verification', '', '| Step | Field | Result |', '|---|---|---|');
    for (const v of o.verify) {
      for (const c of v.checks)
        L.push(
          `| ${v.stepId} | ${c.field} | ${c.ok ? 'ok' : `**MISMATCH** (expected ${String(c.expected)}, got ${String(c.actual)})`} |`,
        );
    }
    L.push('');
  }
  if (o.negatives) {
    L.push(
      '## Negative variants (rejection only)',
      '',
      '| Variant | Object | Outcome | Error codes |',
      '|---|---|---|---|',
    );
    for (const n of o.negatives) L.push(`| ${n.name} | ${n.object} | ${n.outcome} | ${n.errorCodes.join(', ')} |`);
    L.push('');
  }
  if (o.cleanup) {
    const c = o.cleanup;
    L.push(`## Cleanup — ${c.status}`, '', '| Step | Object | Record | Action | Reason |', '|---|---|---|---|---|');
    for (const e of c.entries)
      L.push(`| ${e.stepId ?? ''} | ${e.object} | ${maskId(e.recordId)} | ${e.action} | ${e.reason ?? ''} |`);
    if (c.reconciled.length) {
      L.push('', 'Reconciled uncertain writes:', '');
      for (const r of c.reconciled) L.push(`- ${r.idempotencyKey}: ${r.outcome}`);
    }
    L.push('', '**Independent re-query after cleanup:**', '');
    for (const q of c.verify.queries) L.push(`- \`${maskIdsIn(q)}\``);
    L.push(
      '',
      `Remaining records: **${c.verify.remaining.length}**${c.verify.remaining.length ? ` (${c.verify.remaining.map((r) => `${r.object} ${maskId(r.recordId)}`).join(', ')})` : ''}`,
    );
  }
  L.push('');
  return L.join('\n');
}

export function writeDataOutputs(dir: string, o: DataRunOutputs): string[] {
  mkdirSync(dir, { recursive: true });
  const files = [json(dir, 'data-plan.json', o.plan)];
  if (o.created) files.push(json(dir, 'data-ledger.json', o.created));
  if (o.verify) files.push(json(dir, 'verify.json', o.verify));
  if (o.negatives) files.push(json(dir, 'negatives.json', o.negatives));
  if (o.cleanup) files.push(json(dir, 'cleanup-report.json', o.cleanup));
  const md = join(dir, o.cleanup ? 'cleanup-report.md' : 'data-plan.md');
  writeFileSync(md, renderDataReport(o), 'utf8');
  files.push(md);
  return files;
}
