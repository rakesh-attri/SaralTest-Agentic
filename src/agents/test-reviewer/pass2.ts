// Test Reviewer pass 2 (PLAN.md §3, Phase 4): reviews the GENERATED code against the reviewed cases.
// Deterministic checklist (re-run every round) + a judge (role `judge`, ≠ coder) on "test matches case, assertions
// not weakened". Every spec ends APPROVED / REVIEW_REQUIRED / BLOCKED with reasons; nothing stays OPEN.
import ts from 'typescript';
import type { Logger } from 'pino';
import { QAError } from '../../core/errors.js';
import type { ReviewFinding } from '../../core/schemas/design.js';
import type { DryRunReport, GeneratedArtifact } from '../../core/schemas/generation.js';
import type { ReviewStatus, TestCase } from '../../core/schemas/testCase.js';
import type { ModelRouter } from '../../models/router.js';
import type { Redactor } from '../../security/redact.js';
import type { SkillLoader } from '../../skills/skillLoader.js';
import { irProblems, type GenerationContext } from '../test-generator/context.js';
import type { GeneratedSpec } from '../test-generator/graph.js';
import { findMember } from '../test-generator/pageObjects.js';
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
  prior: readonly ReviewFinding[];
  round: number;
  mode: 'llm' | 'mechanical';
}

export interface Pass2Deps {
  router?: ModelRouter;
  skills?: SkillLoader;
  redactor?: Redactor;
  logger?: Logger;
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

/** Pass-2 deterministic checklist; pure function of the current specs + tool results. */
export function pass2Findings(i: Omit<Pass2Input, 'prior' | 'round' | 'mode'>): (FindingDraft & { paths: string[] })[] {
  const out: (FindingDraft & { paths: string[] })[] = [];
  const add = (
    f: Omit<FindingDraft, 'refs' | 'requirementIds'> & { paths: string[]; requirementIds?: string[] },
  ): void => {
    out.push({ refs: [], requirementIds: [], ...f });
  };
  for (const tc of i.cases.filter((c) => c.reviewStatus === 'APPROVED')) {
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
      if (!spec.text.includes(`'${tag}'`)) {
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
      const check = i.dryRun?.checks.find((c) => c.element === ref);
      if (i.dryRun && (!check || !check.ok)) {
        add({
          ...base,
          key: `dry:${tc.id}:${ref}`,
          severity: 'H',
          rule: 'locator-unresolved',
          text: `${ref} did not resolve in the dry-run${check ? ` (count ${check.count}, visible ${String(check.visible)}, enabled ${String(check.enabled)})` : ' (not checked)'}`,
        });
      }
    }
    if (!i.dryRun) {
      add({
        ...base,
        key: `dry:${tc.id}:none`,
        severity: 'M',
        rule: 'locator-unresolved',
        text: 'no locator dry-run for this build (offline): locators are unverified',
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
  const generated = i.specs.filter((s) => s.artifact.origin === 'generated');
  if (i.mode === 'llm' && deps.router && generated.length) {
    try {
      if (i.round === 1) {
        const r = await runStructured({
          router: deps.router,
          role: 'judge',
          agent: 'test-reviewer:pass2',
          schema: JudgeOutput,
          system:
            'You are the Test Reviewer (pass 2). For each generated Playwright test, compare it with its reviewed test case. ' +
            'Report only real problems: an expected result not asserted, an assertion weaker than the expectation, an ' +
            'assertion the case does not expect, a step whose action differs from the case, data that does not match the ' +
            "case's preconditions. Deterministic checks (lint, types, locators, evidence) are done by code: do not repeat them. " +
            'Return an empty list when the tests match their cases.',
          user: generated
            .map((s) => {
              const tc = i.cases.find((c) => c.id === s.caseId);
              return `### ${s.caseId}\nCase: ${JSON.stringify({ title: tc?.title, preconditions: tc?.preconditions, steps: tc?.steps.map((x) => ({ action: x.action, expected: x.expected.text })) })}\nTest:\n${s.text}`;
            })
            .join('\n\n'),
          ...(deps.skills ? { skills: { loader: deps.skills, names: PASS2_SKILLS } } : {}),
          check: (o) =>
            o.findings.flatMap((f) =>
              f.caseIds.filter((id) => !generated.some((s) => s.caseId === id)).map((id) => `unknown caseId ${id}`),
            ),
          ...(deps.redactor ? { redactor: deps.redactor } : {}),
          ...(deps.logger ? { logger: deps.logger } : {}),
        });
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
            paths: i.specs.filter((s) => f.caseIds.includes(s.caseId)).map((s) => s.path),
          });
        }
      } else {
        const open = findings.filter((f) => f.origin === 'judge' && f.status === 'OPEN');
        if (open.length) {
          const r = await runStructured({
            router: deps.router,
            role: 'judge',
            agent: 'test-reviewer:pass2-verify',
            schema: JudgeVerifyOutput,
            system: 'Verify whether each of your earlier findings is resolved by the regenerated tests. Be strict.',
            user:
              open.map((f) => `${f.id} (${f.caseIds.join(', ')}): ${f.text}`).join('\n') +
              '\n\nCurrent tests:\n' +
              generated
                .filter((s) => open.some((f) => f.caseIds.includes(s.caseId)))
                .map((s) => s.text)
                .join('\n\n'),
            check: (o) =>
              o.verdicts
                .filter((v) => !open.some((f) => f.id === v.findingId))
                .map((v) => `unknown finding ${v.findingId}`),
            ...(deps.redactor ? { redactor: deps.redactor } : {}),
          });
          environment = r.environment;
          models.push(`judge=${r.model}${r.usedFallback ? ' (fallback)' : ''}`);
          for (const v of r.value.verdicts) {
            const f = findings.find((x) => x.id === v.findingId);
            if (f && v.resolved) Object.assign(f, { status: 'RESOLVED', resolvedBy: 'judge', resolution: v.reason });
          }
        }
      }
    } catch (e) {
      if (!(e instanceof QAError) || (e.kind !== 'INVALID_LLM_OUTPUT' && e.kind !== 'TOOL_UNAVAILABLE')) throw e;
      judgeDegraded = true;
    }
  } else if (i.mode === 'llm' && !deps.router) {
    judgeDegraded = true;
  }

  const feedback: Record<string, string[]> = {};
  for (const f of findings.filter((x) => x.status === 'OPEN' && REGENERABLE.has(x.rule))) {
    for (const c of f.caseIds) (feedback[c] ??= []).push(f.text);
  }
  return { findings, environment, models, judgeDegraded, feedback };
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
