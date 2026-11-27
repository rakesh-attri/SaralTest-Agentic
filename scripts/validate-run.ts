// Independent check of a `qa run` (Phase 5 exit): reads only the run folder, the story manifest and the approvals
// store — never the Runner's in-memory state.
//   pnpm validate:run <runId> [<runId> …]
// Checks: results.json schema · every EXECUTE gate row has a result · nothing outside EXECUTE ran in Playwright ·
// result states agree with Playwright's own JSON (re-mapped here) · every row carries the run's environment label ·
// data cleanup CLEAN (re-query 0, no untagged record) · audit ALLOWED ↔ SUCCEEDED/FAILED pairs, nothing REFUSED ·
// recipe approval recorded for a LIVE org · report files exist.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { AuditEntry, Approval } from '../src/core/schemas/data.js';
import { ExecutionSummary, StoryManifest } from '../src/core/schemas/execution.js';
import { TestResult } from '../src/core/schemas/result.js';
import { PlaywrightJson, toTestResults } from '../src/runner/results.js';

const root = resolve(import.meta.dirname, '..');
const runIds = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!runIds.length) {
  console.error('usage: pnpm validate:run <runId> [<runId> …]');
  process.exit(2);
}

const GateItem = z.object({
  caseId: z.string(),
  path: z.string().optional(),
  decision: z.enum(['EXECUTE', 'BLOCKED', 'NOT_APPROVED', 'MANUAL', 'NOT_SELECTED']),
  reason: z.string(),
});
const json = (f: string): unknown => JSON.parse(readFileSync(f, 'utf8')) as unknown;

let failed = false;
for (const runId of runIds) {
  const dir = join(root, 'runs', runId);
  const problems: string[] = [];
  const oks: string[] = [];
  const ok = (m: string): void => {
    oks.push(m);
  };
  const bad = (m: string): void => {
    problems.push(m);
  };
  try {
    const summary = ExecutionSummary.parse(json(join(dir, 'run', 'execution-summary.json')));
    const results = z.array(TestResult).parse(json(join(dir, 'results.json')));
    const gate = z.array(GateItem).parse(json(join(dir, 'run', 'execution-plan.json')));
    ok(`results.json: ${String(results.length)} TestResult rows (schema valid)`);

    // Gate coverage + nothing outside EXECUTE ran.
    const execute = gate.filter((g) => g.decision === 'EXECUTE');
    const missing = execute.filter((g) => !results.some((r) => r.caseId === g.caseId));
    if (missing.length) bad(`EXECUTE rows without a result: ${missing.map((g) => g.caseId).join(', ')}`);
    else ok(`every EXECUTE gate row (${String(execute.length)}) has a result`);
    const ranIds = results.filter((r) => r.persona !== undefined).map((r) => r.caseId ?? '');
    const notAllowed = ranIds.filter((id) => !execute.some((g) => g.caseId === id));
    if (notAllowed.length) bad(`tests ran that the gate did not allow: ${notAllowed.join(', ')}`);
    else ok('no NOT_APPROVED / BLOCKED / MANUAL / NOT_SELECTED spec ran');

    // Results agree with Playwright's own JSON.
    const pwFile = join(dir, 'playwright-results.json');
    if (summary.status === 'BLOCKED') {
      if (existsSync(pwFile)) bad('a BLOCKED run has a Playwright report');
      else ok(`run BLOCKED before any test: ${summary.blockedReason ?? ''}`);
    } else {
      const pw = PlaywrightJson.parse(json(pwFile));
      const again = toTestResults(pw, {
        runId,
        environment: summary.environment,
        snapshotId: results[0]?.snapshotId ?? '',
        browser: summary.browser,
        runDir: dir,
        testDirRel: 'tests/generated',
        gate,
      });
      const diff = again.filter((a) => results.find((r) => r.caseId === a.caseId)?.state !== a.state);
      if (diff.length) bad(`states differ from playwright-results.json: ${diff.map((d) => d.caseId).join(', ')}`);
      else ok('result states agree with playwright-results.json (re-mapped independently)');
    }

    // Environment labels.
    const wrongEnv = results.filter((r) => r.environment !== summary.environment);
    if (wrongEnv.length) bad(`rows not labelled ${summary.environment}: ${wrongEnv.map((r) => r.caseId).join(', ')}`);
    else ok(`every row labelled ${summary.environment}`);
    const wrongBrowser = results.filter((r) => r.persona !== undefined && r.browser !== summary.browser);
    if (wrongBrowser.length) bad(`rows not run in ${summary.browser}: ${wrongBrowser.map((r) => r.caseId).join(', ')}`);
    else if (results.some((r) => r.persona !== undefined)) ok(`executed rows record browser ${summary.browser}`);

    // Data.
    const recFile = join(dir, 'run', 'data-reconciliation.json');
    if (existsSync(recFile)) {
      const rec = z
        .looseObject({
          status: z.string(),
          remaining: z.array(z.unknown()),
          untagged: z.array(z.unknown()).default([]),
          subRuns: z.array(z.unknown()),
        })
        .parse(json(recFile));
      if (rec.status !== 'CLEAN' || rec.remaining.length || rec.untagged.length) {
        bad(`data ${rec.status}: ${String(rec.remaining.length)} remaining, ${String(rec.untagged.length)} untagged`);
      } else ok(`data CLEAN: ${String(rec.subRuns.length)} sub-run(s), re-query 0, no untagged record`);
    } else if (summary.status !== 'BLOCKED') bad('no data reconciliation report');

    // Audit pairs.
    const auditFile = join(dir, 'audit.jsonl');
    if (existsSync(auditFile)) {
      const entries = readFileSync(auditFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => AuditEntry.parse(JSON.parse(l)));
      const n = (o: string): number => entries.filter((e) => e.outcome === o).length;
      const refused = n('REFUSED');
      if (n('ALLOWED') !== n('SUCCEEDED') + n('FAILED')) {
        bad(
          `audit: ${String(n('ALLOWED'))} ALLOWED vs ${String(n('SUCCEEDED'))} SUCCEEDED + ${String(n('FAILED'))} FAILED`,
        );
      } else
        ok(
          `audit: ${String(n('ALLOWED'))} ALLOWED = ${String(n('SUCCEEDED'))} SUCCEEDED + ${String(n('FAILED'))} FAILED`,
        );
      if (refused) bad(`audit: ${String(refused)} REFUSED`);
    } else if (summary.environment === 'LIVE' && summary.status !== 'BLOCKED') bad('no audit log for a LIVE run');

    // Approval (LIVE: the recipes the executed specs use).
    if (summary.environment === 'LIVE') {
      const manifest = StoryManifest.parse(json(join(root, 'tests', 'generated', summary.storyKey, 'manifest.json')));
      const recipes = [
        ...new Set(
          execute.flatMap((g) => manifest.artifacts.find((a) => a.testCaseIds.includes(g.caseId))?.dataBindings ?? []),
        ),
      ];
      const approvals = existsSync(join(root, '.qa-memory', 'approvals.jsonl'))
        ? readFileSync(join(root, '.qa-memory', 'approvals.jsonl'), 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => Approval.parse(JSON.parse(l)))
        : [];
      for (const r of recipes) {
        const a = approvals.filter((x) => x.subject.startsWith(`recipe:${r}@`));
        if (a.length) ok(`recipe ${r}: approval on record (${a.at(-1)?.id ?? ''} by ${a.at(-1)?.approvedBy ?? ''})`);
        else bad(`recipe ${r}: no approval recorded`);
      }
    }

    // Report files.
    for (const f of [
      'report/index.md',
      'report/execution-report.md',
      'report/execution-report.html',
      'report/release-confidence.md',
      'report/cleanup-reconciliation.md',
      'report/impact-coverage.md',
      'report/rtm-results.xlsx',
      'report/history.md',
      ...(summary.status === 'BLOCKED' ? [] : ['playwright-report/index.html', 'reporting-labs/index.html']),
    ]) {
      if (!existsSync(join(dir, f))) bad(`missing ${f}`);
    }
    if (!problems.some((p) => p.startsWith('missing'))) ok('reports present (Playwright HTML, reporting-labs, extras)');
    const x = summary.executed;
    console.log(
      `\n${runId} — ${summary.environment} · ${summary.orgAlias} · ${summary.browser} · ${String(x.PASS)} PASS · ${String(x.FAIL)} FAIL · ${String(x.UNCERTAIN)} UNCERTAIN · ${String(x.BLOCKED)} BLOCKED`,
    );
  } catch (err) {
    bad(`unreadable run outputs: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`\n${runId}`);
  }
  for (const m of oks) console.log(`  ok   ${m}`);
  for (const m of problems) console.log(`  FAIL ${m}`);
  console.log(problems.length ? `  → ${runId}: NOT valid` : `  → ${runId}: run outputs valid`);
  if (problems.length) failed = true;
}
process.exit(failed ? 1 : 0);
