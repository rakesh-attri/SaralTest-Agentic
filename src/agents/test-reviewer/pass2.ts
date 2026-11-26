// Test Reviewer pass 2 (PLAN.md §3, Phase 4): reviews the GENERATED code against the reviewed cases.
// Deterministic checklist (re-run every round) + a judge (role `judge`, ≠ coder) on "test matches case, assertions
// not weakened". Every spec ends APPROVED / REVIEW_REQUIRED / BLOCKED with reasons; nothing stays OPEN.
import ts from 'typescript';
import type { Logger } from 'pino';
import { QAError } from '../../core/errors.js';
import type { ReviewFinding } from '../../core/schemas/design.js';
import type { DryRunReport, GeneratedArtifact, TestIR } from '../../core/schemas/generation.js';
import { isAutomatable, type ReviewStatus, type TestCase } from '../../core/schemas/testCase.js';
import type { ModelRouter } from '../../models/router.js';
import type { Redactor } from '../../security/redact.js';
import type { SkillLoader } from '../../skills/skillLoader.js';
import { fieldErrorRule, irProblems, type GenerationContext } from '../test-generator/context.js';
import type { GeneratedSpec } from '../test-generator/graph.js';
import { findMember } from '../test-generator/pageObjects.js';
import type { ObservedMessage } from '../../core/schemas/execution.js';
import { A11Y_SCOPE_NOTE, AFTER_SAVE_NOTE } from '../test-generator/render.js';
import type { ToolchainResult } from '../test-generator/toolchain.js';
import { runStructured } from '../shared/structured.js';
import type { FindingDraft } from './rules.js';
import { JudgeOutput, JudgeVerifyOutput } from './schema.js';

export const PASS2_SKILLS = ['playwright-standards', 'salesforce-lightning-locators', 'test-design'] as const;
export const MAX_PASS2_ROUNDS = 2;

/** Rules whose open findings mean the test cannot run at all → BLOCKED. */
const BLOCKING = new Set([
  'spec-missing',
  'typecheck',
  'lint',
  'not-listed',
  'locator-unresolved',
  'persona-unavailable',
  'data-binding',
  'ast-violation',
  'dynamic-assertion',
]);
/** Only high-severity findings of blocking rules block (e.g. "no dry-run yet" is M: review, not block). */
const isBlocking = (f: Pick<ReviewFinding, 'rule' | 'severity'>): boolean => BLOCKING.has(f.rule) && f.severity === 'H';

/** Rules the generator can fix by regenerating the case. */
const REGENERABLE = new Set([
  'step-missing',
  'assertion-missing',
  'assertion-unreferenced',
  'assertion-not-assertable',
  'ungrounded-value',
  'meta-incomplete',
  'raw-locator',
  'ast-violation',
  'dynamic-assertion',
  'typecheck',
  'lint',
  'not-listed',
  'judge',
]);

export interface Pass2Input {
  ctx: GenerationContext;
  cases: readonly TestCase[];
  specs: readonly GeneratedSpec[];
  toolchain?: ToolchainResult;
  dryRun?: DryRunReport;
  /** One dry-run per persona (qa review --pass 2): each case is checked against its own persona's dry-run. */
  dryRuns?: DryRunReport[];
  prior: readonly ReviewFinding[];
  round: number;
  mode: 'llm' | 'mechanical';
  /**
   * A judge outage (TRANSIENT after the router's own failover) degrades this round instead of failing it. The graph
   * node leaves this off so the QA Lead retries the node; `qa review --pass 2` sets it (no retry loop there).
   */
  transientDegrades?: boolean;
  /**
   * Waits between retries of one spec's judge call after a TRANSIENT outage (run-p5-build-1/2: one call for all 7
   * specs timed out at 120 s every time — the judge now reviews one spec per call and retries only that spec).
   */
  judgeRetryMs?: readonly number[];
}

export interface Pass2Deps {
  router?: ModelRouter;
  skills?: SkillLoader;
  redactor?: Redactor;
  logger?: Logger;
  /** Progress lines (a judge retry, a spec the judge could not review). */
  say?: (msg: string) => void;
}

const classify = (msg: string): ReviewFinding['rule'] => {
  if (/has no IR step|caseStep .* does not exist/.test(msg)) return 'step-missing';
  if (/has no assertion/.test(msg)) return 'assertion-missing';
  if (/not assertable/.test(msg)) return 'assertion-not-assertable';
  if (/evidence .* is not cited|expect\.caseStep/.test(msg)) return 'assertion-unreferenced';
  if (/literal|length .* is not stated|derivable|never invent/.test(msg)) return 'ungrounded-value';
  if (/page-object member|has role/.test(msg)) return 'raw-locator';
  if (/recipe|data |created|adopt/.test(msg)) return 'data-binding';
  return 'assertion-missing';
};

/** AST checks on a spec (playwright-standards Rules): no expect under a condition, no sleeps, no raw fetch/locators. */
export function astViolations(text: string): { rule: ReviewFinding['rule']; text: string }[] {
  const sf = ts.createSourceFile('spec.ts', text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const out: { rule: ReviewFinding['rule']; text: string }[] = [];
  const at = (n: ts.Node): string => `line ${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const visit = (n: ts.Node, conditional: boolean): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf);
      if (conditional && /^expect\b/.test(callee)) {
        out.push({ rule: 'ast-violation', text: `${at(n)}: assertion inside a condition (may be skipped)` });
      }
      if (/\.waitForTimeout$/.test(callee) || callee === 'setTimeout') {
        out.push({ rule: 'ast-violation', text: `${at(n)}: fixed sleep (${callee})` });
      }
      if (callee === 'fetch') out.push({ rule: 'ast-violation', text: `${at(n)}: raw fetch` });
      if (/^test\.(only|skip)$|^test\.describe\.(only|skip)$/.test(callee)) {
        out.push({ rule: 'ast-violation', text: `${at(n)}: ${callee} must not be generated` });
      }
      // Operator rule 2026-11-26: never assert on URLs or record ids (dynamic).
      if (/\.toHaveURL$/.test(callee) || /(^|\.)url$/.test(callee)) {
        out.push({
          rule: 'dynamic-assertion',
          text: `${at(n)}: URL check (${callee}) — URLs are dynamic; assert toast, related list, header and SOQL by run tag`,
        });
      }
      if (/(^|\.)(recordIdFromView|adoptCreated)$/.test(callee)) {
        out.push({
          rule: 'dynamic-assertion',
          text: `${at(n)}: ${callee} reads the record id from the URL — find the saved record by its run-unique name and the run tag`,
        });
      }
      if (/^expect\b.*\.(toBe|toEqual|toStrictEqual|toHaveValue|toContainText)$/.test(callee)) {
        const arg = n.arguments.map((x) => x.getText(sf)).join(', ');
        if (/\bdata\.id\(|\bviewed\[|\brecordId\b/.test(arg))
          out.push({
            rule: 'dynamic-assertion',
            text: `${at(n)}: compares a record id (${arg}) — compare names / values instead`,
          });
      }
    }
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isRegularExpressionLiteral(n)) {
      const t = n.getText(sf);
      if (/\/lightning\/r\/|lightning\\\/r\\\//.test(t))
        out.push({ rule: 'dynamic-assertion', text: `${at(n)}: record URL in a test (${t.slice(0, 60)})` });
      const v = ts.isRegularExpressionLiteral(n) ? '' : n.text;
      if (/^(0[0-9A-Za-z]{2}|a0[0-9A-Za-z])[0-9A-Za-z]{12}([0-9A-Za-z]{3})?$/.test(v) && /\d{3}/.test(v))
        out.push({ rule: 'dynamic-assertion', text: `${at(n)}: hard-coded record id '${v}'` });
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf);
      if (/^page\.(getBy\w+|locator|\$\$?)$/.test(callee)) {
        out.push({ rule: 'raw-locator', text: `${at(n)}: raw locator ${callee}(…) in a test — use a page object` });
      }
    }
    const cond =
      conditional ||
      ts.isIfStatement(n) ||
      ts.isConditionalExpression(n) ||
      (ts.isBinaryExpression(n) &&
        (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          n.operatorToken.kind === ts.SyntaxKind.BarBarToken)) ||
      ts.isCatchClause(n);
    ts.forEachChild(n, (c) => {
      visit(c, cond);
    });
  };
  visit(sf, false);
  return out;
}

const EXPECTS_MESSAGE =
  /\b(?:error|validation|warning)\s+message\b|\bmessage\b.*\b(?:displayed|shown)\b|\b(?:error|warning)\s+'[^']+'|\b(?:error|warning)\b[^.;]*\b(?:indicating|stating|saying)\b/i;

/** Case steps (0-based) that expect an error / warning message but assert no org-evidenced message text. */
export function unevidencedMessageSteps(tc: TestCase, ir: TestIR): number[] {
  const out: number[] = [];
  tc.steps.forEach((st, n) => {
    if (!EXPECTS_MESSAGE.test(st.expected.text)) return;
    const errs = ir.steps
      .filter((x) => x.caseStep === n)
      .flatMap((x) => x.assertions)
      .filter((a) => a.check === 'fieldError' || a.check === 'saveWarning');
    // A message is evidenced by a field error whose text comes from an org validation rule or an accepted observed
    // message, or by a save warning (accepted observed alert text).
    if (!errs.some((a) => a.check === 'saveWarning' || a.message)) out.push(n);
  });
  return out;
}

/**
 * Observed messages (Explorer, OBSERVED) that evidence the message a case step expects: messages on the fields the
 * step's field-error assertions check; for a duplicate warning, the duplicate alert of the step's object.
 */
export function observedForStep(
  tc: TestCase,
  ir: TestIR,
  n: number,
  ctx: GenerationContext,
): NonNullable<GenerationContext['observedMessages']> {
  const all = ctx.observedMessages ?? [];
  if (!all.length) return [];
  const asserts = ir.steps.filter((x) => x.caseStep === n).flatMap((x) => x.assertions);
  const fields = new Set(
    asserts
      .filter((a) => a.check === 'fieldError')
      .map((a) => findMember(ctx.catalog, a.element)?.member.fieldApiName)
      .filter((f): f is string => typeof f === 'string'),
  );
  const text = tc.steps[n]?.expected.text ?? '';
  // What the step expects decides which observation can evidence it. A maximum-length message was looked for and
  // not found (qa-prod truncates the input at the field length), so it is never evidenced by another message.
  const kind: ObservedMessage['kind'] | 'length' | undefined = /duplicate/i.test(text)
    ? 'duplicate'
    : /\b(?:length|maximum|characters?|too long|exceed)/i.test(text)
      ? 'length'
      : /\b(?:required|empty|blank|missing)\b/i.test(text)
        ? 'required'
        : /\b(?:invalid|format|valid)\b/i.test(text)
          ? 'validation'
          : undefined;
  if (kind === 'length') return [];
  return all.filter(
    (m) =>
      (m.persona === tc.persona || m.persona === 'system-admin') &&
      (kind === 'duplicate'
        ? m.kind === 'duplicate'
        : m.field !== undefined && fields.has(m.field) && m.kind !== 'duplicate' && (!kind || m.kind === kind)),
  );
}

/**
 * Steps whose expected result quotes a message ('…' or "…") while the spec asserts a rule message that is none of
 * the quotes — the case and the org disagree (e.g. the org rule changed after design).
 */
export function messageMismatches(tc: TestCase, ir: TestIR, ctx: GenerationContext): { step: number; text: string }[] {
  const out: { step: number; text: string }[] = [];
  for (const st of ir.steps) {
    const exp = tc.steps[st.caseStep]?.expected.text ?? '';
    const quotes = [...exp.matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2] ?? '');
    if (!quotes.length) continue;
    for (const a of st.assertions) {
      if (a.check !== 'fieldError' || !a.message || !('rule' in a.message)) continue;
      const r = fieldErrorRule(ctx, a.element, a.message.rule);
      if ('message' in r && !quotes.includes(r.message))
        out.push({
          step: st.caseStep,
          text: `step ${String(st.caseStep + 1)} quotes ${quotes.map((q) => `"${q}"`).join(', ')} but ${r.rule} says "${r.message}" in the org snapshot — update the case (qa build refreshes quoted rule messages)`,
        });
    }
  }
  return out;
}

/** The dry-run that verifies a case: its own persona's when one ran, else the single dry-run of the build. */
const dryFor = (i: Pick<Pass2Input, 'dryRun' | 'dryRuns'>, persona: string): DryRunReport | undefined =>
  i.dryRuns?.find((d) => d.persona === persona) ?? i.dryRun ?? i.dryRuns?.[0];

/** Pass-2 deterministic checklist; pure function of the current specs + tool results. */
export function pass2Findings(i: Omit<Pass2Input, 'prior' | 'round' | 'mode'>): (FindingDraft & { paths: string[] })[] {
  const out: (FindingDraft & { paths: string[] })[] = [];
  const add = (
    f: Omit<FindingDraft, 'refs' | 'requirementIds'> & { paths: string[]; requirementIds?: string[] },
  ): void => {
    out.push({ refs: [], requirementIds: [], ...f });
  };
  for (const tc of i.cases.filter(isAutomatable)) {
    const spec = i.specs.find((s) => s.caseId === tc.id);
    const req = tc.requirementIds;
    if (!spec) {
      add({
        key: `spec-missing:${tc.id}`,
        severity: 'H',
        rule: 'spec-missing',
        caseIds: [tc.id],
        requirementIds: req,
        paths: [],
        text: `APPROVED case ${tc.id} has no generated spec`,
      });
      continue;
    }
    const base = { caseIds: [tc.id], requirementIds: req, paths: [spec.path] };
    if (spec.artifact.origin === 'mechanical') {
      add({
        ...base,
        key: `mechanical:${tc.id}`,
        severity: 'M',
        rule: 'mechanical',
        text: `mechanical skeleton (test.fixme): ${spec.degradedReason ?? 'no model'} — a human must implement it`,
      });
      continue;
    }
    if (!i.ctx.personas.includes(tc.persona)) {
      add({
        ...base,
        key: `persona:${tc.id}`,
        severity: 'H',
        rule: 'persona-unavailable',
        text: `persona ${tc.persona} has no configured test user (BLOCKED-NO-PERSONA)`,
      });
    }
    // The IR is re-checked every round (same rules the generator reflected on).
    if (spec.ir) {
      const recipe = i.ctx.recipes.find((r) => spec.artifact.dataBindings.includes(r.name));
      for (const msg of irProblems(tc, spec.ir, i.ctx, recipe ?? i.ctx.recipes[0])) {
        add({ ...base, key: `ir:${tc.id}:${msg}`, severity: 'H', rule: classify(msg), text: msg });
      }
      // Expected error text needs org evidence (a validation rule's message). A step whose expected result names an
      // error message but whose fieldError has none stays with a human (operator 2026-11-26: never invent text).
      for (const mm of messageMismatches(tc, spec.ir, i.ctx)) {
        add({
          ...base,
          key: `msg-mismatch:${tc.id}:${mm.text}`,
          severity: 'M',
          rule: 'message-mismatch',
          text: mm.text,
        });
      }
      for (const n of unevidencedMessageSteps(tc, spec.ir)) {
        const seen = observedForStep(tc, spec.ir, n, i.ctx);
        if (seen.length) {
          add({
            ...base,
            key: `msg-obs:${tc.id}:${String(n)}`,
            severity: 'M',
            rule: 'message-unasserted',
            text: `step ${String(n + 1)}: the message is now evidenced by UI observation — ${seen.map((m) => `[${m.placement}] "${m.text}" (OBSERVED ${m.observedAt.slice(0, 10)}, ${m.runId})`).join('; ')} — but the spec does not assert it${seen.some((m) => m.kind === 'duplicate') ? '' : ' (it checks only that the field is invalid)'}. A human accepts the observed text, then regenerate the spec (qa build --cases ${tc.id}) so it asserts it`,
          });
        } else {
          add({
            ...base,
            key: `msg:${tc.id}:${String(n)}`,
            severity: 'M',
            rule: 'message-unevidenced',
            text: `step ${String(n + 1)} expects an error message, but the org has no evidence for its text (no validation rule shows it on that field; the standard Salesforce message is not captured) — the test asserts only that the field is invalid`,
          });
        }
      }
      for (const b of spec.artifact.dataBindings) {
        const r = i.ctx.recipes.find((x) => x.name === b);
        if (!r || !r.plan.valid) {
          add({
            ...base,
            key: `data:${tc.id}:${b}`,
            severity: 'H',
            rule: 'data-binding',
            text: `recipe ${b} is ${r ? 'invalid against the snapshot' : 'not approved / not found'}`,
          });
        }
      }
    }
    // meta() + tags (playwright-standards Rules).
    for (const k of ['priority', 'severity', 'feature', 'story', 'owner']) {
      if (!new RegExp(`meta\\(\\{[^}]*\\b${k}:`).test(spec.text)) {
        add({ ...base, key: `meta:${tc.id}:${k}`, severity: 'M', rule: 'meta-incomplete', text: `meta() has no ${k}` });
      }
    }
    for (const tag of [`@${tc.type}`, `@persona:${tc.persona}`]) {
      if (!spec.text.includes(`'${tag}'`) && !spec.text.includes(`"${tag}"`)) {
        add({
          ...base,
          key: `tag:${tc.id}:${tag}`,
          severity: 'M',
          rule: 'meta-incomplete',
          text: `tag ${tag} missing`,
        });
      }
    }
    tc.steps.forEach((_s, n) => {
      if (spec.ir && !spec.ir.steps.some((st) => st.caseStep === n)) return; // reported by the IR check
      if (!/test\.step\(/.test(spec.text)) {
        add({ ...base, key: `step:${tc.id}`, severity: 'H', rule: 'step-missing', text: 'no test.step in the spec' });
      }
    });
    for (const v of astViolations(spec.text))
      add({ ...base, key: `ast:${tc.id}:${v.text}`, severity: 'H', rule: v.rule, text: v.text });
    // Locators: catalog members only; RE_VERIFY members need a human; dry-run must resolve each.
    for (const ref of spec.artifact.locatorsUsed) {
      const m = findMember(i.ctx.catalog, ref);
      if (!m) {
        add({
          ...base,
          key: `loc:${tc.id}:${ref}`,
          severity: 'H',
          rule: 'raw-locator',
          text: `${ref} is not in the page catalog`,
        });
        continue;
      }
      if (m.member.status === 'RE_VERIFY') {
        add({
          ...base,
          key: `reverify:${tc.id}:${ref}`,
          severity: 'M',
          rule: 'locator-not-active',
          text: `${ref} is RE_VERIFY in the registry (the org changed since it was verified)`,
        });
      }
      const check = dryFor(i, tc.persona)?.checks.find((c) => c.element === ref);
      const dry = dryFor(i, tc.persona);
      if (dry && (!check || !check.ok)) {
        const pageError = dry.pageErrors.map((e) => `${e.page}: ${e.error}`).join('; ');
        add({
          ...base,
          key: `dry:${tc.id}:${ref}`,
          severity: 'H',
          rule: 'locator-unresolved',
          text: `${ref} did not resolve in the dry-run as ${dry.persona}${check ? ` (count ${check.count}, visible ${String(check.visible)}, enabled ${String(check.enabled)})` : ` (not checked${pageError ? `: ${pageError}` : ''})`}`,
        });
      }
    }
    // The dry-run verifies locators for one persona; a case run as another persona has unverified locators (the
    // persona may see a different layout or no button at all).
    const dryCase = dryFor(i, tc.persona);
    if (dryCase && dryCase.persona !== tc.persona && spec.artifact.locatorsUsed.length) {
      add({
        ...base,
        key: `dry-persona:${tc.id}`,
        severity: 'M',
        rule: 'locator-unresolved',
        text: `locators were dry-run as ${dryCase.persona}, not as the case persona ${tc.persona}: unverified for ${tc.persona}`,
      });
    }
    if (!dryCase) {
      add({
        ...base,
        key: `dry:${tc.id}:none`,
        severity: 'M',
        rule: 'locator-unresolved',
        text: 'no locator dry-run result for this review: locators are unverified',
      });
    }
    // Toolchain (typecheck / lint / list).
    if (i.toolchain) {
      for (const e of i.toolchain.typecheck[spec.path] ?? [])
        add({ ...base, key: `tsc:${tc.id}:${e}`, severity: 'H', rule: 'typecheck', text: `tsc ${e}` });
      for (const e of i.toolchain.lint[spec.path] ?? [])
        add({ ...base, key: `lint:${tc.id}:${e}`, severity: 'H', rule: 'lint', text: `eslint ${e}` });
      const listed = i.toolchain.listed[spec.path] ?? [];
      if (!listed.some((t) => t.startsWith(tc.id))) {
        add({
          ...base,
          key: `list:${tc.id}`,
          severity: 'H',
          rule: 'not-listed',
          text: 'playwright test --list did not list this test',
        });
      }
    }
  }
  return out;
}

const nextId = (fs: readonly ReviewFinding[]): string => {
  const n = fs.reduce((m, f) => Math.max(m, Number(f.id.slice(3)) || 0), 0) + 1;
  return `RF-${String(n).padStart(3, '0')}`;
};

export interface Pass2Result {
  findings: ReviewFinding[];
  environment: 'LIVE' | 'MOCK' | 'NONE';
  models: string[];
  judgeDegraded: boolean;
  /** Why the judge was unavailable (error kind + message), when degraded by an error. */
  judgeError?: { kind: string; message: string };
  /** Case ids the judge could not review (or verify) in this round — only these lose an APPROVED verdict. */
  unjudged: string[];
  /** Per case id: open findings the generator should fix by regenerating. */
  feedback: Record<string, string[]>;
}

/** One pass-2 round: deterministic recheck (+ resolve fixed ones), new findings, judge (round 1) / verify (later). */
export async function reviewPass2Round(i: Pass2Input, deps: Pass2Deps): Promise<Pass2Result> {
  const drafts = pass2Findings(i);
  const keys = new Set(drafts.map((d) => d.key));
  const findings: ReviewFinding[] = i.prior.map((f) =>
    f.status === 'OPEN' && f.origin === 'deterministic' && !keys.has(f.key)
      ? {
          ...f,
          status: 'RESOLVED' as const,
          resolvedBy: 'recheck' as const,
          resolution: `no longer reproduces in round ${i.round}`,
        }
      : { ...f },
  );
  for (const d of drafts) {
    if (findings.some((f) => f.key === d.key && f.status !== 'RESOLVED')) continue;
    findings.push({
      id: nextId(findings),
      key: d.key,
      round: i.round,
      severity: d.severity,
      rule: d.rule,
      caseIds: d.caseIds,
      requirementIds: d.requirementIds,
      refs: d.refs,
      text: d.text,
      origin: 'deterministic',
      status: 'OPEN',
      escalated: false,
      pass: 2,
      paths: d.paths,
    });
  }

  let environment: Pass2Result['environment'] = 'NONE';
  const models: string[] = [];
  let judgeDegraded = false;
  let judgeError: Pass2Result['judgeError'];
  const unjudged: string[] = [];
  const generated = i.specs.filter((s) => s.artifact.origin === 'generated');
  const router = deps.router;
  /** One judge call, retried after a TRANSIENT outage; undefined when the judge stayed unavailable for this spec. */
  const judged = async <T>(caseId: string, call: () => Promise<T>): Promise<T | undefined> => {
    const waits = i.judgeRetryMs ?? [];
    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (e) {
        const wait = waits[attempt];
        if (e instanceof QAError && e.kind === 'TRANSIENT' && wait !== undefined) {
          deps.say?.(
            `  judge unavailable for ${caseId} (${e.message.slice(0, 120)}) — retry ${String(attempt + 1)}/${String(waits.length)} in ${String(Math.round(wait / 1000))} s`,
          );
          await new Promise((res) => setTimeout(res, wait));
          continue;
        }
        const degradable =
          e instanceof QAError &&
          (e.kind === 'INVALID_LLM_OUTPUT' ||
            e.kind === 'TOOL_UNAVAILABLE' ||
            (e.kind === 'TRANSIENT' && i.transientDegrades === true));
        if (!degradable) throw e;
        deps.logger?.warn({ err: e.message, caseId }, 'pass 2 judge unavailable for this spec: deterministic only');
        deps.say?.(`  judge unavailable for ${caseId}: deterministic checks only for this spec`);
        unjudged.push(caseId);
        judgeError = { kind: e.kind, message: e.message };
        return undefined;
      }
    }
  };
  if (i.mode === 'llm' && router && generated.length) {
    if (i.round === 1) {
      // One spec per call: one call for all specs (7 specs, ~1,000 lines of test code) timed out at 120 s.
      for (const s of generated) {
        const tc = i.cases.find((c) => c.id === s.caseId);
        const r = await judged(s.caseId, () =>
          runStructured({
            router,
            role: 'judge',
            agent: 'test-reviewer:pass2',
            schema: JudgeOutput,
            system:
              'You are the Test Reviewer (pass 2). Compare the generated Playwright test with its reviewed test case. ' +
              'Report only real problems: an expected result not asserted, an assertion weaker than the expectation, an ' +
              'assertion the case does not expect, a step whose action differs from the case, data that does not match the ' +
              "case's preconditions. Deterministic checks (lint, types, locators, evidence) are done by code: do not repeat them. " +
              `Every finding's caseIds is ["${s.caseId}"]. Return an empty list when the test matches its case.\n\n` +
              'Operator scope rules (accepted decisions — never report them as findings): ' +
              A11Y_SCOPE_NOTE +
              ' The keyboard check (every field reachable by Tab, focus stays in the dialog, visual reading order) is the operator-mandated implementation of "reachable by keyboard".' +
              ' ' +
              AFTER_SAVE_NOTE,
            user: `### ${s.caseId}\nCase: ${JSON.stringify({ title: tc?.title, preconditions: tc?.preconditions, steps: tc?.steps.map((x) => ({ action: x.action, expected: x.expected.text })) })}\nTest:\n${s.text}`,
            ...(deps.skills ? { skills: { loader: deps.skills, names: PASS2_SKILLS } } : {}),
            check: (o) =>
              o.findings.flatMap((f) => f.caseIds.filter((id) => id !== s.caseId).map((id) => `unknown caseId ${id}`)),
            ...(deps.redactor ? { redactor: deps.redactor } : {}),
            ...(deps.logger ? { logger: deps.logger } : {}),
          }),
        );
        if (!r) continue;
        environment = r.environment;
        models.push(`judge=${r.model}${r.usedFallback ? ' (fallback)' : ''}`);
        for (const f of r.value.findings) {
          findings.push({
            id: nextId(findings),
            key: `judge2:${f.caseIds.join(',')}:${f.topic}`,
            round: i.round,
            severity: f.severity,
            rule: 'judge',
            caseIds: f.caseIds,
            requirementIds: f.requirementIds,
            refs: [],
            text: `${f.topic}: ${f.text}`,
            origin: 'judge',
            status: 'OPEN',
            escalated: false,
            pass: 2,
            paths: i.specs.filter((x) => f.caseIds.includes(x.caseId)).map((x) => x.path),
          });
        }
      }
    } else {
      const open = findings.filter((f) => f.origin === 'judge' && f.status === 'OPEN');
      for (const s of generated) {
        const mine = open.filter((f) => f.caseIds.includes(s.caseId));
        if (!mine.length) continue;
        const r = await judged(s.caseId, () =>
          runStructured({
            router,
            role: 'judge',
            agent: 'test-reviewer:pass2-verify',
            schema: JudgeVerifyOutput,
            system: 'Verify whether each of your earlier findings is resolved by the regenerated test. Be strict.',
            user: `${mine.map((f) => `${f.id} (${f.caseIds.join(', ')}): ${f.text}`).join('\n')}\n\nCurrent test:\n${s.text}`,
            check: (o) =>
              o.verdicts
                .filter((v) => !mine.some((f) => f.id === v.findingId))
                .map((v) => `unknown finding ${v.findingId}`),
            ...(deps.redactor ? { redactor: deps.redactor } : {}),
          }),
        );
        if (!r) continue;
        environment = r.environment;
        models.push(`judge=${r.model}${r.usedFallback ? ' (fallback)' : ''}`);
        for (const v of r.value.verdicts) {
          const f = findings.find((x) => x.id === v.findingId);
          if (f && v.resolved) Object.assign(f, { status: 'RESOLVED', resolvedBy: 'judge', resolution: v.reason });
        }
      }
    }
    judgeDegraded = unjudged.length > 0;
  } else if (i.mode === 'llm' && !deps.router) {
    judgeDegraded = true;
    unjudged.push(...generated.map((s) => s.caseId));
  }

  const feedback: Record<string, string[]> = {};
  for (const f of findings.filter((x) => x.status === 'OPEN' && REGENERABLE.has(x.rule))) {
    for (const c of f.caseIds) (feedback[c] ??= []).push(f.text);
  }
  return {
    findings,
    environment,
    models: [...new Set(models)],
    judgeDegraded,
    ...(judgeError ? { judgeError } : {}),
    unjudged,
    feedback,
  };
}

export interface SettlePass2Result {
  findings: ReviewFinding[];
  artifacts: GeneratedArtifact[];
}

/**
 * QA Lead settlement after the last pass-2 round: nothing stays OPEN. Blocking rules → the spec is BLOCKED;
 * everything else open → REVIEW_REQUIRED for a human (finding JUSTIFIED + escalated). Specs with no open finding,
 * generated by the model, with a resolved dry-run → APPROVED.
 */
/**
 * Without the judge nothing is APPROVED (the deterministic checks cannot judge "test matches the case"): APPROVED
 * artifacts become REVIEW_REQUIRED with the reason. With `unjudged`, only the specs of those cases (the judge
 * reviewed the others).
 */
export function withoutJudge(
  artifacts: readonly GeneratedArtifact[],
  unjudged?: readonly string[],
): GeneratedArtifact[] {
  return artifacts.map((a): GeneratedArtifact =>
    a.reviewStatus === 'APPROVED' && (!unjudged || a.testCaseIds.some((c) => unjudged.includes(c)))
      ? {
          ...a,
          reviewStatus: 'REVIEW_REQUIRED',
          reviewReasons: [
            ...a.reviewReasons,
            'judge unavailable: deterministic pass-2 checks only; re-run qa review --pass 2',
          ],
        }
      : a,
  );
}

export function settlePass2(findings: readonly ReviewFinding[], specs: readonly GeneratedSpec[]): SettlePass2Result {
  const out = findings.map((f) => ({ ...f }));
  for (const f of out) {
    if (f.status !== 'OPEN') continue;
    Object.assign(f, {
      status: 'JUSTIFIED',
      resolvedBy: 'qa-lead',
      escalated: true,
      resolution: isBlocking(f)
        ? 'not fixable by regeneration within the review rounds: the spec is BLOCKED until this is fixed'
        : 'needs a human decision: the spec is REVIEW_REQUIRED',
    });
  }
  const artifacts = specs.map((s): GeneratedArtifact => {
    const mine = out.filter((f) => f.escalated && f.caseIds.includes(s.caseId));
    const blocked = mine.filter((f) => isBlocking(f));
    const status: ReviewStatus = blocked.length
      ? 'BLOCKED'
      : mine.length || s.artifact.origin !== 'generated'
        ? 'REVIEW_REQUIRED'
        : 'APPROVED';
    const reasons = [...new Set([...s.artifact.reviewReasons, ...mine.map((f) => `${f.id} ${f.rule}: ${f.text}`)])];
    return { ...s.artifact, reviewStatus: status, reviewReasons: reasons };
  });
  return { findings: out, artifacts };
}
