import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import type { EvidenceLevel, TestCase } from '../core/schemas/index.js';
import type { QAGraphStateType } from './state.js';

/**
 * Phase 3 design outputs (`runs/<runId>/design/`, reporting skill): charter, test plan, test cases, RTM (JSON + XLSX),
 * risks, obligations, Reviewer pass-1 findings and an HTML test-design report. MOCK, mechanical and FIXTURE inputs are
 * labelled in every human-readable file.
 */

const LEVELS: EvidenceLevel[] = [
  'APPROVED_REQUIREMENT',
  'DECLARED_CONFIG',
  'VERIFIED',
  'OBSERVED_ONLY',
  'UNKNOWN_OR_CONTRADICTORY',
];
const md = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface DesignSummary {
  acs: { ref: string; caseIds: string[]; covered: boolean }[];
  acCoverage: { covered: number; total: number };
  levels: Record<EvidenceLevel, number>;
  status: Record<TestCase['reviewStatus'], number>;
  findings: { total: number; open: number; resolved: number; justified: number; escalated: number };
  steps: number;
  unlabelled: number;
}

export function summarizeDesign(s: QAGraphStateType): DesignSummary {
  const acRefs = [...new Set(s.obligations.filter((o) => o.isAc).map((o) => o.ref))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  const acs = acRefs.map((ref) => {
    const obIds = s.obligations.filter((o) => o.isAc && o.ref === ref).map((o) => o.id);
    const caseIds = s.testCases.filter((c) => c.obligationIds.some((o) => obIds.includes(o))).map((c) => c.id);
    return { ref, caseIds, covered: caseIds.length > 0 };
  });
  const levels = Object.fromEntries(LEVELS.map((l) => [l, 0])) as Record<EvidenceLevel, number>;
  let steps = 0;
  let unlabelled = 0;
  for (const c of s.testCases) {
    for (const st of c.steps) {
      steps++;
      if (!LEVELS.includes(st.expected.evidenceLevel)) unlabelled++;
      else levels[st.expected.evidenceLevel]++;
    }
  }
  const status = { APPROVED: 0, REVIEW_REQUIRED: 0, BLOCKED: 0 };
  for (const c of s.testCases) status[c.reviewStatus]++;
  const f = s.reviewFindings;
  return {
    acs,
    acCoverage: { covered: acs.filter((a) => a.covered).length, total: acs.length },
    levels,
    status,
    findings: {
      total: f.length,
      open: f.filter((x) => x.status === 'OPEN').length,
      resolved: f.filter((x) => x.status === 'RESOLVED').length,
      justified: f.filter((x) => x.status === 'JUSTIFIED').length,
      escalated: f.filter((x) => x.escalated).length,
    },
    steps,
    unlabelled,
  };
}

function banners(s: QAGraphStateType): string[] {
  const out: string[] = [];
  if (s.designEnvironment === 'MOCK')
    out.push('**MOCK** — cases were drafted/reviewed by the mock model provider. Not real planning output.');
  if (s.designEnvironment === 'NONE')
    out.push(
      '**Mechanical** — no model answered; cases were built from the coverage obligations with verbatim evidence.',
    );
  if (s.orgEnvironment === 'FIXTURE')
    out.push('**FIXTURE** — org facts come from the offline Salesforce fixture, not a real org.');
  if (s.orgEnvironment === 'NONE')
    out.push('**No org snapshot** — expectations could not be checked against org configuration.');
  return out;
}

export function renderTestPlan(s: QAGraphStateType, status: string): string {
  const sum = summarizeDesign(s);
  const c = s.charter;
  const out: string[] = [`# Test plan — ${s.storyKey ?? s.runId}`, ''];
  out.push(
    `Run \`${s.runId}\` · status **${status}** · snapshot \`${c?.snapshotId ?? '—'}\` (${s.orgEnvironment}) · planner/reviewer models: ${s.designModels.join(', ') || 'none (mechanical)'}`,
  );
  for (const b of banners(s)) out.push('', `> ${b}`);
  out.push('', '## Exit criteria (Phase 3)', '');
  out.push(
    `- AC coverage: **${String(sum.acCoverage.covered)}/${String(sum.acCoverage.total)}** acceptance criteria have at least one case`,
  );
  out.push(
    `- Evidence labels: **${String(sum.steps - sum.unlabelled)}/${String(sum.steps)}** expectations carry an evidence level`,
  );
  out.push(
    `- Reviewer findings: **${String(sum.findings.open)} open** · ${String(sum.findings.resolved)} resolved · ${String(sum.findings.justified)} justified (${String(sum.findings.escalated)} escalated to a human)`,
  );
  if (c) {
    out.push('', '## Charter', '', `**Mission.** ${c.mission}`, '');
    out.push(`**Scope.** ${c.scope.join(', ') || '—'}`, '', `**Out of scope.** ${c.outOfScope.join('; ') || '—'}`, '');
    out.push('**Personas.**', '');
    for (const p of c.personas)
      out.push(
        `- \`${p.id}\` — ${p.available ? 'test user available' : '**no test user**'}${p.note ? ` (${p.note})` : ''}`,
      );
    out.push(
      '',
      `**Test types.** ${c.testTypes.join(', ')}`,
      '',
      '**Exit criteria.**',
      '',
      ...c.exitCriteria.map((e) => `- ${e}`),
    );
  }
  out.push(
    '',
    '## Risks',
    '',
    '| Risk | Tier | Likelihood | Impact | Score | Requirement | Drivers (evidence) |',
    '|---|---|---|---|---|---|---|',
  );
  for (const r of [...s.risks].sort((a, b) => b.score - a.score)) {
    out.push(
      `| ${r.id} | ${r.tier} | ${String(r.likelihood)} | ${r.impact} | ${String(r.score)} | ${r.requirementIds.join(', ')} | ${md(r.drivers.map((d) => d.text).join('; ') || '—')} |`,
    );
  }
  out.push('', '## Acceptance criteria coverage', '', '| AC | Covered | Cases |', '|---|---|---|');
  for (const a of sum.acs) out.push(`| ${a.ref} | ${a.covered ? 'yes' : '**NO**'} | ${a.caseIds.join(', ') || '—'} |`);
  out.push(
    '',
    '## Requirements traceability',
    '',
    '| Requirement | Refs | Status | Obligations covered | Cases | Types | Manual tests | Risks |',
    '|---|---|---|---|---|---|---|---|',
  );
  for (const r of s.rtm) {
    out.push(
      `| ${r.requirementId} | ${r.refs.join(', ')} | ${r.status} | ${r.coverage ? `${String(r.coverage.covered)}/${String(r.coverage.total)}` : '—'} | ${r.testCaseIds.join(', ') || '—'} | ${r.types.join(', ')} | ${r.manualTestIds.join(', ') || '—'} | ${r.riskIds.join(', ')} |`,
    );
  }
  out.push('', '## Expectations by evidence level', '', '| Level | Steps | May become an assertion |', '|---|---|---|');
  for (const l of LEVELS)
    out.push(
      `| ${l} | ${String(sum.levels[l])} | ${['APPROVED_REQUIREMENT', 'DECLARED_CONFIG', 'VERIFIED'].includes(l) ? 'yes' : 'no (review)'} |`,
    );
  out.push(
    '',
    `Cases: ${String(sum.status.APPROVED)} APPROVED · ${String(sum.status.REVIEW_REQUIRED)} REVIEW_REQUIRED · ${String(sum.status.BLOCKED)} BLOCKED. Only APPROVED cases go on to generation (Phase 4).`,
  );
  out.push(
    '',
    '## Test Reviewer — pass 1',
    '',
    '| Finding | Round | Sev | Rule | Origin | Status | Cases | Text | Resolution |',
    '|---|---|---|---|---|---|---|---|---|',
  );
  for (const f of s.reviewFindings) {
    out.push(
      `| ${f.id} | ${String(f.round)} | ${f.severity} | ${f.rule} | ${f.origin} | ${f.status}${f.escalated ? ' (escalated)' : ''} | ${f.caseIds.join(', ') || '—'} | ${md(f.text)} | ${md(f.resolution ?? '—')} |`,
    );
  }
  if (!s.reviewFindings.length) out.push('| — | | | | | | | no findings | |');
  const unassert = s.testCases.filter((t) => t.reviewStatus !== 'APPROVED');
  if (unassert.length) {
    out.push('', '## Not approved — why', '');
    for (const t of unassert)
      out.push(`- **${t.id}** (${t.reviewStatus}) ${md(t.title)} — ${md(t.reviewReasons.join('; '))}`);
  }
  return out.join('\n') + '\n';
}

export function renderTestCases(s: QAGraphStateType): string {
  const out: string[] = [`# Test cases — ${s.storyKey ?? s.runId}`, ''];
  for (const b of banners(s)) out.push(`> ${b}`, '');
  for (const c of s.testCases) {
    out.push(`## ${c.id} — ${c.title}`, '');
    out.push(
      `- **Status:** ${c.reviewStatus}${c.reviewReasons.length ? ` — ${c.reviewReasons.join('; ')}` : ''}`,
      `- **Requirements:** ${c.requirementIds.join(', ')} · refs ${c.refs.join(', ') || '—'} · obligations ${c.obligationIds.join(', ')}`,
      `- **Type / technique:** ${c.type} / ${c.technique} · **priority** ${c.priority} · severity (provisional) ${c.severity} · tier ${c.regressionTier}`,
      `- **Persona:** ${c.persona} · **origin** ${c.origin}${c.manualTestId ? ` (reuses ${c.manualTestId})` : ''}${c.dataRecipe ? ` · recipe ${c.dataRecipe}` : ''}`,
      `- **Risks:** ${c.riskIds.join(', ') || '—'} · tags ${c.tags.join(' ')}`,
    );
    if (c.preconditions.length) out.push(`- **Preconditions:** ${c.preconditions.join('; ')}`);
    out.push('', '| # | Action | Expected | Evidence level | Evidence |', '|---|---|---|---|---|');
    c.steps.forEach((st, i) =>
      out.push(
        `| ${String(i + 1)} | ${md(st.action)} | ${md(st.expected.text)} | ${st.expected.evidenceLevel} | ${st.expected.evidenceIds.join(', ') || '—'} |`,
      ),
    );
    out.push('');
  }
  return out.join('\n');
}

export function renderDesignHtml(s: QAGraphStateType, status: string): string {
  const sum = summarizeDesign(s);
  const bar = (n: number, total: number): string =>
    `<div class="bar"><span style="width:${String(total ? Math.round((n / total) * 100) : 0)}%"></span></div>`;
  const rows = (cells: string[][]): string =>
    cells.map((r) => `<tr>${r.map((x) => `<td>${x}</td>`).join('')}</tr>`).join('\n');
  const levelRows = LEVELS.map((l) => [esc(l), String(sum.levels[l]), bar(sum.levels[l], sum.steps)]);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Test design — ${esc(s.storyKey ?? s.runId)}</title>
<style>
body{font-family:Segoe UI,system-ui,sans-serif;margin:2rem;color:#1b1b1b;max-width:1200px}
h1{font-size:1.5rem}h2{font-size:1.15rem;margin-top:2rem;border-bottom:1px solid #ddd;padding-bottom:.25rem}
table{border-collapse:collapse;width:100%;font-size:.85rem}td,th{border:1px solid #ddd;padding:.3rem .45rem;vertical-align:top;text-align:left}
th{background:#f4f4f4}.banner{background:#fff4ce;border:1px solid #e0c060;padding:.5rem .75rem;margin:.5rem 0}
.kpis{display:flex;gap:1rem;flex-wrap:wrap}.kpi{border:1px solid #ddd;border-radius:6px;padding:.6rem 1rem;min-width:180px}
.kpi b{display:block;font-size:1.4rem}.bar{background:#eee;height:.6rem;width:160px}.bar span{display:block;height:100%;background:#4a6fa5}
.ok{color:#1f7a3a}.bad{color:#b3261e}
</style></head><body>
<h1>Test design — ${esc(s.storyKey ?? s.runId)}</h1>
<p>Run <code>${esc(s.runId)}</code> · status <b>${esc(status)}</b> · snapshot <code>${esc(s.charter?.snapshotId ?? '—')}</code> (${esc(s.orgEnvironment)}) · models: ${esc(s.designModels.join(', ') || 'none (mechanical)')}</p>
${banners(s)
  .map((b) => `<div class="banner">${esc(b.replace(/\*\*/g, ''))}</div>`)
  .join('\n')}
<div class="kpis">
<div class="kpi">AC coverage<b class="${sum.acCoverage.covered === sum.acCoverage.total ? 'ok' : 'bad'}">${String(sum.acCoverage.covered)}/${String(sum.acCoverage.total)}</b></div>
<div class="kpi">Evidence-labelled steps<b class="${sum.unlabelled ? 'bad' : 'ok'}">${String(sum.steps - sum.unlabelled)}/${String(sum.steps)}</b></div>
<div class="kpi">Reviewer findings open<b class="${sum.findings.open ? 'bad' : 'ok'}">${String(sum.findings.open)}</b>${String(sum.findings.resolved)} resolved · ${String(sum.findings.justified)} justified</div>
<div class="kpi">Cases<b>${String(s.testCases.length)}</b>${String(sum.status.APPROVED)} approved · ${String(sum.status.REVIEW_REQUIRED)} review · ${String(sum.status.BLOCKED)} blocked</div>
</div>
<h2>Acceptance criteria</h2>
<table><tr><th>AC</th><th>Covered</th><th>Cases</th></tr>${rows(sum.acs.map((a) => [esc(a.ref), a.covered ? '<span class="ok">yes</span>' : '<span class="bad">NO</span>', esc(a.caseIds.join(', '))]))}</table>
<h2>Risk tiers</h2>
<table><tr><th>Risk</th><th>Tier</th><th>Score</th><th>Impact</th><th>Requirement</th><th>Drivers</th></tr>${rows(
    [...s.risks]
      .sort((a, b) => b.score - a.score)
      .map((r) => [
        esc(r.id),
        esc(r.tier),
        String(r.score),
        esc(r.impact),
        esc(r.requirementIds.join(', ')),
        esc(r.drivers.map((d) => d.text).join('; ') || '—'),
      ]),
  )}</table>
<h2>Evidence levels of expectations</h2>
<table><tr><th>Level</th><th>Steps</th><th></th></tr>${rows(levelRows)}</table>
<h2>Traceability</h2>
<table><tr><th>Requirement</th><th>Refs</th><th>Status</th><th>Obligations</th><th>Cases</th><th>Manual tests</th></tr>${rows(
    s.rtm.map((r) => [
      esc(r.requirementId),
      esc(r.refs.join(', ')),
      esc(r.status),
      r.coverage ? `${String(r.coverage.covered)}/${String(r.coverage.total)}` : '—',
      esc(r.testCaseIds.join(', ')),
      esc(r.manualTestIds.join(', ') || '—'),
    ]),
  )}</table>
<h2>Reviewer pass 1</h2>
<table><tr><th>Finding</th><th>Sev</th><th>Rule</th><th>Origin</th><th>Status</th><th>Text</th><th>Resolution</th></tr>${rows(
    s.reviewFindings.map((f) => [
      esc(f.id),
      esc(f.severity),
      esc(f.rule),
      esc(f.origin),
      esc(f.status + (f.escalated ? ' (escalated)' : '')),
      esc(f.text),
      esc(f.resolution ?? '—'),
    ]),
  )}</table>
<h2>Test cases</h2>
<table><tr><th>Case</th><th>Status</th><th>Type</th><th>Priority</th><th>Persona</th><th>Title</th><th>Steps (expected · level)</th></tr>${rows(
    s.testCases.map((c) => [
      esc(c.id),
      esc(c.reviewStatus),
      esc(c.type),
      esc(c.priority),
      esc(c.persona),
      esc(c.title),
      c.steps
        .map(
          (st, i) =>
            `${String(i + 1)}. ${esc(st.action)} → ${esc(st.expected.text)} <i>[${esc(st.expected.evidenceLevel)}]</i>`,
        )
        .join('<br>'),
    ]),
  )}</table>
</body></html>
`;
}

export async function writeRtmXlsx(s: QAGraphStateType, file: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'sf-qa-agent';
  const label = [
    s.designEnvironment === 'MOCK' ? 'MOCK' : '',
    s.designEnvironment === 'NONE' ? 'MECHANICAL' : '',
    s.orgEnvironment === 'FIXTURE' ? 'FIXTURE' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const sheet = (
    name: string,
    columns: { header: string; key: string; width: number }[],
    data: Record<string, unknown>[],
  ): void => {
    const ws = wb.addWorksheet(name);
    ws.columns = columns;
    ws.getRow(1).font = { bold: true };
    for (const d of data) ws.addRow(d);
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };
  sheet(
    'RTM',
    [
      { header: 'Requirement', key: 'req', width: 14 },
      { header: 'Refs', key: 'refs', width: 16 },
      { header: 'Status', key: 'status', width: 16 },
      { header: 'Obligations covered', key: 'cov', width: 12 },
      { header: 'Test cases', key: 'cases', width: 40 },
      { header: 'Types', key: 'types', width: 24 },
      { header: 'Manual tests', key: 'manual', width: 18 },
      { header: 'Risks', key: 'risks', width: 12 },
      { header: 'Label', key: 'label', width: 14 },
    ],
    s.rtm.map((r) => ({
      req: r.requirementId,
      refs: r.refs.join(', '),
      status: r.status,
      cov: r.coverage ? `${String(r.coverage.covered)}/${String(r.coverage.total)}` : '',
      cases: r.testCaseIds.join(', '),
      types: r.types.join(', '),
      manual: r.manualTestIds.join(', '),
      risks: r.riskIds.join(', '),
      label,
    })),
  );
  sheet(
    'Test Cases',
    [
      { header: 'Case', key: 'id', width: 16 },
      { header: 'Title', key: 'title', width: 50 },
      { header: 'Status', key: 'status', width: 16 },
      { header: 'Reasons', key: 'reasons', width: 50 },
      { header: 'Requirements', key: 'reqs', width: 24 },
      { header: 'Type', key: 'type', width: 12 },
      { header: 'Priority', key: 'priority', width: 8 },
      { header: 'Persona', key: 'persona', width: 14 },
      { header: 'Origin', key: 'origin', width: 14 },
      { header: 'Steps', key: 'steps', width: 80 },
      { header: 'Evidence levels', key: 'levels', width: 30 },
    ],
    s.testCases.map((c) => ({
      id: c.id,
      title: c.title,
      status: c.reviewStatus,
      reasons: c.reviewReasons.join('; '),
      reqs: c.requirementIds.join(', '),
      type: c.type,
      priority: c.priority,
      persona: c.persona,
      origin: c.manualTestId ? `${c.origin} (${c.manualTestId})` : c.origin,
      steps: c.steps
        .map((st, i) => `${String(i + 1)}. ${st.action} → ${st.expected.text} [${st.expected.evidenceIds.join(', ')}]`)
        .join('\n'),
      levels: c.steps.map((st) => st.expected.evidenceLevel).join(', '),
    })),
  );
  sheet(
    'Risks',
    [
      { header: 'Risk', key: 'id', width: 10 },
      { header: 'Tier', key: 'tier', width: 12 },
      { header: 'Score', key: 'score', width: 8 },
      { header: 'Likelihood', key: 'l', width: 10 },
      { header: 'Impact', key: 'i', width: 8 },
      { header: 'Requirement', key: 'req', width: 14 },
      { header: 'Drivers', key: 'drivers', width: 80 },
    ],
    s.risks.map((r) => ({
      id: r.id,
      tier: r.tier,
      score: r.score,
      l: r.likelihood,
      i: r.impact,
      req: r.requirementIds.join(', '),
      drivers: r.drivers.map((d) => d.text).join('\n'),
    })),
  );
  sheet(
    'Review Findings',
    [
      { header: 'Finding', key: 'id', width: 10 },
      { header: 'Round', key: 'round', width: 7 },
      { header: 'Severity', key: 'sev', width: 8 },
      { header: 'Rule', key: 'rule', width: 22 },
      { header: 'Origin', key: 'origin', width: 14 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Cases', key: 'cases', width: 24 },
      { header: 'Text', key: 'text', width: 70 },
      { header: 'Resolution', key: 'res', width: 70 },
    ],
    s.reviewFindings.map((f) => ({
      id: f.id,
      round: f.round,
      sev: f.severity,
      rule: f.rule,
      origin: f.origin,
      status: f.status + (f.escalated ? ' (escalated)' : ''),
      cases: f.caseIds.join(', '),
      text: f.text,
      res: f.resolution ?? '',
    })),
  );
  await wb.xlsx.writeFile(file);
}

export async function writeDesignReport(s: QAGraphStateType, runDir: string, status: string): Promise<string[]> {
  const dir = join(runDir, 'design');
  await mkdir(dir, { recursive: true });
  const out: string[] = [];
  const json = async (name: string, data: unknown): Promise<void> => {
    const f = join(dir, name);
    await writeFile(f, JSON.stringify(data, null, 2));
    out.push(f);
  };
  const sum = summarizeDesign(s);
  await json('charter.json', s.charter ?? null);
  await json('risks.json', s.risks);
  await json('obligations.json', s.obligations);
  await json('test-cases.json', s.testCases);
  await json('rtm.json', s.rtm);
  await json('review-pass1.json', s.reviewFindings);
  await json('impact.json', s.impact ?? null);
  await json(
    'evidence.json',
    s.evidence.filter((e) => e.agent === 'test-planner' || e.agent === 'test-reviewer'),
  );
  await json('design-run.json', {
    runId: s.runId,
    storyKey: s.storyKey,
    status,
    designEnvironment: s.designEnvironment,
    orgEnvironment: s.orgEnvironment,
    models: s.designModels,
    snapshotId: s.charter?.snapshotId,
    reviewRounds: s.reviewRound,
    summary: sum,
  });
  const write = async (name: string, text: string): Promise<void> => {
    const f = join(dir, name);
    await writeFile(f, text);
    out.push(f);
  };
  await write('test-plan.md', renderTestPlan(s, status));
  await write('test-cases.md', renderTestCases(s));
  await write('test-design-report.html', renderDesignHtml(s, status));
  const charterMd = s.charter
    ? [
        `# Test charter — ${s.storyKey ?? s.runId}`,
        '',
        ...banners(s).map((b) => `> ${b}\n`),
        `**Mission.** ${s.charter.mission}`,
        '',
        `**Scope.** ${s.charter.scope.join(', ')}`,
        '',
        `**Out of scope.** ${s.charter.outOfScope.join('; ') || '—'}`,
        '',
        '**Personas.**',
        ...s.charter.personas.map(
          (p) => `- ${p.id}: ${p.available ? 'available' : 'no test user'}${p.note ? ` — ${p.note}` : ''}`,
        ),
        '',
        '**Risks.**',
        ...s.charter.risks.map((r) => `- ${r}`),
        '',
        `**Test types.** ${s.charter.testTypes.join(', ')}`,
        '',
        '**Exit criteria.**',
        ...s.charter.exitCriteria.map((e) => `- ${e}`),
        '',
      ].join('\n')
    : '# Test charter\n\nNo charter (no test design in this run).\n';
  await write('charter.md', charterMd);
  const xlsx = join(dir, 'rtm.xlsx');
  await writeRtmXlsx(s, xlsx);
  out.push(xlsx);
  return out;
}
