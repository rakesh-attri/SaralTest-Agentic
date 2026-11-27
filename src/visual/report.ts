// Visual-diff report (PLAN.md §7g / §10): `runs/<id>/report/visual-diff.{md,html}` — one row per region × viewport
// with baseline | actual | diff images, then layout findings and accessibility results. Every difference is a
// candidate for human review; the report never calls it a defect. FIXTURE runs carry the non-Salesforce banner.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VisualCandidate, VisualRunSummary } from '../core/schemas/visual.js';
import { environmentBanner, environmentLabel, esc, md } from '../report/format.js';
import type { ReconcileReport } from '../runner/reconcile.js';

const NEXT: Record<VisualCandidate['status'], string> = {
  MATCH: 'none',
  NO_BASELINE: 'review the actual image; approve it as the first baseline',
  DIFF: 'compare baseline / actual / diff: intended change → approve; unintended → investigate (possible visual defect)',
  RE_APPROVE: 'the baseline is no longer trusted (release change or edited file): review and re-approve',
  NOT_CAPTURED: 'the region was not captured: fix the test failure, then re-run',
};

const img = (p?: string): string => (p ? `../${p}` : '');

export function renderVisualDiffMd(s: VisualRunSummary, rec?: ReconcileReport): string {
  const L: string[] = [];
  L.push(`# Visual-diff report — ${s.runId}`, '');
  const banner = environmentBanner(s.environment);
  if (banner) L.push(banner, '');
  L.push(
    `- Environment: **${environmentLabel(s.environment)}** · org ${s.org} (${s.orgId}) · release ${s.release}`,
    `- Persona ${s.persona} · viewports ${s.viewports.join(', ')} · browser ${s.browser} · ${s.createdAt}`,
    `- Screenshots: **${s.counts.match} MATCH · ${s.counts.candidates} candidate(s)** · layout findings ${s.counts.layout} (FAIL ${s.counts.layoutFail} · new Salesforce-owned ${s.counts.layoutNewStandard}) · a11y FAIL ${s.counts.a11yFail} · new Salesforce-owned a11y rules ${s.counts.a11yNewStandard}`,
    `- Test data: ${rec?.status ?? 'NONE'}${rec ? ` (${rec.subRuns.length} sub-run(s), ${rec.remaining.length} remaining)` : ''}`,
    '- A candidate is not a defect: a human decides (checkpoint `approve-visual-baseline`). Images were not sent to any model.',
    '',
    '## Screenshots',
    '',
    '| Status | Region | Viewport | Diff | Reason | Next step |',
    '|---|---|---|---|---|---|',
  );
  for (const c of s.candidates) {
    const diff =
      c.diffPixelRatio !== undefined
        ? `${(c.diffPixelRatio * 100).toFixed(2)} % (max ${(c.maxDiffPixelRatio * 100).toFixed(2)} %)`
        : '-';
    L.push(`| ${c.status} | ${c.region} | ${c.viewport} | ${diff} | ${md(c.reason)} | ${md(NEXT[c.status])} |`);
  }
  const shown = s.candidates.filter((c) => c.status !== 'MATCH');
  if (shown.length) {
    L.push('', '## Candidates', '');
    for (const c of shown) {
      L.push(`### ${c.name} — ${c.status}`, '', c.reason, '');
      L.push('| Baseline | Actual | Diff |', '|---|---|---|');
      const cell = (p?: string, alt = ''): string => (p ? `![${alt}](${img(p)})` : '—');
      L.push(
        `| ${cell(c.images.baseline, 'baseline')} | ${cell(c.images.actual, 'actual')} | ${cell(c.images.diff, 'diff')} |`,
        '',
      );
    }
  }
  L.push('', '## Layout checks (local, deterministic)', '');
  if (!s.layout.length)
    L.push(
      'No layout findings (overlap, clipped text, off-screen, hidden required controls, layout shift, blank / loading / error state).',
    );
  else {
    L.push('| Status | Owner | Region | Viewport | Kind | Detail |', '|---|---|---|---|---|---|');
    for (const f of s.layout)
      L.push(`| ${f.status ?? '-'} | ${f.owner} | ${f.region} | ${f.viewport} | ${f.kind} | ${md(f.detail)} |`);
  }
  L.push('', '## Accessibility', '');
  if (s.a11yChecks.length) {
    L.push('| Region | Viewport | Tab order | Missing from Tab order | Unnamed controls |', '|---|---|---|---|---|');
    for (const k of s.a11yChecks) {
      L.push(
        `| ${k.region} | ${k.viewport} | ${k.tabOrderInOrder === null ? '-' : k.tabOrderInOrder ? 'OK' : '**FAIL**'} | ${md(k.missingFromTabOrder.join(', ') || '-')} | ${md(k.unnamedControls.join(', ') || '-')} |`,
      );
    }
    L.push('');
  }
  if (!s.a11y.length) L.push('No axe violations in the scanned regions.');
  else {
    L.push('| Status | Region | Viewport | Rule | Impact | Nodes | Help |', '|---|---|---|---|---|---|---|');
    for (const f of s.a11y)
      L.push(
        `| ${f.status} | ${f.region} | ${f.viewport} | ${f.ruleId} | ${f.impact ?? '-'} | ${String(f.targets)} | ${md(f.help)} |`,
      );
    L.push(
      '',
      'FAIL = our custom namespace (fails the test) · BASELINE = accepted Salesforce-owned · NEW_STANDARD = Salesforce-owned, not accepted yet (candidate).',
    );
  }
  if (s.tests.length) {
    L.push('', '## Suite tests', '', '| Test | State | Error |', '|---|---|---|');
    for (const t of s.tests) L.push(`| ${md(t.title)} | ${t.state} | ${md(t.error ?? '-')} |`);
  }
  if (s.counts.candidates) {
    L.push('', '## Approve', '', '```powershell', `pnpm qa visual approve --run ${s.runId} --by "<your name>"`, '```');
  }
  return `${L.join('\n')}\n`;
}

export function renderVisualDiffHtml(s: VisualRunSummary, rec?: ReconcileReport): string {
  const rows = s.candidates
    .map((c) => {
      const pic = (p?: string): string =>
        p ? `<a href="${esc(img(p))}"><img src="${esc(img(p))}" alt=""></a>` : '<span class="none">—</span>';
      const diff = c.diffPixelRatio !== undefined ? `${(c.diffPixelRatio * 100).toFixed(2)} %` : '';
      return `<tr class="s-${c.status}"><td><b>${c.status}</b><br>${esc(c.region)}<br>${esc(c.viewport)}<br>${esc(diff)}<p>${esc(c.reason)}</p><p class="next">${esc(NEXT[c.status])}</p></td><td>${pic(c.images.baseline)}</td><td>${pic(c.images.actual)}</td><td>${pic(c.images.diff)}</td></tr>`;
    })
    .join('\n');
  const layout = s.layout.length
    ? `<table><tr><th>Status</th><th>Owner</th><th>Region</th><th>Viewport</th><th>Kind</th><th>Detail</th></tr>${s.layout.map((f) => `<tr><td>${esc(f.status ?? '-')}</td><td>${esc(f.owner)}</td><td>${esc(f.region)}</td><td>${esc(f.viewport)}</td><td>${esc(f.kind)}</td><td>${esc(f.detail)}</td></tr>`).join('')}</table>`
    : '<p>No layout findings.</p>';
  const a11y = s.a11y.length
    ? `<table><tr><th>Status</th><th>Region</th><th>Viewport</th><th>Rule</th><th>Impact</th><th>Nodes</th><th>Help</th></tr>${s.a11y.map((f) => `<tr><td>${esc(f.status)}</td><td>${esc(f.region)}</td><td>${esc(f.viewport)}</td><td>${esc(f.ruleId)}</td><td>${esc(f.impact ?? '-')}</td><td>${String(f.targets)}</td><td>${esc(f.help)}</td></tr>`).join('')}</table>`
    : '<p>No axe violations in the scanned regions.</p>';
  const checks = s.a11yChecks
    .map(
      (k) =>
        `<tr><td>${esc(k.region)}</td><td>${esc(k.viewport)}</td><td>${k.tabOrderInOrder === null ? '-' : k.tabOrderInOrder ? 'OK' : '<b>FAIL</b>'}</td><td>${esc(k.missingFromTabOrder.join(', ') || '-')}</td><td>${esc(k.unnamedControls.join(', ') || '-')}</td></tr>`,
    )
    .join('');
  const banner =
    s.environment === 'LIVE'
      ? ''
      : `<p class="banner">${esc(environmentLabel(s.environment))}. Never report this as a real Salesforce result.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Visual-diff ${esc(s.runId)}</title><style>
body{font:14px system-ui,sans-serif;margin:24px;color:#181818}table{border-collapse:collapse;margin:8px 0 24px}td,th{border:1px solid #ccc;padding:6px;vertical-align:top;text-align:left}
img{max-width:420px;border:1px solid #999}.banner{background:#fde7c8;padding:8px;border:1px solid #c77}.s-MATCH td:first-child{background:#e6f4ea}.s-DIFF td:first-child,.s-NOT_CAPTURED td:first-child{background:#fde2e1}.s-NO_BASELINE td:first-child,.s-RE_APPROVE td:first-child{background:#fff4ce}.next{color:#555;font-size:12px}.none{color:#999}
</style></head><body>
<h1>Visual-diff report — ${esc(s.runId)}</h1>${banner}
<p>${esc(environmentLabel(s.environment))} · org ${esc(s.org)} (${esc(s.orgId)}) · release ${esc(s.release)} · persona ${esc(s.persona)} · viewports ${esc(s.viewports.join(', '))} · ${esc(s.browser)}</p>
<p><b>${String(s.counts.match)} MATCH · ${String(s.counts.candidates)} candidate(s)</b> · layout findings ${String(s.counts.layout)} (FAIL ${String(s.counts.layoutFail)} · new Salesforce-owned ${String(s.counts.layoutNewStandard)}) · a11y FAIL ${String(s.counts.a11yFail)} · new Salesforce-owned a11y rules ${String(s.counts.a11yNewStandard)} · test data ${esc(rec?.status ?? 'NONE')}</p>
<p>A candidate is not a defect: a human decides (checkpoint approve-visual-baseline). Images were not sent to any model.</p>
<h2>Screenshots</h2><table><tr><th>Status</th><th>Baseline</th><th>Actual</th><th>Diff</th></tr>${rows}</table>
<h2>Layout checks</h2>${layout}
<h2>Accessibility</h2>${checks ? `<table><tr><th>Region</th><th>Viewport</th><th>Tab order</th><th>Missing</th><th>Unnamed controls</th></tr>${checks}</table>` : ''}${a11y}
${s.counts.candidates ? `<h2>Approve</h2><pre>pnpm qa visual approve --run ${esc(s.runId)} --by "&lt;your name&gt;"</pre>` : ''}
</body></html>
`;
}

/** Write `report/visual-diff.{md,html}` into the run folder; returns the files. */
export function writeVisualReport(runDir: string, s: VisualRunSummary, rec?: ReconcileReport): string[] {
  const dir = join(runDir, 'report');
  mkdirSync(dir, { recursive: true });
  const mdFile = join(dir, 'visual-diff.md');
  const htmlFile = join(dir, 'visual-diff.html');
  writeFileSync(mdFile, renderVisualDiffMd(s, rec), 'utf8');
  writeFileSync(htmlFile, renderVisualDiffHtml(s, rec), 'utf8');
  const indexFile = join(dir, 'index.md');
  writeFileSync(
    indexFile,
    [
      `# Reports — visual run ${s.runId} (${environmentLabel(s.environment)})`,
      '',
      `${String(s.counts.match)} MATCH · ${String(s.counts.candidates)} candidate(s) · layout ${String(s.counts.layout)} · a11y FAIL ${String(s.counts.a11yFail)} · data ${rec?.status ?? 'NONE'}`,
      '',
      '- Visual-diff report: [visual-diff.md](visual-diff.md) · [html](visual-diff.html)',
      '- Playwright HTML: [../playwright-report/index.html](../playwright-report/index.html)',
      '- Summary (JSON): [../visual/visual-summary.json](../visual/visual-summary.json)',
      '- Data reconciliation: [../visual/data-reconciliation.json](../visual/data-reconciliation.json)',
      '',
    ].join('\n'),
    'utf8',
  );
  return [mdFile, htmlFile, indexFile];
}
