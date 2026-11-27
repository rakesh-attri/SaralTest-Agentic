// Exploration report (PLAN.md §10: "exploration report (HTML+JSON)"): charter, why this area, steps with the reason
// each action was chosen, state map, findings with their evidence, drafted cases and their review notes, coverage note.
import type { ExplorationReport } from '../../core/schemas/index.js';
import type { DraftCase } from './review.js';

const md = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

export function renderExplorationMd(r: ExplorationReport, drafts: readonly DraftCase[]): string {
  const L: string[] = [`# Exploration report — ${r.charter.id} (${r.runId})`, ''];
  if (r.environment !== 'LIVE')
    L.push(
      `> **${r.environment}** — explored on the ${r.environment === 'FIXTURE' ? 'offline fixture' : 'mock'}; not a Salesforce result.`,
      '',
    );
  L.push(`**Charter:** ${r.charter.mission}`, '', `**Why this area:** ${r.charter.reason}`, '');
  L.push(
    `**Limits:** ${String(r.charter.timeBoxMin)} min · ${String(r.charter.maxSteps)} steps · ${String(r.charter.maxSaves)} saves · saturation after ${String(r.charter.saturationSteps)} steps without a new state`,
    '',
  );
  L.push(`**Coverage:** ${r.coverageNote} · data cleanup **${r.dataCleanup}**`, '');
  L.push('## Findings', '');
  if (!r.findings.length) L.push('No finding.', '');
  for (const f of r.findings) {
    const d = drafts.find((x) => x.findingId === f.id);
    L.push(
      `### ${f.id} — ${f.kind} (${f.severity}, suggests ${f.suggestion})`,
      '',
      f.title,
      '',
      `- Observation: ${f.observation}`,
    );
    if (f.expected) L.push(`- Expected (org evidence ${f.expectedEvidence.join(', ')}): ${f.expected}`);
    L.push(`- Steps: ${f.steps.join(' → ') || '—'}`, `- Evidence: ${f.evidenceIds.join(', ')}`);
    if (d) {
      L.push(`- Draft case \`${d.testCase.id}\` (${d.testCase.reviewStatus}); review:`);
      for (const n of d.review) L.push(`  - ${n.blocking ? '**blocking**' : 'note'} ${n.rule}: ${n.text}`);
      if (!d.review.length) L.push('  - no review notes');
    }
    L.push(
      `- ${f.promoted ? `Promoted to ${f.testCaseId ?? '?'} by ${f.promoted.by} (${f.promoted.approvalId})` : `Not promoted. To promote after review: pnpm qa explore promote --run ${r.runId} --finding ${f.id} --by "<name>"`}`,
      '',
    );
  }
  L.push('## Steps', '', '| # | Action | New state | Chosen by | Reason | Observation |', '|---|---|---|---|---|---|');
  for (const s of r.steps)
    L.push(
      `| ${String(s.step)} | ${s.actionId} | ${s.newState ? 'yes' : ''} | ${s.chosenBy} | ${md(s.reason)} | ${md(s.observation)} |`,
    );
  L.push(
    '',
    `## State map`,
    '',
    `${String(r.states.length)} states, ${String(r.edges.length)} transitions; finished states: ${String(r.states.filter((s) => s.finished).length)}.`,
    '',
  );
  L.push('| State | Page | Dialog | Visits | Finished |', '|---|---|---|---|---|');
  for (const s of r.states)
    L.push(`| ${s.id} | ${s.page} | ${s.dialog ?? ''} | ${String(s.visits)} | ${s.finished ? 'yes' : ''} |`);
  L.push('', `Stopped by: **${r.stoppedBy}** · ${r.startedAt} → ${r.endedAt}`, '');
  return L.join('\n');
}

export function renderExplorationHtml(r: ExplorationReport, drafts: readonly DraftCase[]): string {
  const body = renderExplorationMd(r, drafts)
    .split('\n')
    .map((l) =>
      l.startsWith('# ')
        ? `<h1>${esc(l.slice(2))}</h1>`
        : l.startsWith('## ')
          ? `<h2>${esc(l.slice(3))}</h2>`
          : l.startsWith('### ')
            ? `<h3>${esc(l.slice(4))}</h3>`
            : l.startsWith('|')
              ? `<pre>${esc(l)}</pre>`
              : l
                ? `<p>${esc(l)}</p>`
                : '',
    )
    .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Exploration ${esc(r.runId)}</title><style>body{font-family:system-ui,sans-serif;max-width:1100px;margin:2rem auto}pre{margin:0;white-space:pre-wrap}</style></head><body>${r.environment !== 'LIVE' ? `<p style="background:#fde68a;padding:.5rem"><b>${esc(r.environment)}</b> — not a Salesforce result</p>` : ''}${body}</body></html>\n`;
}
