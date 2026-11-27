// Independent check of a `qa visual run` (Phase 6 exit): reads only the run folder, Playwright's own JSON, the
// baseline folder and the approvals store — never the runner's in-memory state or src/visual/collect.ts.
//   pnpm validate:visual <runId> [<runId> …]
// Checks: summary schema · environment label matches config/orgs.yaml · every region × viewport has exactly one
// candidate · statuses re-derived from Playwright's attachments (actual without expected → NO_BASELINE, expected +
// actual → DIFF, captured without either → MATCH or RE_APPROVE) · every referenced image exists and the actual's
// sha256 matches · MATCH only with an approval recorded before the run · counts agree · data reconciliation CLEAN ·
// audit has nothing REFUSED · baselines approved from this run are bound to an approve-visual-baseline approval and
// to this run's image hash · report files exist and a non-LIVE report carries its banner.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { OrgsConfig } from '../src/config/schemas.js';
import { Approval, AuditEntry } from '../src/core/schemas/data.js';
import { BaselineManifest, VisualRunSummary } from '../src/core/schemas/visual.js';

const root = resolve(import.meta.dirname, '..');
const runIds = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!runIds.length) {
  console.error('usage: pnpm validate:visual <runId> [<runId> …]');
  process.exit(2);
}
const json = (f: string): unknown => JSON.parse(readFileSync(f, 'utf8')) as unknown;
const sha = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex');
const yamlFile = (n: string): string => {
  const local = join(root, 'config', `${n}.yaml`);
  return existsSync(local) ? local : join(root, 'config', `${n}.example.yaml`);
};

const Att = z.object({ name: z.string() });
const PwRes = z.object({ status: z.string().optional(), attachments: z.array(Att).default([]) });
const PwTest = z.object({ projectName: z.string(), results: z.array(PwRes).default([]) });
const PwSpec = z.object({ title: z.string(), tests: z.array(PwTest).default([]) });
interface S {
  specs?: z.infer<typeof PwSpec>[];
  suites?: S[];
}
const walk = (ss: S[]): z.infer<typeof PwSpec>[] =>
  ss.flatMap((s) => [...(s.specs ?? []).map((x) => PwSpec.parse(x)), ...walk(s.suites ?? [])]);

let failed = false;
for (const runId of runIds) {
  const dir = join(root, 'runs', runId);
  const oks: string[] = [];
  const bad: string[] = [];
  try {
    const s = VisualRunSummary.parse(json(join(dir, 'visual', 'visual-summary.json')));
    oks.push(`summary valid: ${String(s.candidates.length)} candidates, ${s.environment}, ${s.org}`);
    const orgs = OrgsConfig.parse(parse(readFileSync(yamlFile('orgs'), 'utf8')));
    const org = orgs.orgs.find((o) => o.alias === s.org);
    if (!org) bad.push(`org ${s.org} not in orgs.yaml`);
    else if (org.environment !== s.environment || org.orgId !== s.orgId)
      bad.push(`environment/org id differ from orgs.yaml (${org.environment} ${org.orgId})`);
    else oks.push(`environment label ${s.environment} matches orgs.yaml`);

    // one candidate per region × viewport
    const regions = ['new-contact-dialog', 'contact-details', 'account-record'];
    const want = s.viewports.flatMap((v) => regions.map((r) => `${r}-${s.persona}-${v}`));
    const names = s.candidates.map((c) => c.name);
    const missing = want.filter((n) => !names.includes(n));
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    if (missing.length || dup.length)
      bad.push(`candidates: missing ${missing.join(', ') || '-'}; duplicate ${dup.join(', ') || '-'}`);
    else oks.push(`one candidate per region × viewport (${String(want.length)})`);

    // statuses re-derived from Playwright's own JSON
    const pw = z.object({ suites: z.array(z.unknown()).default([]) }).parse(json(join(dir, 'playwright-results.json')));
    const atts = new Map<string, Set<string>>();
    for (const sp of walk(pw.suites as S[]).filter((x) => x.title.startsWith('VIS-'))) {
      for (const t of sp.tests) {
        const vp = /-([a-z0-9]+)$/.exec(t.projectName)?.[1] ?? '';
        atts.set(vp, new Set((t.results.at(-1)?.attachments ?? []).map((a) => a.name)));
      }
    }
    let derivedOk = 0;
    for (const c of s.candidates) {
      const a = atts.get(c.viewport) ?? new Set<string>();
      const actual = a.has(`${c.name}-actual.png`);
      const expected = a.has(`${c.name}-expected.png`);
      const captured = a.has(`visual-layout-${c.region}.json`) || a.has(`visual-shot-${c.name}.png`);
      const exp =
        actual && !expected
          ? ['NO_BASELINE']
          : actual
            ? ['DIFF']
            : captured
              ? ['MATCH', 'RE_APPROVE', 'DIFF']
              : ['NOT_CAPTURED', 'DIFF'];
      if (!exp.includes(c.status))
        bad.push(`${c.name}: status ${c.status}, Playwright attachments say ${exp.join('/')}`);
      else derivedOk++;
    }
    if (derivedOk === s.candidates.length) oks.push('statuses agree with Playwright attachments');

    // images
    let imgOk = true;
    for (const c of s.candidates) {
      for (const [k, p] of Object.entries(c.images)) {
        if (p && !existsSync(join(dir, p))) {
          bad.push(`${c.name}: ${k} image missing (${p})`);
          imgOk = false;
        }
      }
      if (
        c.images.actual &&
        c.actualSha256 &&
        existsSync(join(dir, c.images.actual)) &&
        sha(join(dir, c.images.actual)) !== c.actualSha256
      ) {
        bad.push(`${c.name}: actual image hash differs from the summary`);
        imgOk = false;
      }
      if ((c.status === 'DIFF' || c.status === 'NO_BASELINE') && !c.images.actual) {
        bad.push(`${c.name}: ${c.status} without an actual image`);
        imgOk = false;
      }
    }
    if (imgOk) oks.push('every referenced image exists; actual hashes match');

    // approvals
    const apFile = join(root, '.qa-memory', 'approvals.jsonl');
    const approvals = existsSync(apFile)
      ? readFileSync(apFile, 'utf8')
          .split(/\r?\n/)
          .filter(Boolean)
          .map((l) => Approval.parse(JSON.parse(l)))
      : [];
    const visualAps = approvals.filter((a) => a.checkpoint === 'approve-visual-baseline' && a.orgId === s.orgId);
    const matches = s.candidates.filter((c) => c.status === 'MATCH');
    if (matches.length && !visualAps.some((a) => a.approvedAt < s.createdAt))
      bad.push('MATCH without any baseline approval recorded before the run');
    else oks.push(`MATCH ${String(matches.length)}: backed by an approval recorded before the run`);
    const folder = join(root, 'tests', 'visual-baselines', s.org);
    const mf = join(folder, 'baselines.json');
    if (existsSync(mf)) {
      const m = BaselineManifest.parse(json(mf));
      const fromRun = m.baselines.filter((b) => b.sourceRun === runId);
      for (const b of fromRun) {
        const ap = visualAps.find((a) => a.id === b.approvalId);
        const c = s.candidates.find((x) => x.name === b.name);
        if (!ap) bad.push(`baseline ${b.name}: approval ${b.approvalId} not in approvals.jsonl`);
        else if (ap.runId !== runId) bad.push(`baseline ${b.name}: approval ${ap.id} is for run ${ap.runId ?? '-'}`);
        if (!c?.actualSha256 || c.actualSha256 !== b.sha256)
          bad.push(`baseline ${b.name}: hash differs from this run's actual image`);
        if (existsSync(join(folder, `${b.name}.png`)) && sha(join(folder, `${b.name}.png`)) !== b.sha256)
          bad.push(`baseline ${b.name}: file edited after approval`);
      }
      if (fromRun.length)
        oks.push(`${String(fromRun.length)} baseline(s) approved from this run: bound to approval + image hash`);
    }

    // counts
    const cnt = {
      match: matches.length,
      candidates: s.candidates.length - matches.length,
      layout: s.layout.length,
      a11yFail: s.a11y.filter((f) => f.status === 'FAIL').length,
      a11yNewStandard: s.a11y.filter((f) => f.status === 'NEW_STANDARD').length,
    };
    if (JSON.stringify(cnt) !== JSON.stringify(s.counts))
      bad.push(`counts ${JSON.stringify(s.counts)} ≠ recomputed ${JSON.stringify(cnt)}`);
    else oks.push(`counts agree: ${JSON.stringify(cnt)}`);

    // data
    const recFile = join(dir, 'visual', 'data-reconciliation.json');
    const rec = existsSync(recFile)
      ? z
          .looseObject({
            status: z.string(),
            remaining: z.array(z.unknown()),
            untagged: z.array(z.unknown()).default([]),
          })
          .parse(json(recFile))
      : undefined;
    if (rec?.status !== 'CLEAN' || rec.remaining.length || rec.untagged.length)
      bad.push(
        `data reconciliation ${rec?.status ?? 'missing'} (remaining ${String(rec?.remaining.length ?? '?')}, untagged ${String(rec?.untagged.length ?? '?')})`,
      );
    else oks.push('data CLEAN: re-query 0, 0 untagged');

    // audit
    const auditFile = join(dir, 'audit.jsonl');
    const audit = existsSync(auditFile)
      ? readFileSync(auditFile, 'utf8')
          .split(/\r?\n/)
          .filter(Boolean)
          .map((l) => AuditEntry.parse(JSON.parse(l)))
      : [];
    if (audit.some((e) => e.outcome === 'REFUSED')) bad.push('audit has REFUSED entries');
    else oks.push(`audit: ${String(audit.length)} entries, none REFUSED`);

    // reports
    const mdF = join(dir, 'report', 'visual-diff.md');
    const htmlF = join(dir, 'report', 'visual-diff.html');
    if (!existsSync(mdF) || !existsSync(htmlF)) bad.push('visual-diff report missing');
    else if (s.environment !== 'LIVE' && !readFileSync(mdF, 'utf8').includes('NOT a Salesforce result'))
      bad.push('non-LIVE report without its banner');
    else
      oks.push('visual-diff report (md + html) present' + (s.environment !== 'LIVE' ? ' with the FIXTURE banner' : ''));
  } catch (err) {
    bad.push(err instanceof Error ? err.message : String(err));
  }
  console.log(`\n${runId}: ${bad.length ? 'INVALID' : 'valid'}`);
  for (const m of oks) console.log(`  ok   ${m}`);
  for (const m of bad) console.log(`  FAIL ${m}`);
  if (bad.length) failed = true;
}
process.exit(failed ? 1 : 0);
