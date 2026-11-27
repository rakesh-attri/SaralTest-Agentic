// `qa visual approve --run <id> --by <name>` (PLAN.md §7g): a human accepts the candidate images of one visual run as
// the new baselines (checkpoint `approve-visual-baseline`, required at every autonomy level). The approval is bound
// to the exact images (sha256 of each), recorded in `.qa-memory/approvals.jsonl`, audited in the run's audit.jsonl,
// and the images are copied into `<baselineDir>/<org>/` with a BaselineRecord each. `--a11y` also accepts the run's
// NEW_STANDARD (Salesforce-owned) axe rules per region × viewport. Nothing is approved implicitly.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { OrgEntry } from '../config/schemas.js';
import { QAError } from '../core/errors.js';
import { runPaths } from '../core/runFolder.js';
import type { Approval } from '../core/schemas/data.js';
import type { A11yBaselineEntry, BaselineRecord, VisualCandidate, VisualRunSummary } from '../core/schemas/visual.js';
import { ApprovalStore } from '../security/approvals.js';
import { AuditLog } from '../security/audit.js';
import { Redactor } from '../security/redact.js';
import { baselineFolder, baselineImage, loadBaselines, saveBaselines, sha256File } from './baselines.js';
import { loadVisualSummary } from './run.js';

export const VISUAL_BASELINE_CHECKPOINT = 'approve-visual-baseline';
const APPROVABLE = new Set(['NO_BASELINE', 'DIFF', 'RE_APPROVE']);

export interface ApproveOptions {
  root: string;
  runId: string;
  org: OrgEntry;
  baselineDir: string;
  approvedBy: string;
  /** Approve only these snapshot names (default: every approvable candidate of the run). */
  only?: readonly string[];
  /** Also accept the run's NEW_STANDARD a11y rules. */
  a11y?: boolean;
  note?: string;
  approvalsFile: string;
}

export interface ApproveResult {
  approval?: Approval;
  approved: BaselineRecord[];
  a11yAccepted: A11yBaselineEntry[];
  skipped: { name: string; reason: string }[];
  manifestFile?: string;
}

/** The candidates `approve` would store, with why others are left out. */
export function approvable(
  s: VisualRunSummary,
  runDir: string,
  only?: readonly string[],
): { take: VisualCandidate[]; skipped: { name: string; reason: string }[] } {
  const take: VisualCandidate[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const unknown = (only ?? []).filter((n) => !s.candidates.some((c) => c.name === n));
  if (unknown.length) throw new QAError('DATA', `not in run ${s.runId}: ${unknown.join(', ')}`);
  for (const c of s.candidates) {
    if (only?.length && !only.includes(c.name)) continue;
    if (!APPROVABLE.has(c.status)) {
      if (only?.length || c.status !== 'MATCH') skipped.push({ name: c.name, reason: `status ${c.status}` });
      continue;
    }
    const img = c.images.actual ? join(runDir, c.images.actual) : undefined;
    if (!img || !existsSync(img) || !c.actualSha256) {
      skipped.push({ name: c.name, reason: 'no actual image in the run folder' });
      continue;
    }
    if (sha256File(img) !== c.actualSha256) {
      skipped.push({ name: c.name, reason: 'actual image changed after the run (hash differs) — re-run' });
      continue;
    }
    take.push(c);
  }
  return { take, skipped };
}

/** Approval subject: org + the exact images (`name=sha256`, sorted). */
export function visualSubject(org: string, take: readonly VisualCandidate[], a11yRules: readonly string[]): string {
  const h = createHash('sha256')
    .update([...take.map((c) => `${c.name}=${c.actualSha256 ?? ''}`), ...a11yRules].sort().join('\n'))
    .digest('hex')
    .slice(0, 16);
  return `visual:${org}:${h}`;
}

export function approveBaselines(o: ApproveOptions): ApproveResult {
  const runDir = runPaths(o.root, o.runId).dir;
  const s = loadVisualSummary(runDir);
  if (s.org !== o.org.alias || s.orgId !== o.org.orgId) {
    throw new QAError('DATA', `run ${o.runId} was on ${s.org} (${s.orgId}), not ${o.org.alias}`);
  }
  const { take, skipped } = approvable(s, runDir, o.only);
  const newRules = o.a11y ? s.a11y.filter((f) => f.status === 'NEW_STANDARD') : [];
  if (!take.length && !newRules.length) return { approved: [], a11yAccepted: [], skipped };

  const ruleKeys = newRules.map((f) => `a11y:${f.region}:${f.viewport}:${f.ruleId}`);
  const approval = new ApprovalStore(o.approvalsFile).record({
    checkpoint: VISUAL_BASELINE_CHECKPOINT,
    subject: visualSubject(s.org, take, ruleKeys),
    orgId: o.org.orgId,
    approvedBy: o.approvedBy,
    runId: o.runId,
    note:
      o.note ??
      `${String(take.length)} baseline(s): ${take.map((c) => `${c.name} (${c.status})`).join(', ')}${ruleKeys.length ? `; a11y: ${ruleKeys.join(', ')}` : ''}`,
  });
  const audit = new AuditLog(runPaths(o.root, o.runId).auditLog, new Redactor());
  const folder = baselineFolder(o.root, o.baselineDir, o.org.alias);
  mkdirSync(folder, { recursive: true });
  const m = loadBaselines(folder, o.org);
  const approved: BaselineRecord[] = [];
  for (const c of take) {
    const target = baselineImage(folder, c.name);
    const before = m.baselines.find((b) => b.name === c.name);
    copyFileSync(join(runDir, c.images.actual ?? ''), target);
    const rec: BaselineRecord = {
      name: c.name,
      region: c.region,
      persona: c.persona,
      viewport: c.viewport,
      sha256: sha256File(target),
      release: s.release,
      approvedBy: o.approvedBy,
      approvalId: approval.id,
      approvedAt: approval.approvedAt,
      sourceRun: o.runId,
    };
    m.baselines = [...m.baselines.filter((b) => b.name !== c.name), rec];
    approved.push(rec);
    audit.append({
      runId: o.runId,
      orgId: o.org.orgId,
      user: o.approvedBy,
      persona: c.persona,
      action: 'mutate',
      tool: 'qa visual approve',
      object: 'VisualBaseline',
      recordId: c.name,
      before: before ? { sha256: before.sha256, approvalId: before.approvalId } : null,
      after: { sha256: rec.sha256, status: c.status },
      approvalId: approval.id,
      outcome: 'SUCCEEDED',
    });
  }
  const a11yAccepted: A11yBaselineEntry[] = [];
  const groups = new Map<string, typeof newRules>();
  for (const f of newRules)
    groups.set(`${f.region}|${f.viewport}`, [...(groups.get(`${f.region}|${f.viewport}`) ?? []), f]);
  for (const fs of groups.values()) {
    const f0 = fs[0];
    if (!f0) continue;
    const prev = m.a11y.find((e) => e.region === f0.region && e.viewport === f0.viewport);
    const entry: A11yBaselineEntry = {
      region: f0.region,
      viewport: f0.viewport,
      ruleIds: [...new Set([...(prev?.ruleIds ?? []), ...fs.map((f) => f.ruleId)])].sort(),
      approvalId: approval.id,
      approvedAt: approval.approvedAt,
      sourceRun: o.runId,
    };
    m.a11y = [...m.a11y.filter((e) => e !== prev), entry];
    a11yAccepted.push(entry);
    audit.append({
      runId: o.runId,
      orgId: o.org.orgId,
      user: o.approvedBy,
      persona: s.persona,
      action: 'mutate',
      tool: 'qa visual approve --a11y',
      object: 'A11yBaseline',
      recordId: `${entry.region}-${entry.viewport}`,
      before: prev ? { ruleIds: prev.ruleIds } : null,
      after: { ruleIds: entry.ruleIds },
      approvalId: approval.id,
      outcome: 'SUCCEEDED',
    });
  }
  const manifestFile = saveBaselines(folder, m);
  return { approval, approved, a11yAccepted, skipped, manifestFile };
}
