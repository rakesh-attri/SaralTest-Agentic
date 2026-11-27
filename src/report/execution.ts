// Reporter (Phase 5): the reports of an execution run, written to runs/<runId>/report/ from the run folder (so
// `qa report --run <id>` rebuilds them without the graph). Playwright HTML and reporting-labs are written by the
// Playwright reporters themselves; this adds (PLAN.md §10, reporting skill):
//   execution-report.md/.html · release-confidence.md/.json · cleanup-reconciliation.md · impact-coverage.md +
//   rtm-results.xlsx · history.md (+ .qa-memory/history.jsonl) · model-attempts.json · index.md
// Every row carries its environment; FIXTURE / MOCK are never presented as a Salesforce result (rule 13).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { Clarification } from '../core/schemas/requirement.js';
import { RiskItem } from '../core/schemas/design.js';
import {
  ExecutionSummary,
  ReleaseConfidence,
  RunHistoryEntry,
  StoryManifest,
  type ReleaseVerdict,
} from '../core/schemas/execution.js';
import { RtmRow, TestCase } from '../core/schemas/testCase.js';
import { TestResult, type ResultState } from '../core/schemas/result.js';
import type { Environment } from '../core/schemas/common.js';
import type { FailedAttempt } from '../models/attemptLog.js';
import type { GateItem } from '../runner/gate.js';
import type { ReconcileReport } from '../runner/reconcile.js';
import { maskId } from '../sf/data/report.js';
import { environmentBanner, environmentLabel, esc, md } from './format.js';

const read = <T>(file: string, schema: z.ZodType<T>): T | undefined =>
  existsSync(file) ? schema.parse(JSON.parse(readFileSync(file, 'utf8'))) : undefined;
const readRaw = (file: string): unknown =>
  existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown) : undefined;

const GateItemSchema = z.object({
  caseId: z.string(),
  path: z.string().optional(),
  decision: z.enum(['EXECUTE', 'BLOCKED', 'NOT_APPROVED', 'MANUAL', 'NOT_SELECTED']),
  reason: z.string(),
});
const DesignRunFile = z.looseObject({
  runId: z.string(),
  analysisRun: z.string().optional(),
  summary: z.looseObject({ acs: z.array(z.object({ ref: z.string(), caseIds: z.array(z.string()) })).default([]) }),
});
const CharterFile = z.looseObject({
  personas: z.array(z.object({ id: z.string(), available: z.boolean() })).default([]),
});

export interface ReportData {
  root: string;
  runId: string;
  runDir: string;
  status: 'COMPLETE' | 'PARTIAL' | 'BLOCKED' | 'RUNNING';
  summary: ExecutionSummary;
  results: TestResult[];
  gate: GateItem[];
  reconcile?: ReconcileReport;
  blockedReason?: string;
  manifest?: StoryManifest;
  design?: {
    runId: string;
    cases: TestCase[];
    rtm: RtmRow[];
    acs: { ref: string; caseIds: string[] }[];
    risks: RiskItem[];
    personas: { id: string; available: boolean }[];
  };
  analysisRun?: string;
  clarifications: Clarification[];
  failedAttempts: FailedAttempt[];
  /** JIRA browse base (`https://<site>.atlassian.net`) for story links; never a secret. */
  jiraBaseUrl?: string;
}

/**
 * Acceptance criteria → every case that covers them, from the RTM (the design summary lists one representative case
 * per AC only). Falls back to the summary when the RTM has no AC refs.
 */
export function acsFromRtm(
  rtm: readonly RtmRow[],
  fallback: readonly { ref: string; caseIds: string[] }[],
): { ref: string; caseIds: string[] }[] {
  const m = new Map<string, Set<string>>();
  for (const r of rtm)
    for (const ref of r.refs.filter((x) => /^AC\d+$/.test(x))) {
      const set = m.get(ref) ?? new Set<string>();
      for (const c of r.testCaseIds) set.add(c);
      m.set(ref, set);
    }
  for (const a of fallback) if (!m.has(a.ref)) m.set(a.ref, new Set(a.caseIds));
  return [...m.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([ref, ids]) => ({ ref, caseIds: [...ids] }));
}

/** Load everything the reports need from the run folder, the story manifest and the design / analysis runs. */
export function loadReportData(o: {
  root: string;
  runId: string;
  status?: ReportData['status'];
  analysisRun?: string;
  failedAttempts?: FailedAttempt[];
  jiraBaseUrl?: string;
}): ReportData {
  const runDir = join(o.root, 'runs', o.runId);
  const summary = read(join(runDir, 'run', 'execution-summary.json'), ExecutionSummary);
  if (!summary) throw new Error(`run ${o.runId} has no execution summary (runs/${o.runId}/run/execution-summary.json)`);
  const results = read(join(runDir, 'results.json'), z.array(TestResult)) ?? [];
  const gate = read(join(runDir, 'run', 'execution-plan.json'), z.array(GateItemSchema)) ?? [];
  const reconcile = readRaw(join(runDir, 'run', 'data-reconciliation.json')) as ReconcileReport | undefined;
  const manifestFile = join(o.root, 'tests', 'generated', summary.storyKey, 'manifest.json');
  const manifest = read(manifestFile, StoryManifest);
  let design: ReportData['design'];
  let analysisRun = o.analysisRun;
  if (manifest?.designRun) {
    const d = join(o.root, 'runs', manifest.designRun, 'design');
    const dr = read(join(d, 'design-run.json'), DesignRunFile);
    analysisRun ??= dr?.analysisRun;
    design = {
      runId: manifest.designRun,
      cases: read(join(d, 'test-cases.json'), z.array(TestCase)) ?? [],
      rtm: read(join(d, 'rtm.json'), z.array(RtmRow)) ?? [],
      acs: acsFromRtm(read(join(d, 'rtm.json'), z.array(RtmRow)) ?? [], dr?.summary.acs ?? []),
      risks: read(join(d, 'risks.json'), z.array(RiskItem)) ?? [],
      personas: read(join(d, 'charter.json'), CharterFile)?.personas ?? [],
    };
  }
  const clarifications = analysisRun
    ? (read(join(o.root, 'runs', analysisRun, 'analysis', 'clarifications.json'), z.array(Clarification)) ?? [])
    : [];
  const failedAttempts =
    o.failedAttempts ?? (readRaw(join(runDir, 'report', 'model-attempts.json')) as FailedAttempt[] | undefined) ?? [];
  return {
    root: o.root,
    runId: o.runId,
    runDir,
    status: o.status ?? summary.status ?? 'PARTIAL',
    summary,
    results,
    gate,
    ...(reconcile ? { reconcile } : {}),
    ...(summary.blockedReason ? { blockedReason: summary.blockedReason } : {}),
    ...(manifest ? { manifest } : {}),
    ...(design ? { design } : {}),
    ...(analysisRun ? { analysisRun } : {}),
    clarifications,
    failedAttempts,
    ...(o.jiraBaseUrl ? { jiraBaseUrl: o.jiraBaseUrl } : {}),
  };
}

// ------------------------------------------------------------------ derived views

const executedIds = (d: ReportData): Set<string> =>
  new Set(d.gate.filter((g) => g.decision === 'EXECUTE').map((g) => g.caseId));
const resultOf = (d: ReportData, caseId: string): TestResult | undefined => d.results.find((r) => r.caseId === caseId);
const caseOf = (d: ReportData, caseId: string): TestCase | undefined => d.design?.cases.find((c) => c.id === caseId);

/** Release confidence (reporting skill template line 1–2). Non-LIVE evidence never supports a release verdict. */
export function releaseConfidence(d: ReportData): ReleaseConfidence {
  const env = d.summary.environment;
  const ran = d.results.filter((r) => executedIds(d).has(r.caseId ?? ''));
  const passed = new Set(ran.filter((r) => r.state === 'PASS').map((r) => r.caseId ?? ''));
  const acs = d.design?.acs ?? [];
  const acCovered = acs.filter((a) => a.caseIds.length > 0).length;
  const acPassed = acs.filter((a) => a.caseIds.some((c) => passed.has(c))).length;
  const reasons: string[] = [];
  const n = (s: ResultState): number => ran.filter((r) => r.state === s).length;
  if (env !== 'LIVE') reasons.push(`results are ${env}: no live Salesforce evidence — not a release verdict`);
  if (d.status === 'BLOCKED') reasons.push(`run BLOCKED: ${d.blockedReason ?? 'see the execution report'}`);
  if (n('FAIL')) reasons.push(`${String(n('FAIL'))} executed test(s) FAILED`);
  if (n('BLOCKED')) reasons.push(`${String(n('BLOCKED'))} selected test(s) BLOCKED`);
  if (n('UNCERTAIN'))
    reasons.push(`${String(n('UNCERTAIN'))} test(s) UNCERTAIN (flaky, interrupted or data not clean)`);
  if (acs.length && acPassed < acs.length)
    reasons.push(
      `${String(acs.length - acPassed)} of ${String(acs.length)} acceptance criteria have no passing executed test`,
    );
  const notRun = d.gate.filter((g) => g.decision === 'NOT_APPROVED' || g.decision === 'BLOCKED').length;
  if (notRun) reasons.push(`${String(notRun)} generated spec(s) not executed (not approved or stale)`);
  if (d.reconcile && d.reconcile.status === 'INCOMPLETE') reasons.push('test data cleanup INCOMPLETE');
  let verdict: ReleaseVerdict;
  let why: string;
  if (env !== 'LIVE' || d.status === 'BLOCKED' || n('FAIL') || n('BLOCKED') || !ran.length) {
    verdict = 'Not ready';
    why =
      env !== 'LIVE'
        ? `Only ${env} evidence: the offline fixture cannot show that the Salesforce org meets the story.`
        : !ran.length
          ? 'No test was executed.'
          : n('FAIL')
            ? `${String(n('FAIL'))} executed test(s) failed on ${d.summary.orgAlias}; failures are not investigated yet.`
            : 'The run did not execute every selected test.';
  } else if (reasons.length) {
    verdict = 'Ready with risks';
    why = `Every executed test passed on ${d.summary.orgAlias}, but coverage is incomplete (${reasons[0] ?? ''}).`;
  } else {
    verdict = 'Ready';
    why = `Every acceptance criterion has a passing LIVE test on ${d.summary.orgAlias} and the data is clean.`;
  }
  return ReleaseConfidence.parse({
    verdict,
    why,
    reasons,
    environment: env,
    acCoverage: { covered: acCovered, executedPassed: acPassed, total: acs.length },
  });
}

function countBy<T>(rows: readonly T[], key: (r: T) => string): Record<string, Record<ResultState, number>> {
  const out: Record<string, Record<ResultState, number>> = {};
  for (const r of rows) {
    const k = key(r);
    out[k] ??= { PASS: 0, FAIL: 0, BLOCKED: 0, SKIPPED: 0, UNCERTAIN: 0 };
    const state = (r as unknown as TestResult).state;
    out[k][state]++;
  }
  return out;
}

// ------------------------------------------------------------------ renderers

const stateCell = (s: ResultState): string => (s === 'PASS' ? 'PASS' : s === 'FAIL' ? '**FAIL**' : s);

export function renderExecutionReport(d: ReportData): string {
  const s = d.summary;
  const L: string[] = [];
  L.push(`# Execution report — ${s.storyKey} · ${d.runId}`, '');
  const banner = environmentBanner(s.environment);
  if (banner) L.push(banner, '');
  L.push(
    `- Status: **${d.status}** · environment **${environmentLabel(s.environment)}** · org ${s.orgAlias} · browser ${s.browser}${s.requestedBrowser ? ` (requested ${s.requestedBrowser}: fallback)` : ''}`,
    `- Started ${s.startedAt} · finished ${s.finishedAt} · Playwright exit ${s.exitCode === null ? 'n/a' : String(s.exitCode)}`,
    `- Lineage: design \`${d.manifest?.designRun ?? '?'}\` → build \`${d.manifest?.buildRun ?? '?'}\` → this run${d.analysisRun ? ` (analysis \`${d.analysisRun}\`)` : ''}`,
  );
  if (d.blockedReason) L.push(`- **BLOCKED:** ${d.blockedReason}`);
  L.push('', '## Gate (which specs may run)', '');
  L.push(
    Object.entries(s.gate)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k} ${String(v)}`)
      .join(' · '),
    '',
  );
  const x = s.executed;
  L.push('## Results', '');
  L.push(
    `Executed: **${String(x.PASS)} PASS · ${String(x.FAIL)} FAIL · ${String(x.UNCERTAIN)} UNCERTAIN · ${String(x.BLOCKED)} BLOCKED · ${String(x.SKIPPED)} SKIPPED** (flaky ${String(s.flaky)}) · data cleanup **${s.cleanup}**`,
    '',
  );
  L.push('| Case | Title | Type | Priority | Persona | Result | Env | Browser | Time | Reason |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of d.results) {
    const c = caseOf(d, r.caseId ?? '');
    L.push(
      `| ${r.caseId ?? r.testId} | ${md(c?.title ?? '')} | ${c?.type ?? ''} | ${c?.priority ?? ''} | ${r.persona ?? c?.persona ?? ''} | ${stateCell(r.state)} | ${r.environment} | ${r.browser ?? ''} | ${r.durationMs !== undefined ? `${(r.durationMs / 1000).toFixed(1)} s` : ''} | ${md((r.reason ?? '').slice(0, 300))} |`,
    );
  }
  const failures = d.results.filter((r) => r.state === 'FAIL' || r.state === 'UNCERTAIN');
  if (failures.length) {
    L.push('', '## Failures and uncertain results (not investigated yet — Phase 7)', '');
    for (const r of failures) {
      L.push(`### ${r.caseId ?? r.testId} — ${r.state}`, '');
      if (r.errorSummary) L.push('```', r.errorSummary, '```');
      for (const a of r.attachments) L.push(`- ${a.name}: \`${a.path}\``);
      L.push('');
    }
  }
  L.push('', '## Reports', '');
  L.push('- Playwright HTML: `playwright-report/index.html`', '- reporting-labs: `reporting-labs/`');
  return `${L.join('\n')}\n`;
}

export function renderExecutionHtml(d: ReportData): string {
  const s = d.summary;
  const rows = d.results
    .map((r) => {
      const c = caseOf(d, r.caseId ?? '');
      return `<tr class="${r.state.toLowerCase()}"><td>${esc(r.caseId ?? r.testId)}</td><td>${esc(c?.title ?? '')}</td><td>${esc(c?.type ?? '')}</td><td>${esc(c?.priority ?? '')}</td><td>${r.state}</td><td>${r.environment}</td><td>${esc(r.browser ?? '')}</td><td>${esc((r.reason ?? '').slice(0, 300))}</td></tr>`;
    })
    .join('\n');
  const banner =
    s.environment === 'LIVE'
      ? ''
      : `<p class="b">${esc(environmentLabel(s.environment))} — never a real Salesforce pass.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Execution ${esc(s.storyKey)} ${esc(d.runId)}</title>
<style>body{font-family:system-ui,sans-serif;margin:24px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:4px 6px;font-size:13px;text-align:left}
.b{background:#fff3cd;border:1px solid #e0b000;padding:8px}.pass td:nth-child(5){color:#1a7f37;font-weight:600}.fail td:nth-child(5){color:#b42318;font-weight:600}
.uncertain td:nth-child(5),.blocked td:nth-child(5){color:#9a6700;font-weight:600}.skipped{color:#666}</style></head><body>
<h1>Execution report — ${esc(s.storyKey)} · ${esc(d.runId)}</h1>${banner}
<p>Status <b>${d.status}</b> · ${esc(environmentLabel(s.environment))} · org ${esc(s.orgAlias)} · browser ${esc(s.browser)} · data cleanup <b>${s.cleanup}</b></p>
<p>Executed: ${String(s.executed.PASS)} PASS · ${String(s.executed.FAIL)} FAIL · ${String(s.executed.UNCERTAIN)} UNCERTAIN · ${String(s.executed.BLOCKED)} BLOCKED · flaky ${String(s.flaky)}</p>
<table><thead><tr><th>Case</th><th>Title</th><th>Type</th><th>Priority</th><th>Result</th><th>Env</th><th>Browser</th><th>Reason</th></tr></thead><tbody>
${rows}
</tbody></table></body></html>
`;
}

export function renderReleaseConfidence(d: ReportData, rc: ReleaseConfidence): string {
  const ran = d.results.filter((r) => executedIds(d).has(r.caseId ?? ''));
  const L: string[] = [];
  L.push(`# Release confidence — ${d.summary.storyKey} · ${d.runId}`, '');
  const banner = environmentBanner(rc.environment);
  if (banner) L.push(banner, '');
  // 1. Verdict
  L.push(`**${rc.verdict}** — ${rc.why}`, '');
  // 2. Coverage
  const risks = d.design?.risks ?? [];
  const high = risks.filter((r) => r.impact === 'H');
  const passed = new Set(ran.filter((r) => r.state === 'PASS').map((r) => r.caseId ?? ''));
  const highCovered = high.filter((r) =>
    (d.design?.cases ?? []).some((c) => passed.has(c.id) && c.riskIds.includes(r.id)),
  ).length;
  const personas = [...new Set(ran.map((r) => r.persona ?? ''))].filter(Boolean);
  L.push('## Coverage', '');
  L.push(
    `- Acceptance criteria with a test: ${String(rc.acCoverage.covered)}/${String(rc.acCoverage.total)} · with a PASSING executed test: ${String(rc.acCoverage.executedPassed)}/${String(rc.acCoverage.total)}`,
    `- High-impact risks with a passing executed test: ${String(highCovered)}/${String(high.length)}`,
    `- Personas tested: ${personas.join(', ') || 'none'}${
      (d.design?.personas ?? []).filter((p) => !p.available).length
        ? ` (not available: ${(d.design?.personas ?? [])
            .filter((p) => !p.available)
            .map((p) => p.id)
            .join(', ')})`
        : ''
    }`,
    '',
  );
  // 3. Results by type and priority
  L.push('## Results by type and priority (executed tests)', '');
  const byType = countBy(ran, (r) => caseOf(d, r.caseId ?? '')?.type ?? '?');
  const byPrio = countBy(ran, (r) => caseOf(d, r.caseId ?? '')?.priority ?? '?');
  L.push('| Group | PASS | FAIL | UNCERTAIN | BLOCKED |', '|---|---|---|---|---|');
  for (const [k, v] of [
    ...Object.entries(byType).map(([k, v]) => [`type ${k}`, v] as const),
    ...Object.entries(byPrio).map(([k, v]) => [`priority ${k}`, v] as const),
  ])
    L.push(`| ${k} | ${String(v.PASS)} | ${String(v.FAIL)} | ${String(v.UNCERTAIN)} | ${String(v.BLOCKED)} |`);
  L.push('', `Flaky (passed only on retry): ${String(d.summary.flaky)}`, '');
  // 4. Defects
  L.push('## Defects', '');
  const fails = ran.filter((r) => r.state === 'FAIL');
  L.push(
    fails.length
      ? `No defect filed yet: ${String(fails.length)} failure(s) await investigation (Failure Investigator / Defect Judge, Phase 7): ${fails.map((f) => f.caseId).join(', ')}.`
      : 'None.',
    '',
  );
  // 5. Blocked / not tested
  L.push('## Blocked / not tested', '');
  const notRun = d.gate.filter((g) => g.decision !== 'EXECUTE');
  if (!notRun.length) L.push('None.');
  for (const g of notRun) L.push(`- ${g.caseId}: ${g.decision} — ${g.reason}`);
  for (const r of ran.filter((x) => x.state === 'BLOCKED'))
    L.push(`- ${r.caseId ?? ''}: BLOCKED at run time — ${r.reason ?? ''}`);
  L.push('');
  // 6. Assumptions
  L.push('## Assumptions', '');
  const assumed = d.clarifications.filter((c) => c.status === 'ASSUMED');
  const answered = d.clarifications.filter((c) => c.status === 'ANSWERED');
  if (!d.analysisRun) L.push('Analysis run not linked (design run predates lineage); see its clarifications.');
  else if (!assumed.length)
    L.push(
      `None open: ${String(answered.length)} question(s) answered by the operator (${answered.map((c) => c.id).join(', ')}).`,
    );
  for (const c of assumed) L.push(`- ${c.id}: ${c.assumption ?? c.proposedAssumption ?? ''} (needs confirmation)`);
  L.push('');
  // 7. Learnings
  L.push('## Learnings promoted this run', '', 'None (verified learning is Phase 8).', '');
  L.push('## Why this verdict', '', ...rc.reasons.map((r) => `- ${r}`), '');
  return `${L.join('\n')}\n`;
}

export function renderCleanup(d: ReportData): string {
  const L: string[] = [`# Test data cleanup / reconciliation — ${d.runId}`, ''];
  const banner = environmentBanner(d.summary.environment);
  if (banner) L.push(banner, '');
  const r = d.reconcile;
  if (!r) return `${[...L, 'No data reconciliation ran (no test executed).'].join('\n')}\n`;
  L.push(
    `Status: **${r.status}** · ${String(r.subRuns.length)} test data sub-run(s) · ${String(r.remaining.length)} record(s) remaining`,
    '',
  );
  L.push('| Sub-run | Status | Records created | Remaining |', '|---|---|---|---|');
  for (const s of r.subRuns)
    L.push(
      `| ${md(s.tag ?? relative(d.runDir, s.dir))} | ${s.status} | ${s.created.map((c) => `${c.object} ${maskId(c.recordId)}${c.via === 'ui' ? ' (UI, adopted)' : ''}`).join(', ') || '—'} | ${String(s.remaining.length)} |`,
    );
  L.push('', '## Run-wide re-query (tag prefix; never used to delete)', '');
  for (const q of r.queries) L.push(`- \`${q}\``);
  if (r.untagged.length) {
    L.push('', '## Untagged records created during the run (not deleted: not provably run-owned — check by hand)', '');
    for (const x of r.untagged) L.push(`- ${x.object} ${maskId(x.recordId)} created ${x.createdDate}`);
  }
  if (r.remaining.length) {
    L.push('', '## Remaining records (clean with `qa cleanup --run`)', '');
    for (const x of r.remaining) L.push(`- ${x.object} ${maskId(x.recordId)}`);
  }
  return `${L.join('\n')}\n`;
}

export function renderImpactCoverage(d: ReportData): string {
  const L: string[] = [`# Impact & coverage — ${d.summary.storyKey} · ${d.runId}`, ''];
  const banner = environmentBanner(d.summary.environment);
  if (banner) L.push(banner, '');
  if (!d.design) return `${[...L, 'No design run linked in the story manifest.'].join('\n')}\n`;
  L.push(
    `Design \`${d.design.runId}\`. Spec staleness: ${d.manifest?.artifacts.filter((a) => a.stale).length ? `${String(d.manifest.artifacts.filter((a) => a.stale).length)} STALE` : 'none stale'}.`,
    '',
  );
  L.push('| Requirement | Refs | Case | Spec status | Result | Env |', '|---|---|---|---|---|---|');
  for (const row of d.design.rtm) {
    if (!row.testCaseIds.length) {
      L.push(`| ${row.requirementId} | ${row.refs.join(', ')} | — (${row.status}) | | | |`);
      continue;
    }
    for (const id of row.testCaseIds) {
      const g = d.gate.find((x) => x.caseId === id);
      const r = resultOf(d, id);
      L.push(
        `| ${row.requirementId} | ${row.refs.join(', ')} | ${id} | ${g?.decision ?? 'no spec'} | ${r ? stateCell(r.state) : '—'} | ${r?.environment ?? ''} |`,
      );
    }
  }
  L.push('', '## Acceptance criteria', '');
  for (const a of d.design.acs) {
    const states = a.caseIds.map((c) => `${c}: ${resultOf(d, c)?.state ?? 'not run'}`);
    L.push(`- ${a.ref}: ${states.join(', ') || 'no case'}`);
  }
  return `${L.join('\n')}\n`;
}

export async function writeRtmResultsXlsx(d: ReportData, file: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('RTM + results');
  ws.addRow([`Environment: ${environmentLabel(d.summary.environment)} · run ${d.runId}`]);
  ws.addRow(['Requirement', 'Refs', 'Case', 'Title', 'Spec status', 'Result', 'Environment', 'Reason']);
  for (const row of d.design?.rtm ?? []) {
    for (const id of row.testCaseIds.length ? row.testCaseIds : ['']) {
      const r = id ? resultOf(d, id) : undefined;
      ws.addRow([
        row.requirementId,
        row.refs.join(', '),
        id,
        id ? (caseOf(d, id)?.title ?? '') : row.status,
        id ? (d.gate.find((g) => g.caseId === id)?.decision ?? 'no spec') : '',
        r?.state ?? '',
        r?.environment ?? '',
        (r?.reason ?? '').slice(0, 300),
      ]);
    }
  }
  ws.columns.forEach((c) => (c.width = 22));
  await wb.xlsx.writeFile(file);
}

/** Append this run to `.qa-memory/history.jsonl` (one entry per run id) and render the story's trend. */
export function updateHistory(d: ReportData): { entries: RunHistoryEntry[]; markdown: string } {
  const file = join(d.root, '.qa-memory', 'history.jsonl');
  mkdirSync(join(d.root, '.qa-memory'), { recursive: true });
  const all = existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => RunHistoryEntry.parse(JSON.parse(l)))
    : [];
  const entry: RunHistoryEntry = {
    runId: d.runId,
    storyKey: d.summary.storyKey,
    orgAlias: d.summary.orgAlias,
    environment: d.summary.environment,
    browser: d.summary.browser,
    at: d.summary.finishedAt,
    results: d.results
      .filter((r) => executedIds(d).has(r.caseId ?? ''))
      .map((r) => ({ caseId: r.caseId ?? r.testId, state: r.state })),
  };
  const kept = [...all.filter((e) => e.runId !== d.runId), entry];
  writeFileSync(file, `${kept.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const story = kept.filter((e) => e.storyKey === d.summary.storyKey).slice(-10);
  const cases = [...new Set(story.flatMap((e) => e.results.map((r) => r.caseId)))].sort();
  const L: string[] = [`# Execution history — ${d.summary.storyKey} (last ${String(story.length)} runs)`, ''];
  L.push(`| Case | ${story.map((e) => `${e.runId} (${e.environment}, ${e.browser})`).join(' | ')} |`);
  L.push(`|---|${story.map(() => '---').join('|')}|`);
  for (const c of cases)
    L.push(`| ${c} | ${story.map((e) => e.results.find((r) => r.caseId === c)?.state ?? '·').join(' | ')} |`);
  L.push('', 'FIXTURE / MOCK columns are offline results, never Salesforce results.');
  return { entries: kept, markdown: `${L.join('\n')}\n` };
}

/** Write every Phase 5 report of a run. Returns the files written. */
export async function writeExecutionReports(d: ReportData): Promise<string[]> {
  const dir = join(d.runDir, 'report');
  mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  const put = (name: string, text: string): void => {
    writeFileSync(join(dir, name), text, 'utf8');
    out.push(join(dir, name));
  };
  const rc = releaseConfidence(d);
  put('execution-report.md', renderExecutionReport(d));
  put('execution-report.html', renderExecutionHtml(d));
  put('release-confidence.md', renderReleaseConfidence(d, rc));
  put('release-confidence.json', `${JSON.stringify(rc, null, 2)}\n`);
  put('cleanup-reconciliation.md', renderCleanup(d));
  put('impact-coverage.md', renderImpactCoverage(d));
  await writeRtmResultsXlsx(d, join(dir, 'rtm-results.xlsx'));
  out.push(join(dir, 'rtm-results.xlsx'));
  put('history.md', updateHistory(d).markdown);
  put('model-attempts.json', `${JSON.stringify(d.failedAttempts, null, 2)}\n`);
  const design = d.manifest?.designRun ? `../../${d.manifest.designRun}/design` : undefined;
  const env: Environment = d.summary.environment;
  put(
    'index.md',
    [
      `# Reports — ${d.summary.storyKey} · ${d.runId} (${environmentLabel(env)})`,
      '',
      `Verdict: **${rc.verdict}** — ${rc.why}`,
      '',
      '- Playwright HTML: [../playwright-report/index.html](../playwright-report/index.html)',
      '- reporting-labs: [../reporting-labs/](../reporting-labs/)',
      '- Execution report: [execution-report.md](execution-report.md) · [html](execution-report.html)',
      '- Release confidence: [release-confidence.md](release-confidence.md)',
      '- Cleanup / reconciliation: [cleanup-reconciliation.md](cleanup-reconciliation.md)',
      '- Impact & coverage: [impact-coverage.md](impact-coverage.md) · [rtm-results.xlsx](rtm-results.xlsx)',
      '- Execution history: [history.md](history.md)',
      `- Model attempts that failed: [model-attempts.json](model-attempts.json) (${String(d.failedAttempts.length)})`,
      ...(design
        ? [
            `- Test plan / cases / RTM (design \`${d.manifest?.designRun ?? ''}\`): [test-plan.md](${design}/test-plan.md) · [test-cases.md](${design}/test-cases.md) · [rtm.xlsx](${design}/rtm.xlsx)`,
          ]
        : []),
      '',
      'Visual QA runs separately (`qa visual run`): its visual-diff report is in that run folder (`report/visual-diff.html`). Not produced yet: exploration and defect reports (Phase 7).',
      '',
    ].join('\n'),
  );
  return out;
}
