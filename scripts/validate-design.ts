/**
 * Independent check of Phase 3 design output against the Zod contracts and the PLAN.md §11 P3 exit criteria:
 *   1. every AC covered — every story AC cited by a requirement has ≥1 test case (from the analysis sources, not from
 *      the design's own summary)
 *   2. every expectation evidence-labelled — every step parses with a valid EvidenceLevel; APPROVED cases hold only
 *      assertable levels; non-UNKNOWN levels cite evidence
 *   3. Reviewer findings resolved or justified — no finding is OPEN; every JUSTIFIED one has a resolution text
 * Usage: pnpm validate:design [--root <project>] <runId> [<runId> …]   (exit 1 on any failure)
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  CoverageObligation,
  Requirement,
  ReviewFinding,
  RiskItem,
  RtmRow,
  SourceDocument,
  TestCase,
  TestCharter,
} from '../src/core/schemas/index.js';

const args = process.argv.slice(2);
let root = join(import.meta.dirname, '..');
const ri = args.indexOf('--root');
if (ri >= 0) {
  root = resolve(args[ri + 1] ?? '.');
  args.splice(ri, 2);
}
if (!args.length) {
  process.stderr.write('usage: pnpm validate:design [--root <project>] <runId> [<runId> …]\n');
  process.exit(2);
}

const result = { failed: false };
for (const runId of args) {
  const run = join(root, 'runs', runId);
  const dir = join(run, 'design');
  const read = (f: string): unknown => JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const out: string[] = [];
  const fail = (m: string): void => {
    result.failed = true;
    out.push(`  FAIL ${m}`);
  };
  const ok = (m: string): void => {
    out.push(`  ok   ${m}`);
  };
  process.stdout.write(`\n${runId}\n`);
  if (!existsSync(dir)) {
    fail(`no design output at ${dir}`);
    process.stdout.write(`${out.join('\n')}\n`);
    continue;
  }
  const parse = <T>(file: string, schema: z.ZodType<T>): T | undefined => {
    const r = schema.safeParse(read(file));
    if (!r.success) {
      fail(
        `${file}: ${r.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
      return undefined;
    }
    return r.data;
  };
  const cases = parse('test-cases.json', z.array(TestCase).min(1)) ?? [];
  const rtm = parse('rtm.json', z.array(RtmRow)) ?? [];
  const findings = parse('review-pass1.json', z.array(ReviewFinding)) ?? [];
  parse('risks.json', z.array(RiskItem));
  parse('obligations.json', z.array(CoverageObligation));
  const charter = parse('charter.json', TestCharter);
  const meta = read('design-run.json') as {
    designEnvironment: string;
    orgEnvironment: string;
    models: string[];
    status: string;
  };
  ok(
    `contracts: ${String(cases.length)} cases, ${String(rtm.length)} RTM rows, ${String(findings.length)} findings parse`,
  );
  out.push(
    `       labels: design ${meta.designEnvironment} · org ${meta.orgEnvironment} · models ${meta.models.join(', ') || 'none'} · status ${meta.status} · snapshot ${charter?.snapshotId ?? '—'}`,
  );

  // 1. AC coverage, from the analysis inputs
  const analysis = join(run, 'analysis');
  const reqs = existsSync(join(analysis, 'requirements.json'))
    ? z.array(Requirement).parse(JSON.parse(readFileSync(join(analysis, 'requirements.json'), 'utf8')))
    : [];
  const srcDir = join(analysis, 'sources');
  const docs = existsSync(srcDir)
    ? readdirSync(srcDir).map((f) => SourceDocument.parse(JSON.parse(readFileSync(join(srcDir, f), 'utf8'))))
    : [];
  const acRefs = new Set<string>();
  for (const d of docs) {
    for (const s of d.sections.filter((x) => x.kind === 'ac')) {
      const cited = reqs.some((r) =>
        r.sources.some((src) => src.section === s.ref && (src.ref === d.source.ref || src.ref === d.docId)),
      );
      if (cited) acRefs.add(s.ref);
      else out.push(`       note: ${d.docId}#${s.ref} is cited by no requirement (excluded during analysis)`);
    }
  }
  const uncovered = [...acRefs].filter((ac) => !cases.some((c) => c.refs.includes(ac)));
  const acList = [...acRefs].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!acRefs.size) fail('no acceptance criteria found in the analysis sources');
  else if (uncovered.length) fail(`ACs without a case: ${uncovered.join(', ')}`);
  else
    ok(
      `every AC covered: ${acList.map((ac) => `${ac}(${String(cases.filter((c) => c.refs.includes(ac)).length)})`).join(' ')}`,
    );
  const gaps = rtm.filter((r) => r.status === 'gap');
  if (gaps.length) fail(`RTM gaps: ${gaps.map((g) => g.requirementId).join(', ')}`);
  else ok(`RTM: every requirement has cases (${rtm.map((r) => `${r.requirementId}:${r.status}`).join(', ')})`);

  // 2. evidence labels (Zod already enforces enum, APPROVED ⇒ assertable, evidence ids)
  const levels = new Map<string, number>();
  let steps = 0;
  for (const c of cases)
    for (const s of c.steps) {
      steps++;
      levels.set(s.expected.evidenceLevel, (levels.get(s.expected.evidenceLevel) ?? 0) + 1);
    }
  if (cases.some((c) => c.steps.some((s) => s.expected.evidenceLevel === 'VERIFIED')))
    fail('VERIFIED level used before any executed run');
  ok(
    `every expectation evidence-labelled: ${String(steps)} steps — ${[...levels].map(([k, n]) => `${k} ${String(n)}`).join(', ')}`,
  );
  const approved = cases.filter((c) => c.reviewStatus === 'APPROVED').length;
  out.push(
    `       cases: ${String(approved)} APPROVED, ${String(cases.filter((c) => c.reviewStatus === 'REVIEW_REQUIRED').length)} REVIEW_REQUIRED, ${String(cases.filter((c) => c.reviewStatus === 'BLOCKED').length)} BLOCKED`,
  );

  // 3. findings
  const open = findings.filter((f) => f.status === 'OPEN');
  const bare = findings.filter((f) => f.status === 'JUSTIFIED' && !f.resolution?.trim());
  if (open.length) fail(`open reviewer findings: ${open.map((f) => f.id).join(', ')}`);
  else if (bare.length) fail(`justified without a reason: ${bare.map((f) => f.id).join(', ')}`);
  else {
    const n = (st: string): number => findings.filter((f) => f.status === st).length;
    ok(
      `reviewer findings resolved or justified: ${String(n('RESOLVED'))} resolved, ${String(n('JUSTIFIED'))} justified (${String(findings.filter((f) => f.escalated).length)} escalated to a human), 0 open`,
    );
  }
  for (const f of ['test-plan.md', 'test-cases.md', 'charter.md', 'rtm.xlsx', 'test-design-report.html']) {
    if (!existsSync(join(dir, f))) fail(`missing ${f}`);
  }
  process.stdout.write(`${out.join('\n')}\n`);
}
process.stdout.write(result.failed ? '\nVALIDATION FAILED\n' : '\nall design outputs valid\n');
process.exit(result.failed ? 1 : 0);
