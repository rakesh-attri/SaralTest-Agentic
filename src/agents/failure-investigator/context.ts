// What the investigator knows about a failed case before it runs any experiment: the spec's manifest entry, its test
// IR, the designed test case and the text of every evidence id the failing expectation cites. All local files written
// by earlier phases (tests/generated/<story>/manifest.json, runs/<buildRun>/build/ir, runs/<designRun>/…).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { caseEditEvidenceId, loadCaseEdits } from '../../inputs/caseEdits.js';
import { join } from 'node:path';
import { z } from 'zod';
import {
  StoryManifest,
  TestCase,
  TestIR,
  type FailureSignal,
  type IrAssertion,
  type ManifestArtifact,
  type TestResult,
} from '../../core/schemas/index.js';

export interface CaseContext {
  caseId: string;
  storyKey?: string;
  artifact?: ManifestArtifact;
  ir?: TestIR;
  testCase?: TestCase;
  designRun?: string;
  /** evidence id → source text (document sections, decisions). */
  evidenceText: Map<string, string>;
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8')) as unknown;

/** Story key from a case id: TC-SF-219-007 → SF-219. */
export const storyOf = (caseId: string): string | undefined => /^TC-([A-Z][A-Z0-9]*-\d+)-\d+$/.exec(caseId)?.[1];

const Section = z.object({ ref: z.string(), text: z.string() });
const SourceDoc = z.object({ docId: z.string(), sections: z.array(Section).default([]) });

/** Index `<docId>#<ref>` → text from a design run's analysis/sources. */
function loadEvidenceText(root: string, designRun: string): Map<string, string> {
  const out = new Map<string, string>();
  const dir = join(root, 'runs', designRun, 'analysis', 'sources');
  if (!existsSync(dir)) return out;
  for (const f of readdirSafe(dir)) {
    if (!f.endsWith('.json')) continue;
    const doc = SourceDoc.safeParse(readJson(join(dir, f)));
    if (!doc.success) continue;
    for (const s of doc.data.sections) out.set(`${doc.data.docId}#${s.ref}`, s.text);
  }
  return out;
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function loadCaseContext(root: string, caseId: string): CaseContext {
  const storyKey = storyOf(caseId);
  const ctx: CaseContext = { caseId, ...(storyKey ? { storyKey } : {}), evidenceText: new Map() };
  if (!storyKey) return ctx;
  const mf = join(root, 'tests', 'generated', storyKey, 'manifest.json');
  if (!existsSync(mf)) return ctx;
  const manifest = StoryManifest.safeParse(readJson(mf));
  if (!manifest.success) return ctx;
  const artifact = manifest.data.artifacts.find((a) => a.kind === 'spec' && a.testCaseIds.includes(caseId));
  if (artifact) ctx.artifact = artifact;
  const buildRun = artifact?.buildRun ?? manifest.data.buildRun;
  const irFile = buildRun ? join(root, 'runs', buildRun, 'build', 'ir', `${caseId}.json`) : undefined;
  if (irFile && existsSync(irFile)) {
    const ir = TestIR.safeParse(readJson(irFile));
    if (ir.success) ctx.ir = ir.data;
  }
  const designRun = manifest.data.designRun;
  if (!designRun) return ctx;
  ctx.designRun = designRun;
  const tcFile = join(root, 'runs', designRun, 'design', 'test-cases.json');
  if (existsSync(tcFile)) {
    const raw = readJson(tcFile);
    const list: unknown[] = Array.isArray(raw)
      ? (raw as unknown[])
      : ((raw as { testCases?: unknown[] }).testCases ?? []);
    const found = list.find((t) => (t as { id?: string }).id === caseId);
    const tc = found ? TestCase.safeParse(found) : undefined;
    if (tc?.success) ctx.testCase = tc.data;
  }
  ctx.evidenceText = loadEvidenceText(root, designRun);
  // Operator decisions recorded with the case edits (examples/case-edits/<story>.yaml), e.g. BR-08's positive case.
  const ce = join(root, 'examples', 'case-edits', `${storyKey}.yaml`);
  if (existsSync(ce)) {
    try {
      for (const d of loadCaseEdits(ce).decisions) ctx.evidenceText.set(caseEditEvidenceId(storyKey, d.id), d.text);
    } catch {
      /* an invalid edits file is reported by qa build, not here */
    }
  }
  return ctx;
}

/** Case step index from a Playwright step title ("2. Enter …" → 1). */
export function caseStepOfTitle(title: string | undefined, ir?: TestIR): number | undefined {
  if (!title) return undefined;
  const byIr = ir?.steps.find((s) => title.startsWith(s.title.slice(0, 40)));
  if (byIr) return byIr.caseStep;
  const m = /^(\d+)\.\s/.exec(title);
  return m?.[1] ? Number(m[1]) - 1 : undefined;
}

/** IR checks a Playwright matcher / Lightning helper can implement (run-p7-fx-base-2: map by what failed, not by order). */
const HELPER_CHECKS: Record<string, IrAssertion['check'][]> = {
  expectSavePopover: ['saveWarning'],
  expectToast: ['toast', 'recordView'],
  expectFieldError: ['fieldError'],
  expectRecordTitle: ['recordTitle', 'recordView'],
  recordIdFromView: ['recordView'],
};
const MATCHER_CHECKS: [RegExp, IrAssertion['check'][]][] = [
  [/\.toHaveURL\(/, ['recordView']],
  [/\.(?:toContainText|toHaveText)\(/, ['recordField', 'recordTitle', 'toast', 'relatedListHasRecord', 'fieldError']],
  [/\.toBeHidden\(/, ['hidden']],
  [/\.toHaveValue\(/, ['inputValue']],
  [/\.toBeVisible\(/, ['visible', 'relatedListHasRecord', 'fieldError', 'recordView']],
  [/expect\.poll|\.toBe\(|\.toEqual\(/, ['soqlField', 'soqlNoRecord', 'historyTracked', 'apiRejects']],
];

/** Candidate IR checks for a failure, from the helper in the stack or the matcher in the error's first line. */
export function checksOfFailure(message: string): IrAssertion['check'][] | undefined {
  const helper = /\bat (expect\w+|recordIdFromView) \(/.exec(message)?.[1];
  if (helper && HELPER_CHECKS[helper]) return HELPER_CHECKS[helper];
  const first = message.split('\n').find((l) => l.trim()) ?? '';
  return MATCHER_CHECKS.find(([re]) => re.test(first))?.[1];
}

/** The IR assertion a signal most likely refers to (within the failed step). */
export function failedAssertion(
  ctx: CaseContext,
  r: TestResult,
  signals: readonly FailureSignal[],
): { assertion: IrAssertion; caseStep: number } | undefined {
  if (!ctx.ir) return undefined;
  const stepTitle =
    signals.find((s) => s.step)?.step ??
    r.failure?.steps.find((s) => !s.ok)?.title ??
    r.failure?.attempts[0]?.failedStep;
  const topStep = r.failure?.steps.find((s) => !s.ok)?.title ?? stepTitle;
  const caseStep = caseStepOfTitle(topStep, ctx.ir);
  const kinds = new Set(signals.map((s) => s.kind));
  const message = r.failure?.attempts[r.failure.attempts.length - 1]?.message ?? r.errorSummary ?? r.reason ?? '';
  const checks = checksOfFailure(message) ?? (kinds.has('URL_MISMATCH') ? ['recordView' as const] : undefined);
  // No step info (Phase 5 results): the first step holding an assertion of the kind the failure names.
  const byCheck = checks ? ctx.ir.steps.find((s) => s.assertions.some((x) => checks.includes(x.check))) : undefined;
  const step = ctx.ir.steps.find((s) => s.caseStep === caseStep) ?? byCheck ?? ctx.ir.steps[ctx.ir.steps.length - 1];
  if (!step) return undefined;
  const pick = (pred: (a: IrAssertion) => boolean): IrAssertion | undefined => step.assertions.find(pred);
  // In order of the candidate list (the helper / matcher's most specific check first).
  let a: IrAssertion | undefined;
  for (const c of checks ?? []) {
    a = pick((x) => x.check === c);
    if (a) break;
  }
  if (!a && (kinds.has('LOCATOR_NOT_FOUND') || kinds.has('LOCATOR_NOT_UNIQUE'))) a = pick((x) => x.check === 'visible');
  a ??= step.assertions[0];
  return a ? { assertion: a, caseStep: step.caseStep } : undefined;
}

/** Words that state a navigation / page outcome. */
// "an error is shown" is not a navigation statement (AC5, inv-p7-offline-1): only page / navigation words count.
const NAVIGATION_CLAIM =
  /\b(opens?|opened|navigat\w*|redirect\w*|lands? on|taken to|detail page|record page|page (?:shows|opens|is displayed))\b/i;
/** Evidence ids of org configuration facts: they describe rules and fields, never which page opens. */
const CONFIG_EVIDENCE = /^(ValidationRule|Field|Flow|Layout|FlexiPage|DuplicateRule|SObject):|^OC-\d+/;

export interface ClaimSupport {
  status: 'supported' | 'unsupported' | 'unknown';
  detail: string;
}

/**
 * Does any cited source state the behaviour the assertion checks? Navigation checks need a navigation statement;
 * value checks need the expected value in the cited text. `unknown` when a cited document ref cannot be resolved.
 */
export function claimSupport(ctx: CaseContext, assertion: IrAssertion): ClaimSupport {
  const ids = assertion.expect.evidenceIds;
  if (!ids.length) return { status: 'unsupported', detail: 'no evidence cited' };
  const texts = ids.map((id) => ctx.evidenceText.get(id)).filter((t): t is string => typeof t === 'string');
  const all = texts.join('\n');
  const unresolved = ids.filter((id) => !ctx.evidenceText.has(id) && !CONFIG_EVIDENCE.test(id));
  if (assertion.check === 'recordView' || assertion.check === 'recordTitle') {
    if (NAVIGATION_CLAIM.test(all)) return { status: 'supported', detail: `stated by ${ids.join(', ')}` };
    if (unresolved.length) return { status: 'unknown', detail: `cannot resolve ${unresolved.join(', ')}` };
    return {
      status: 'unsupported',
      detail: `${ids.join(', ')} do not say which page opens after the action (the check expects the ${
        assertion.check === 'recordView' ? assertion.object : 'record'
      } page)`,
    };
  }
  const ref = 'equals' in assertion ? assertion.equals : 'contains' in assertion ? assertion.contains : undefined;
  const lit = ref?.kind === 'literal' ? ref.value : undefined;
  if (lit === undefined) {
    return texts.length
      ? { status: 'supported', detail: `stated by ${ids.join(', ')}` }
      : { status: 'unknown', detail: `cannot resolve ${ids.join(', ')}` };
  }
  if (all.includes(lit)) return { status: 'supported', detail: `value "${lit}" in ${ids.join(', ')}` };
  if (unresolved.length)
    return {
      status: 'unknown',
      detail: `value "${lit}" not in the resolved sources; cannot resolve ${unresolved.join(', ')}`,
    };
  return { status: 'unsupported', detail: `expected value "${lit}" is not in ${ids.join(', ')}` };
}
