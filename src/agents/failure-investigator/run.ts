// `qa investigate --run <id>`: investigate every FAIL (and flaky UNCERTAIN) result of a finished run.
// Outputs (runs/<investigation run>/): investigation/investigations.json, investigation-report.md, evidence export.
// FIXTURE / MOCK runs are labelled on every line: a fixture verdict is never a statement about Salesforce.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { PolicyConfig } from '../../config/schemas.js';
import { QAError } from '../../core/errors.js';
import { TestResult, type Environment, type Investigation } from '../../core/schemas/index.js';
import { EvidenceLedger } from '../../knowledge/evidenceLedger.js';
import type { InvestigationProviders, RerunOutcome } from './experiments.js';
import { investigateFailure, type InvestigatorDeps } from './index.js';

export interface InvestigateRunOptions {
  root: string;
  /** Run whose failures are investigated. */
  sourceRun: string;
  /** Investigation run id (≤ 30 chars leaves room for rerun suffixes). */
  runId: string;
  cases?: readonly string[];
  policy: Pick<PolicyConfig, 'investigation'>;
  say: (m: string) => void;
  now?: () => Date;
}

export interface CaseInvestigation {
  investigation: Investigation;
  reruns: RerunOutcome[];
}

export interface InvestigateRunResult {
  environment: Environment;
  investigations: CaseInvestigation[];
  files: string[];
}

export const ledgerFile = (root: string): string => join(root, '.qa-memory', 'evidence.db');
export const investigationDir = (root: string, runId: string): string => join(root, 'runs', runId, 'investigation');

export function loadRunResults(root: string, runId: string): TestResult[] {
  const f = join(root, 'runs', runId, 'results.json');
  if (!existsSync(f)) throw new QAError('DATA', `no results.json in runs/${runId} (run it with qa run first)`);
  return z.array(TestResult).parse(JSON.parse(readFileSync(f, 'utf8')));
}

/** Results worth investigating: FAIL, and UNCERTAIN that passed only on retry. */
export const failuresOf = (results: readonly TestResult[], cases?: readonly string[]): TestResult[] =>
  results.filter(
    (r) =>
      (r.state === 'FAIL' || (r.state === 'UNCERTAIN' && r.flaky)) &&
      (!cases?.length || cases.includes(r.caseId ?? r.testId)),
  );

export async function investigateRun(
  o: InvestigateRunOptions,
  d: Omit<InvestigatorDeps, 'ledger'> & { providers: InvestigationProviders },
): Promise<InvestigateRunResult> {
  const results = loadRunResults(o.root, o.sourceRun);
  const failures = failuresOf(results, o.cases);
  const environment: Environment = results[0]?.environment ?? 'MOCK';
  const label = environment === 'LIVE' ? '' : ` [${environment} — not a Salesforce result]`;
  o.say(`Investigating ${failures.length} failure(s) of ${o.sourceRun}${label} …`);
  const ledger = new EvidenceLedger(ledgerFile(o.root));
  const out: CaseInvestigation[] = [];
  try {
    ledger.removeRun(o.runId);
    for (const r of failures) {
      o.say(`  ${r.caseId ?? r.testId}: ${r.reason?.split('\n')[0] ?? r.state}`);
      const res = await investigateFailure(
        r,
        {
          root: o.root,
          runId: o.runId,
          sourceRunDir: join(o.root, 'runs', o.sourceRun),
          environment,
          policy: o.policy,
          ...(o.now ? { now: o.now } : {}),
          say: o.say,
        },
        { ...d, ledger },
      );
      const i = res.investigation;
      o.say(
        `  → ${i.verdict} (${i.confidence.toFixed(2)}, ${i.rule ?? i.model ?? 'no rule'}) → ${i.route ?? 'qa-lead'}`,
      );
      out.push({ investigation: i, reruns: res.reruns });
    }
    const dir = investigationDir(o.root, o.runId);
    mkdirSync(dir, { recursive: true });
    const jsonFile = join(dir, 'investigations.json');
    writeFileSync(
      jsonFile,
      JSON.stringify(
        { sourceRun: o.sourceRun, runId: o.runId, environment, investigations: out.map((x) => x.investigation) },
        null,
        2,
      ) + '\n',
    );
    const mdFile = join(dir, 'investigation-report.md');
    writeFileSync(
      mdFile,
      renderInvestigationReport(
        o.sourceRun,
        o.runId,
        environment,
        out.map((x) => x.investigation),
      ),
    );
    const evFile = join(o.root, 'runs', o.runId, 'evidence', 'evidence.json');
    ledger.exportRun(o.runId, evFile);
    return { environment, investigations: out, files: [jsonFile, mdFile, evFile] };
  } finally {
    ledger.close();
  }
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderInvestigationReport(
  sourceRun: string,
  runId: string,
  env: Environment,
  xs: readonly Investigation[],
): string {
  const lines: string[] = [];
  lines.push(`# Investigation report — ${sourceRun}`, '');
  if (env !== 'LIVE')
    lines.push(
      `> **${env}** — results from the ${env === 'FIXTURE' ? 'offline fixture' : 'mock provider'}; not a Salesforce result.`,
      '',
    );
  lines.push(
    `Investigation run \`${runId}\`. Verdicts are SUSPECTED until the Defect Judge (product / permission) or a verified heal (script) confirms them.`,
    '',
  );
  if (!xs.length) {
    lines.push('No failures to investigate.', '');
    return lines.join('\n');
  }
  lines.push('| Case | Verdict | Confidence | Decided by | Next owner |', '|---|---|---|---|---|');
  for (const i of xs) {
    lines.push(
      `| ${i.caseId ?? i.failureId} | **${i.verdict}** | ${i.confidence.toFixed(2)} | ${i.rule ?? (i.model && i.model !== 'none' ? `model ${i.model}` : '—')} | ${i.route ?? '—'} |`,
    );
  }
  for (const i of xs) {
    lines.push('', `## ${i.caseId ?? i.failureId} — ${i.verdict}`, '', cell(i.rationale ?? ''), '');
    lines.push('**Observed**', '', ...i.observations.map((x) => `- ${cell(x)}`), '');
    lines.push('**Hypotheses**', '', '| Id | Hypothesis | Status | Result |', '|---|---|---|---|');
    for (const h of i.hypotheses)
      lines.push(`| ${h.id} | ${h.verdict ?? ''}: ${cell(h.text)} | ${h.status ?? 'OPEN'} | ${cell(h.result ?? '')} |`);
    lines.push(
      '',
      '**Experiments** (cheapest first)',
      '',
      '| Experiment | Action | Outcome | Result | Evidence |',
      '|---|---|---|---|---|',
    );
    for (const e of i.experiments)
      lines.push(`| ${e.kind} | ${e.action} | ${e.outcome} | ${cell(e.result)} | ${e.evidenceIds.join(', ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}
