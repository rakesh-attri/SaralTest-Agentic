import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { QAGraphStateType } from './state.js';

/**
 * Phase 1 run output (`runs/<runId>/analysis/`): machine-readable JSON for later phases and a Markdown report for the
 * operator. The Reporter agent (Phase 5) builds the full report set on top of these files.
 */

const md = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function finalStatus(s: QAGraphStateType): QAGraphStateType['status'] {
  if (s.status === 'BLOCKED') return 'BLOCKED';
  if (!s.requirements.length) return 'PARTIAL';
  const unfinished = s.issues.some(
    (i) =>
      i.kind !== 'AMBIGUOUS_SPEC' && (i.resolution === 'DEGRADED' || i.resolution === 'ESCALATED' || !i.resolution),
  );
  return unfinished ? 'PARTIAL' : 'COMPLETE';
}

export function renderAnalysisReport(s: QAGraphStateType, status: QAGraphStateType['status']): string {
  const out: string[] = [];
  const env = s.analysisEnvironment;
  out.push(`# Requirement analysis — ${s.storyKey ?? s.sources[0]?.docId ?? s.runId}`);
  out.push('');
  out.push(
    `Run \`${s.runId}\` · status **${status}** · autonomy ${s.autonomy} · analysis model: ${s.analysisModels.join(', ') || 'none (mechanical)'}`,
  );
  if (env === 'MOCK') out.push('', '> **MOCK** — produced by the mock model provider. Not real analysis output.');
  if (env === 'NONE')
    out.push(
      '',
      '> **Mechanical** — no model answered; requirements were derived deterministically and all need review.',
    );
  out.push(
    '',
    s.orgContext
      ? `Org context: snapshot \`${s.orgContext.snapshotId}\` (${s.orgEnvironment}) — org: ${s.org}.`
      : 'Requirement analysis only: no Salesforce org was contacted for this analysis.',
  );

  out.push('', '## Inputs', '');
  for (const d of s.sources) {
    out.push(
      `- **${d.docId}** (${d.source.type}${d.source.version ? `, version ${d.source.version}` : ''}) — ${md(d.title)} — ${d.sections.length} sections — sha256 \`${d.source.hash.slice(0, 12)}\``,
    );
    for (const w of d.warnings) out.push(`  - warning: ${w}`);
  }
  if (s.existingTests.length) out.push(`- ${s.existingTests.length} existing manual test cases imported`);
  for (const n of s.notes) out.push(`- note: ${n}`);

  const exec = s.requirements.filter((r) => r.status === 'EXECUTABLE').length;
  out.push(
    '',
    `## Requirements (${s.requirements.length}: ${exec} executable, ${s.requirements.length - exec} review required)`,
    '',
  );
  out.push(
    '| ID | Status | Type | Risk | Sources | Requirement | Expected | Review reasons |',
    '|---|---|---|---|---|---|---|---|',
  );
  for (const r of s.requirements) {
    out.push(
      `| ${r.id} | ${r.status} | ${r.type} | ${r.risk} | ${r.sources.map((x) => x.section ?? x.ref).join(', ')} | ${md(r.title ?? r.businessObjective)} | ${md(r.expectedOutcomes.join('; ') || '—')} | ${md(r.reviewReasons.join('; ') || '—')} |`,
    );
  }

  out.push('', `## Clarification questions (${s.clarifications.length})`, '');
  for (const c of s.clarifications) {
    out.push(`### ${c.id} [${c.status}] (round ${c.round}${c.refs.length ? `; ${c.refs.join(', ')}` : ''})`);
    out.push('', c.question);
    if (c.testImpact) out.push('', `- Test impact: ${c.testImpact}`);
    if (c.requirementIds.length) out.push(`- Requirements: ${c.requirementIds.join(', ')}`);
    if (c.answer) out.push(`- **Answer:** ${c.answer}`);
    if (c.status === 'ASSUMED') out.push(`- **Assumed (unconfirmed):** ${c.assumption ?? c.proposedAssumption ?? ''}`);
    else if (c.status === 'OPEN' && c.proposedAssumption)
      out.push(`- Proposed assumption if unanswered: ${c.proposedAssumption}`);
    out.push('');
  }

  const kinds = [...new Set(s.findings.map((f) => f.kind))];
  out.push(`## Findings (${s.findings.length})`, '');
  for (const k of kinds) {
    out.push(`### ${k}`, '');
    for (const f of s.findings.filter((x) => x.kind === k)) {
      out.push(
        `- **${f.id}** [${f.severity}; ${f.origin}${f.rule ? `:${f.rule}` : ''}] (${f.refs.join(', ')}) ${f.text}${f.requirementIds.length ? ` — affects ${f.requirementIds.join(', ')}` : ''}`,
      );
    }
    out.push('');
  }

  if (s.existingTests.length) {
    out.push(
      '## Coverage by existing manual tests',
      '',
      '| Requirement | Sections | Existing tests |',
      '|---|---|---|',
    );
    for (const c of s.coverage)
      out.push(`| ${c.requirementId} | ${c.sections.join(', ')} | ${c.coveredBy.join(', ') || '**none**'} |`);
    out.push('');
  }

  out.push(`## Issues and QA Lead triage (${s.issues.length})`, '');
  if (!s.issues.length) out.push('None.');
  for (const i of s.issues) {
    const t = s.triageLog.filter((d) => d.issueId === i.id);
    out.push(
      `- **${i.id}** ${i.kind} at \`${i.node}\`: ${md(i.message)} → ${i.resolution ?? 'unresolved'}${t.length ? ` (${t.map((d) => `${d.response}: ${d.reason}`).join(' | ')})` : ''}`,
    );
  }
  out.push('');
  return out.join('\n');
}

export async function writeAnalysisReport(
  s: QAGraphStateType,
  runDir: string,
  status: QAGraphStateType['status'],
): Promise<string[]> {
  const dir = join(runDir, 'analysis');
  await mkdir(join(dir, 'sources'), { recursive: true });
  const files: [string, unknown][] = [
    ['requirements.json', s.requirements],
    ['findings.json', s.findings],
    ['clarifications.json', s.clarifications],
    ['existing-tests.json', s.existingTests],
    ['coverage.json', s.coverage],
    ['issues.json', s.issues],
    ['triage.json', s.triageLog],
    ['evidence.json', s.evidence],
    [
      'run.json',
      {
        runId: s.runId,
        storyKey: s.storyKey,
        status,
        autonomy: s.autonomy,
        analysisEnvironment: s.analysisEnvironment,
        analysisModels: s.analysisModels,
        inputs: s.inputs,
        counts: {
          sources: s.sources.length,
          requirements: s.requirements.length,
          executable: s.requirements.filter((r) => r.status === 'EXECUTABLE').length,
          reviewRequired: s.requirements.filter((r) => r.status === 'REVIEW_REQUIRED').length,
          findings: s.findings.length,
          questions: s.clarifications.length,
          existingTests: s.existingTests.length,
          issues: s.issues.length,
        },
        budget: s.budget,
      },
    ],
  ];
  if (s.defectHistory.length) files.push(['defect-history.json', s.defectHistory]);
  if (s.changedComponents.length) files.push(['changed-components.json', s.changedComponents]);
  if (s.objectives.length) files.push(['objectives.json', s.objectives]);
  const written: string[] = [];
  for (const [name, value] of files) {
    const p = join(dir, name);
    await writeFile(p, `${JSON.stringify(value, null, 2)}\n`);
    written.push(p);
  }
  for (const d of s.sources) {
    const p = join(dir, 'sources', `${d.docId.replace(/[^A-Za-z0-9._-]+/g, '-')}.json`);
    await writeFile(p, `${JSON.stringify(d, null, 2)}\n`);
    written.push(p);
  }
  const report = join(dir, 'analysis-report.md');
  await writeFile(report, renderAnalysisReport(s, status));
  written.push(report);
  return written;
}
