// Independent check of Phase 7 outputs (PLAN Phase 7 exit). Reads only run folders, evidence exports, the approvals
// store and the specs on disk — never the agents' in-memory state.
//   pnpm validate:investigation <runId> [<runId> …]
// A run id may be an investigation run (investigation/ + defects/), a heal run (heal/), a fault suite (faults/) or an
// exploration run (explore/). Checks:
//   investigations: schema · confidence < 0.6 ⇒ UNKNOWN · PRODUCT_DEFECT only with fresh-data reproduction of a stated
//     requirement (never a single UI failure) · every evidence id resolves in the run's evidence export · banner off-LIVE
//   heal: applied repairs have equal assertion fingerprints · the spec's fingerprint on disk still equals the repair's
//     (assertions untouched since) · FIXTURE VERIFIED repairs were reverted · nothing applied without approval when
//     behaviour-changing
//   defects: text sha256 matches · CONFIRMED ⇒ every gate item true, judge CONFIRMED, no unsupported claim · a non-LIVE
//     draft is never published and carries the banner
//   faults: correct count re-derived · passed ⇔ ≥ 80 % and 0 assertion changes · FIXTURE only
//   exploration: steps / saves within the charter · findings carry resolvable evidence · data CLEAN · a promoted finding
//     has a human approval (review-required-expectations) and its case exists in the exploratory case edits
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { Approval } from '../src/core/schemas/data.js';
import { ExplorationReport } from '../src/core/schemas/exploration.js';
import { DefectDraft, FaultScorecard, HealRepair, Investigation } from '../src/core/schemas/investigation.js';
import { StoryManifest, TestIR } from '../src/core/schemas/index.js';
import { assertionFingerprint } from '../src/agents/self-healer/fingerprint.js';

const root = resolve(import.meta.dirname, '..');
const runIds = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!runIds.length) {
  console.error('usage: pnpm validate:investigation <runId> [<runId> …]');
  process.exit(2);
}
const json = (f: string): unknown => JSON.parse(readFileSync(f, 'utf8')) as unknown;
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const approvals = (): Approval[] => {
  const f = join(root, '.qa-memory', 'approvals.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => Approval.parse(JSON.parse(l))) : [];
};
const evidenceIds = (runId: string): Set<string> => {
  const f = join(root, 'runs', runId, 'evidence', 'evidence.json');
  if (!existsSync(f)) return new Set();
  return new Set(z.array(z.object({ id: z.string() })).parse(json(f)).map((e) => e.id));
};

let failures = 0;
for (const runId of runIds) {
  const dir = join(root, 'runs', runId);
  const problems: string[] = [];
  const oks: string[] = [];
  const bad = (m: string): void => void problems.push(m);
  const ok = (m: string): void => void oks.push(m);
  if (!existsSync(dir)) {
    console.log(`✗ ${runId}: no run folder`);
    failures++;
    continue;
  }
  const ev = evidenceIds(runId);

  // ---- investigations
  const invFile = join(dir, 'investigation', 'investigations.json');
  if (existsSync(invFile)) {
    const f = z.object({ sourceRun: z.string(), environment: z.enum(['LIVE', 'FIXTURE', 'MOCK']), investigations: z.array(Investigation) }).parse(json(invFile));
    for (const i of f.investigations) {
      const tag = i.caseId ?? i.failureId;
      if (i.confidence < 0.6 && i.verdict !== 'UNKNOWN') bad(`${tag}: ${i.verdict} below 0.6`);
      if (i.verdict === 'PRODUCT_DEFECT') {
        const fresh = i.experiments.find((e) => e.kind === 'rerun-fresh-data');
        const trace = i.experiments.find((e) => e.kind === 'requirement-trace');
        if (fresh?.outcome !== 'SUPPORTS') bad(`${tag}: PRODUCT_DEFECT without a fresh-data reproduction`);
        if (trace?.outcome !== 'REFUTES') bad(`${tag}: PRODUCT_DEFECT without a stated requirement`);
      }
      const missing = i.evidenceIds.filter((e) => !ev.has(e));
      if (missing.length) bad(`${tag}: evidence ids not in the export: ${missing.join(', ')}`);
      const hyp = i.hypotheses.length;
      if (hyp < 3) bad(`${tag}: only ${String(hyp)} hypotheses (skill: 3–5 competing)`);
    }
    const md = readFileSync(join(dir, 'investigation', 'investigation-report.md'), 'utf8');
    if (f.environment !== 'LIVE' && !md.includes('not a Salesforce result')) bad('non-LIVE investigation report has no banner');
    ok(`${String(f.investigations.length)} investigation(s) of ${f.sourceRun} [${f.environment}]: ${f.investigations.map((i) => `${i.caseId ?? '?'}=${i.verdict}`).join(', ') || 'none'}`);
  }

  // ---- defects
  const defDir = join(dir, 'defects');
  if (existsSync(defDir)) {
    for (const file of readdirSync(defDir).filter((x) => x.endsWith('.json'))) {
      const d = DefectDraft.parse(json(join(defDir, file)));
      const text = readFileSync(join(defDir, file.replace(/\.json$/, '.md')), 'utf8');
      if (d.sha256 !== sha(text)) bad(`${d.id}: text sha256 mismatch`);
      if (d.status === 'CONFIRMED') {
        const g = d.judge?.gate;
        const allTrue = g && g.reproducedTwiceFreshData && g.reproducedViaApi && g.testDataRuledOut && g.environmentRuledOut && g.requirementTraced && g.evidenceResolves && g.sanitized;
        if (!allTrue) bad(`${d.id}: CONFIRMED with a gate item false`);
        if (d.judge?.decision !== 'CONFIRMED' || d.judge.unsupportedClaims.length) bad(`${d.id}: CONFIRMED without the judge's confirmation`);
      }
      if (d.environment !== 'LIVE') {
        if (d.published) bad(`${d.id}: ${d.environment ?? '?'} defect marked published`);
        if (!text.includes('not a Salesforce result')) bad(`${d.id}: non-LIVE draft without banner`);
      }
      const missing = d.evidenceIds.filter((e) => !ev.has(e));
      if (missing.length) bad(`${d.id}: evidence ids not in the export: ${missing.join(', ')}`);
      ok(`defect ${d.id} [${d.environment ?? '?'}] ${d.status ?? '?'} — judge ${d.judge?.decision ?? '-'} (${d.judge?.model ?? '-'}), gate missing ${String(d.judge?.gate.missing.length ?? 0)}`);
    }
  }

  // ---- heal
  const healFile = join(dir, 'heal', 'repairs.json');
  if (existsSync(healFile)) {
    const h = z.object({ environment: z.enum(['LIVE', 'FIXTURE', 'MOCK']), repairs: z.array(HealRepair) }).parse(json(healFile));
    const all = existsSync(join(root, '.qa-memory', 'heal', 'repairs.jsonl'))
      ? readFileSync(join(root, '.qa-memory', 'heal', 'repairs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => HealRepair.parse(JSON.parse(l)))
      : [];
    for (const r of h.repairs.filter((x) => ['APPLIED', 'VERIFIED', 'FAILED'].includes(x.status))) {
      if (!r.assertionsUnchanged || r.fingerprintBefore.sha256 !== r.fingerprintAfter.sha256) bad(`${r.id}: assertions changed`);
      if (r.behaviourChanging && !r.approvalId) bad(`${r.id}: behaviour-changing repair applied without approval`);
      if (r.environment !== 'LIVE' && r.status === 'VERIFIED' && !all.some((x) => x.revertOf === r.id)) bad(`${r.id}: ${r.environment} repair not reverted`);
      // the spec on disk must still carry the same assertions
      const spec = join(root, r.specPath);
      if (existsSync(spec)) {
        const story = /TC-([A-Z0-9]+-\d+)-\d+/.exec(r.caseId)?.[1];
        let irA: unknown[] = [];
        const mf = story ? join(root, 'tests', 'generated', story, 'manifest.json') : undefined;
        if (mf && existsSync(mf)) {
          const m = StoryManifest.parse(json(mf));
          const a = m.artifacts.find((x) => x.testCaseIds.includes(r.caseId));
          const irf = join(root, 'runs', a?.buildRun ?? m.buildRun ?? '', 'build', 'ir', `${r.caseId}.json`);
          if (existsSync(irf)) irA = TestIR.parse(json(irf)).steps.flatMap((s) => s.assertions);
        }
        const now = assertionFingerprint(readFileSync(spec, 'utf8'), irA);
        if (now.sha256 !== r.fingerprintAfter.sha256) bad(`${r.id}: ${r.specPath} assertions differ from the repair's fingerprint`);
      }
    }
    const applied = h.repairs.filter((x) => ['APPLIED', 'VERIFIED', 'FAILED'].includes(x.status));
    ok(`${String(applied.length)} applied repair(s) [${h.environment}], assertion changes ${String(applied.filter((x) => !x.assertionsUnchanged).length)}, fingerprints re-derived from the specs on disk`);
  }

  // ---- faults
  const scFile = join(dir, 'faults', 'scorecard.json');
  if (existsSync(scFile)) {
    const s = FaultScorecard.parse(json(scFile));
    const correct = s.outcomes.filter((o) => o.actualVerdict === o.expectedVerdict).length;
    if (correct !== s.correct) bad(`scorecard says ${String(s.correct)} correct, outcomes say ${String(correct)}`);
    const passed = s.total > 0 && correct / s.total >= 0.8 && s.assertionChanges === 0;
    if (passed !== s.passed) bad('scorecard passed flag inconsistent');
    if (s.environment !== 'FIXTURE') bad('fault suite not on the fixture');
    ok(`fault suite ${s.suiteId}: ${String(correct)}/${String(s.total)} correct, assertion changes ${String(s.assertionChanges)} → ${passed ? 'PASSED' : 'NOT MET'}`);
  }

  // ---- exploration
  const exFile = join(dir, 'explore', 'exploration.json');
  if (existsSync(exFile)) {
    const r = ExplorationReport.parse(json(exFile));
    if (r.steps.length > r.charter.maxSteps) bad('more steps than the charter allows');
    if (r.saves > r.charter.maxSaves) bad('more saves than the charter allows');
    if (r.dataCleanup !== 'CLEAN' && r.saves > 0) bad(`data cleanup ${r.dataCleanup}`);
    for (const f of r.findings) {
      const missing = f.evidenceIds.filter((e) => !ev.has(e));
      if (missing.length) bad(`${f.id}: evidence ids not in the export: ${missing.join(', ')}`);
      if (f.promoted) {
        const a = approvals().find((x) => x.id === f.promoted?.approvalId && x.checkpoint === 'review-required-expectations');
        if (!a) bad(`${f.id}: promoted without a recorded human approval`);
        const editsFile = join(root, 'examples', 'case-edits', 'SF-219-exploratory.yaml');
        const edits = existsSync(editsFile) ? (parse(readFileSync(editsFile, 'utf8')) as { addCases?: { id?: string }[] }) : {};
        if (!edits.addCases?.some((c) => c.id === f.testCaseId)) bad(`${f.id}: promoted case ${f.testCaseId ?? '?'} not in the exploratory case edits`);
      }
    }
    ok(`exploration ${r.charter.id} [${r.environment}]: ${String(r.steps.length)} steps, ${String(r.states.length)} states, ${String(r.saves)}/${String(r.charter.maxSaves)} saves, ${String(r.findings.length)} finding(s) (${String(r.findings.filter((f) => f.promoted).length)} promoted), data ${r.dataCleanup}`);
  }

  if (!oks.length && !problems.length) bad('no Phase 7 output in this run folder');
  console.log(`${problems.length ? '✗' : '✓'} ${runId}`);
  for (const m of oks) console.log(`  ok  ${m}`);
  for (const m of problems) console.log(`  BAD ${m}`);
  if (problems.length) failures++;
}
process.exit(failures ? 1 : 0);
