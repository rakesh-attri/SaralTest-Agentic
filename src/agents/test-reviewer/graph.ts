import { readFileSync } from 'node:fs';
import type { Logger } from 'pino';
import { QAError } from '../../core/errors.js';
import type { ReviewFinding, TestCase } from '../../core/schemas/index.js';
import type { ModelRouter } from '../../models/router.js';
import type { SkillLoader } from '../../skills/skillLoader.js';
import type { Redactor } from '../../security/redact.js';
import type { PlannerContext, DesignEnvironment } from '../test-planner/graph.js';
import { runStructured } from '../shared/structured.js';
import { deterministicFindings, judgeKey, type FindingDraft } from './rules.js';
import { JudgeOutput, JudgeVerifyOutput } from './schema.js';

export const TEST_REVIEWER_SKILLS = ['test-design', 'playwright-standards'] as const;
export const MAX_REVIEW_ROUNDS = 2;

function loadPrompts(): Record<string, string> {
  const text = readFileSync(new URL('./prompt.md', import.meta.url), 'utf8');
  const out: Record<string, string> = {};
  for (const part of text.split(/^## /m).slice(1)) {
    const nl = part.indexOf('\n');
    out[part.slice(0, nl).trim()] = part.slice(nl + 1).trim();
  }
  return out;
}

export interface ReviewerDeps {
  router?: ModelRouter;
  skills?: SkillLoader;
  redactor?: Redactor;
  logger?: Logger;
}

export interface ReviewInput {
  ctx: PlannerContext;
  cases: readonly TestCase[];
  /** Findings from earlier rounds (status carried forward). */
  prior: readonly ReviewFinding[];
  round: number;
  /** Planner justifications from the revise step. */
  justifications?: readonly { findingId: string; reason: string }[];
  mode: 'llm' | 'mechanical';
}

export interface ReviewResult {
  findings: ReviewFinding[];
  environment: DesignEnvironment;
  models: string[];
  /** The judge could not run (no model / invalid output): deterministic findings only. */
  judgeDegraded: boolean;
}

const nextId = (all: readonly ReviewFinding[]): string => {
  const max = all.reduce((m, f) => Math.max(m, Number(f.id.slice(3)) || 0), 0);
  return `RF-${String(max + 1).padStart(3, '0')}`;
};

/**
 * One Reviewer pass-1 round:
 * 1. planner justifications → JUSTIFIED (never for a deterministic H finding that still reproduces)
 * 2. deterministic recheck → earlier deterministic findings that no longer reproduce are RESOLVED, new ones OPEN
 * 3. judge: round 1 raises adversarial findings; later rounds only verify its open findings
 */
export async function reviewRound(i: ReviewInput, deps: ReviewerDeps): Promise<ReviewResult> {
  const findings: ReviewFinding[] = i.prior.map((f) => ({ ...f }));
  const just = new Map((i.justifications ?? []).map((j) => [j.findingId, j.reason]));
  const det = deterministicFindings(i.ctx, i.cases);
  const detKeys = new Set(det.map((d) => d.key));

  for (const f of findings) {
    if (f.status !== 'OPEN') continue;
    const reason = just.get(f.id);
    if (f.origin === 'deterministic' && !detKeys.has(f.key)) {
      Object.assign(f, {
        status: 'RESOLVED',
        resolvedBy: 'recheck',
        resolution: `no longer reproduced in round ${String(i.round)}`,
      });
    } else if (reason && !(f.origin === 'deterministic' && f.severity === 'H')) {
      Object.assign(f, { status: 'JUSTIFIED', resolvedBy: 'planner', resolution: reason });
    }
  }
  const add = (d: FindingDraft, origin: ReviewFinding['origin']): void => {
    if (findings.some((f) => f.key === d.key && f.status !== 'RESOLVED')) return;
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
      origin,
      status: 'OPEN',
      escalated: false,
    });
  };
  for (const d of det) add(d, 'deterministic');

  let environment: DesignEnvironment = 'NONE';
  const models: string[] = [];
  let judgeDegraded = false;
  if (i.mode === 'llm' && deps.router) {
    const prompts = loadPrompts();
    const caseIds = new Set(i.cases.map((c) => c.id));
    const reqIds = new Set(i.ctx.requirements.map((r) => r.id));
    const shared = {
      router: deps.router,
      role: 'judge' as const,
      ...(deps.skills ? { skills: { loader: deps.skills, names: TEST_REVIEWER_SKILLS } } : {}),
      ...(deps.redactor ? { redactor: deps.redactor } : {}),
      ...(deps.logger ? { logger: deps.logger } : {}),
    };
    try {
      if (i.round === 1) {
        const res = await runStructured({
          ...shared,
          agent: 'test-reviewer:judge',
          schema: JudgeOutput,
          system: prompts['judge'] ?? '',
          user: renderDesign(
            i.ctx,
            i.cases,
            findings.filter((f) => f.status === 'OPEN'),
          ),
          check: (out) => {
            const p: string[] = [];
            out.findings.forEach((f, n) => {
              for (const c of f.caseIds)
                if (!caseIds.has(c)) p.push(`finding ${String(n + 1)}: case ${c} does not exist`);
              for (const r of f.requirementIds)
                if (!reqIds.has(r)) p.push(`finding ${String(n + 1)}: requirement ${r} does not exist`);
              if (!f.caseIds.length && !f.requirementIds.length)
                p.push(`finding ${String(n + 1)}: cite at least one case or requirement id`);
            });
            return p;
          },
        });
        environment = res.environment;
        models.push(`judge=${res.model}${res.usedFallback ? ' (fallback)' : ''}`);
        for (const f of res.value.findings) {
          const reqs = f.requirementIds.length
            ? f.requirementIds
            : [...new Set(i.cases.filter((c) => f.caseIds.includes(c.id)).flatMap((c) => c.requirementIds))];
          add(
            {
              key: judgeKey({ ...f, requirementIds: reqs }),
              severity: f.severity,
              rule: 'judge',
              caseIds: f.caseIds,
              requirementIds: reqs,
              refs: [],
              text: `[${f.topic}] ${f.text}`,
            },
            'judge',
          );
        }
      } else {
        const open = findings.filter((f) => f.origin === 'judge' && f.status === 'OPEN');
        if (open.length) {
          const openIds = new Set(open.map((f) => f.id));
          const res = await runStructured({
            ...shared,
            agent: 'test-reviewer:verify',
            schema: JudgeVerifyOutput,
            system: prompts['verify'] ?? '',
            user: `FINDINGS TO VERIFY\n${open.map((f) => `${f.id} [${f.severity}] ${f.text} (cases ${f.caseIds.join(', ') || '—'})`).join('\n')}\n\n${renderDesign(i.ctx, i.cases, [])}`,
            check: (out) => {
              const p = out.verdicts
                .filter((v) => !openIds.has(v.findingId))
                .map((v) => `unknown finding ${v.findingId}`);
              const missing = [...openIds].filter((id) => !out.verdicts.some((v) => v.findingId === id));
              if (missing.length) p.push(`give a verdict for ${missing.join(', ')}`);
              return p;
            },
          });
          environment = res.environment;
          models.push(`judge=${res.model}${res.usedFallback ? ' (fallback)' : ''}`);
          for (const v of res.value.verdicts) {
            const f = findings.find((x) => x.id === v.findingId);
            if (f && v.resolved) Object.assign(f, { status: 'RESOLVED', resolvedBy: 'judge', resolution: v.reason });
          }
        }
      }
    } catch (e) {
      if (!(e instanceof QAError && e.kind === 'INVALID_LLM_OUTPUT')) throw e;
      judgeDegraded = true;
      deps.logger?.warn('judge output invalid; deterministic review only this round');
    }
  } else if (i.mode === 'llm') {
    judgeDegraded = true;
  }
  return { findings, environment, models, judgeDegraded };
}

function renderDesign(
  ctx: PlannerContext,
  cases: readonly TestCase[],
  alreadyRaised: readonly ReviewFinding[],
): string {
  const lines: string[] = ['REQUIREMENTS'];
  for (const r of ctx.requirements) {
    lines.push(
      `${r.id} (${r.type}, risk ${r.risk}, ${r.status}) [${ctx.index.sectionsOf(r).join(', ')}] ${r.title ?? ''}: ${r.businessObjective} | outcomes: ${r.expectedOutcomes.join('; ')}`,
    );
  }
  lines.push(
    '',
    'PERSONAS',
    ...ctx.personas.map((p) => `${p.id}: ${p.available ? 'test user available' : `NOT available — ${p.note}`}`),
  );
  lines.push('', `OUT OF SCOPE: ${ctx.outOfScope.join('; ') || '—'}`, '', 'CASES');
  for (const c of cases) {
    lines.push(
      `${c.id} [${c.persona} · ${c.type} · ${c.priority} · ${c.reviewStatus}] ${c.title} (requirements ${c.requirementIds.join(', ')})`,
    );
    c.steps.forEach((s, n) =>
      lines.push(
        `  ${String(n + 1)}. ${s.action} → ${s.expected.text} [${s.expected.evidenceLevel}: ${s.expected.evidenceIds.join(', ')}]`,
      ),
    );
  }
  if (alreadyRaised.length) {
    lines.push(
      '',
      'ALREADY RAISED BY DETERMINISTIC CHECKS (do not repeat)',
      ...alreadyRaised.map((f) => `${f.id} ${f.text}`),
    );
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ QA Lead settlement

export interface SettleResult {
  findings: ReviewFinding[];
  cases: TestCase[];
}

/**
 * After the last round the QA Lead settles every OPEN finding so nothing stays open (exit criterion):
 * - case-level finding → affected APPROVED cases become REVIEW_REQUIRED for a human; finding JUSTIFIED + escalated
 * - persona-unused for an unavailable persona → JUSTIFIED with the persona's recorded reason
 * - high-risk-uncovered → JUSTIFIED with the cases' own non-assertable reasons (evidence, not opinion)
 * - anything else → escalated: JUSTIFIED with "needs human decision", listed first in the report
 * Deterministic H findings are never waved through: they always escalate their cases.
 */
export function settleFindings(
  ctx: PlannerContext,
  findings: readonly ReviewFinding[],
  cases: readonly TestCase[],
): SettleResult {
  const outCases = cases.map((c) => ({ ...c, reviewReasons: [...c.reviewReasons] }));
  const out = findings.map((f) => ({ ...f }));
  for (const f of out) {
    if (f.status !== 'OPEN') continue;
    const persona = f.rule === 'persona-unused' ? ctx.personas.find((p) => f.key === `persona:${p.id}`) : undefined;
    if (persona && !persona.available) {
      Object.assign(f, {
        status: 'JUSTIFIED',
        resolvedBy: 'qa-lead',
        resolution: `persona has no usable test user: ${persona.note}. Cases that need it are BLOCKED-NO-PERSONA; default execution uses ${ctx.defaultPersona} (test-design skill).`,
      });
      continue;
    }
    if (f.rule === 'high-risk-uncovered') {
      Object.assign(f, {
        status: 'JUSTIFIED',
        resolvedBy: 'qa-lead',
        resolution:
          "cases exist but cannot be asserted until the recorded blockers are cleared (see the cases' review reasons); reported as a coverage risk in the test plan.",
      });
      continue;
    }
    const affected = outCases.filter((c) => f.caseIds.includes(c.id));
    for (const c of affected) {
      if (c.reviewStatus === 'APPROVED') c.reviewStatus = 'REVIEW_REQUIRED';
      c.reviewReasons.push(`unresolved reviewer finding ${f.id} (${f.rule}): ${f.text.slice(0, 160)}`);
    }
    Object.assign(f, {
      status: 'JUSTIFIED',
      resolvedBy: 'qa-lead',
      escalated: true,
      resolution: affected.length
        ? `not resolved after ${String(MAX_REVIEW_ROUNDS)} review rounds: ${affected.map((c) => c.id).join(', ')} set to REVIEW_REQUIRED for a human decision`
        : `not resolved after ${String(MAX_REVIEW_ROUNDS)} review rounds: needs a human decision (no case to hold back)`,
    });
  }
  return { findings: out, cases: outCases };
}
