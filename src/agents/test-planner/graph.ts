import { readFileSync } from 'node:fs';
import type { Logger } from 'pino';
import { QAError } from '../../core/errors.js';
import type {
  CoverageObligation,
  EvidenceEntry,
  ManualTestCase,
  RegressionTier,
  Requirement,
  ReviewFinding,
  RiskItem,
  RtmRow,
  TestCase,
  TestCharter,
  TestType,
} from '../../core/schemas/index.js';
import type { ModelRouter } from '../../models/router.js';
import type { SkillLoader } from '../../skills/skillLoader.js';
import type { Redactor } from '../../security/redact.js';
import {
  caseStatus,
  expectedFrom,
  groundingProblems,
  isVagueExpectation,
  type EvidenceIndex,
} from '../../oracles/index.js';
import type { ResolvedPersona } from '../impact-risk/personas.js';
import { findRefs } from '../../inputs/sections.js';
import { runStructured } from '../shared/structured.js';
import type { TestCaseIdStore } from './ids.js';
import { PlanOutput, ReviseOutput, type CaseDraft } from './schema.js';

type Priority = TestCase['priority'];
type Severity = TestCase['severity'];

export const TEST_PLANNER_SKILLS = ['test-design', 'salesforce-platform', 'salesforce-test-data'] as const;

function loadPrompts(): Record<string, string> {
  const text = readFileSync(new URL('./prompt.md', import.meta.url), 'utf8');
  const out: Record<string, string> = {};
  for (const part of text.split(/^## /m).slice(1)) {
    const nl = part.indexOf('\n');
    out[part.slice(0, nl).trim()] = part.slice(nl + 1).trim();
  }
  return out;
}
const fill = (tpl: string, vars: Record<string, string>): string =>
  tpl.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? '');

export interface PlannerContext {
  storyKey: string;
  storyTitle?: string;
  requirements: readonly Requirement[];
  obligations: readonly CoverageObligation[];
  risks: readonly RiskItem[];
  index: EvidenceIndex;
  manualTests: readonly ManualTestCase[];
  /** Charter personas (default first), with availability. */
  personas: readonly ResolvedPersona[];
  defaultPersona: string;
  snapshotId: string;
  outOfScope: readonly string[];
  /** Data recipe names that exist (examples/recipes). */
  recipes?: readonly string[];
}

export interface PlannerDeps {
  router?: ModelRouter;
  skills?: SkillLoader;
  redactor?: Redactor;
  logger?: Logger;
  ids: TestCaseIdStore;
  /** Obligations per model call (default 6: keeps replies small enough for the timeout). */
  batchSize?: number;
}

export type DesignEnvironment = 'LIVE' | 'MOCK' | 'NONE';

export interface PlanResult {
  charter: TestCharter;
  testCases: TestCase[];
  rtm: RtmRow[];
  evidence: EvidenceEntry[];
  environment: DesignEnvironment;
  models: string[];
  /** Obligation batches that fell back to mechanical drafting, with the reason. */
  degraded: { obligationIds: string[]; reason: string }[];
}

// ------------------------------------------------------------------ deterministic parts

const TIER_ORDER: Record<RegressionTier, number> = { mandatory: 0, recommended: 1, optional: 2 };
const SEVERITY: Record<Priority, Severity> = { P0: 'CRITICAL', P1: 'MAJOR', P2: 'MINOR', P3: 'TRIVIAL' };

/**
 * Priority (test-design skill): P0 = security/data exposure or a HIGH-risk core-flow AC; P1 = other HIGH risk;
 * P2 = MEDIUM; P3 = LOW/cosmetic. The highest across the case's requirements wins.
 */
export function priorityFor(reqs: readonly Requirement[], obligations: readonly CoverageObligation[]): Priority {
  const rank = (r: Requirement): number => {
    const ac = obligations.some((o) => o.requirementId === r.id && o.isAc);
    if (r.type === 'security' || r.type === 'data' || (r.risk === 'HIGH' && ac && r.type === 'functional')) return 0;
    if (r.risk === 'HIGH') return 1;
    return r.risk === 'MEDIUM' ? 2 : 3;
  };
  const best = Math.min(...reqs.map(rank), 3);
  return (['P0', 'P1', 'P2', 'P3'] as const)[best] ?? 'P3';
}

/**
 * Requirement-level review reasons that hold for every case built on the requirement: an unreviewed mechanical
 * interpretation, or no stated outcome. Other reasons are section-scoped and handled by the evidence index (an
 * ambiguity in one cited section does not block a case that only cites another, uncontested section).
 */
export function requirementReasons(
  index: EvidenceIndex,
  reqs: readonly Requirement[],
  citedSections: ReadonlySet<string>,
): string[] {
  const { findings = [], clarifications = [] } = index.input;
  const refsOf = (reason: string): string[] => {
    const raw: string[] = [];
    for (const m of reason.matchAll(/\b(F-[A-Z0-9-]+|Q\d+)\b/g)) {
      const id = m[1] ?? '';
      raw.push(
        ...(findings.find((f) => f.id === id)?.refs ?? []),
        ...(clarifications.find((c) => c.id === id)?.refs ?? []),
      );
    }
    if (!raw.length) raw.push(...findRefs(reason));
    return [...new Set(raw.map((x) => index.refs.resolve(x)).filter((x): x is string => x !== undefined))];
  };
  return reqs.flatMap((r) =>
    r.status !== 'REVIEW_REQUIRED'
      ? []
      : r.reviewReasons
          .filter((reason) => {
            const refs = refsOf(reason);
            // no refs → about the whole requirement (mechanical, no stated outcome) → blocks every case
            return !refs.length || refs.some((q) => citedSections.has(q));
          })
          .map((x) => `requirement ${r.id}: ${x}`),
  );
}

const obligationFp = (o: CoverageObligation): string =>
  `${o.requirementId}|${o.ref}|${o.kind}|${o.values.join(',')}|${o.evidenceIds[0] ?? ''}`;

/** Turn drafts into TestCases: code assigns ids, evidence levels, status, priority, tier, risks, tags. */
export function buildCases(
  ctx: PlannerContext,
  drafts: readonly CaseDraft[],
  origin: 'planned' | 'mechanical',
  ids: TestCaseIdStore,
  keep: Readonly<Record<string, string>> = {},
): TestCase[] {
  const obById = new Map(ctx.obligations.map((o) => [o.id, o]));
  return drafts.map((d) => {
    const obs = d.obligationIds.map((id) => obById.get(id)).filter((o): o is CoverageObligation => !!o);
    const reqIds = [...new Set(obs.map((o) => o.requirementId))];
    const reqs = ctx.requirements.filter((r) => reqIds.includes(r.id));
    const priority = priorityFor(reqs, obs);
    const stepReasons: string[] = [];
    const steps = d.steps.map((s) => {
      const must = obById.get(s.obligationId)?.mustCite ?? [];
      const { expected, decision } = expectedFrom(ctx.index, s.expected, [...new Set([...s.evidence, ...must])]);
      stepReasons.push(decision.reason);
      return { action: s.action, expected };
    });
    const persona = ctx.personas.find((p) => p.id === d.persona);
    const status = caseStatus({
      steps,
      stepReasons,
      personaAvailable: persona?.available ?? false,
      persona: d.persona,
      extraReasons: requirementReasons(
        ctx.index,
        reqs,
        new Set([
          ...steps.flatMap((s) => s.expected.evidenceIds),
          ...obs.flatMap((o) => (o.ref === '*' ? [] : [ctx.index.resolve(o.ref) ?? o.ref])),
        ]),
      ),
    });
    const tier = obs.map((o) => o.tier).sort((a, b) => TIER_ORDER[a] - TIER_ORDER[b])[0] ?? 'optional';
    const fp = `${obs.map(obligationFp).sort().join('||')}::${d.persona}`;
    const id = keep[d.key] ?? ids.idFor(fp);
    const reuse =
      d.manualTestId && obs.some((o) => o.manualTestIds.includes(d.manualTestId ?? '')) ? d.manualTestId : undefined;
    return {
      id,
      title: d.title,
      requirementIds: reqIds.length ? reqIds : [ctx.requirements[0]?.id ?? 'UNKNOWN'],
      riskIds: ctx.risks.filter((r) => r.requirementIds.some((x) => reqIds.includes(x))).map((r) => r.id),
      technique: d.technique,
      persona: d.persona,
      type: d.type,
      priority,
      severity: SEVERITY[priority],
      preconditions: d.preconditions,
      ...(d.dataRecipe ? { dataRecipe: d.dataRecipe } : {}),
      steps,
      tags: [`@${d.type}`, `@${priority}`, `@${ctx.storyKey}`, `@persona:${d.persona}`, `@${tier}`],
      reviewStatus: status.reviewStatus,
      reviewReasons: status.reviewReasons,
      snapshotId: ctx.snapshotId,
      origin: reuse ? 'manual-reuse' : origin,
      ...(reuse ? { manualTestId: reuse } : {}),
      refs: [...new Set(obs.map((o) => o.ref).filter((r) => r !== '*'))],
      obligationIds: obs.map((o) => o.id),
      regressionTier: tier,
    };
  });
}

/**
 * Mechanical normalisation of model drafts before checking: a step that cites nothing gets its obligation's full
 * allowed evidence (the level is then computed over all of it, so contested items still pull it down), and a data
 * recipe name that does not exist is dropped (recipes are optional). Neither changes what is asserted.
 */
export function normalizeDrafts(ctx: PlannerContext, drafts: readonly CaseDraft[]): CaseDraft[] {
  const obById = new Map(ctx.obligations.map((o) => [o.id, o]));
  return drafts.map((d) => {
    const { dataRecipe, ...rest } = d;
    const keepRecipe = dataRecipe !== undefined && (ctx.recipes ?? []).includes(dataRecipe);
    return {
      ...rest,
      ...(keepRecipe ? { dataRecipe } : {}),
      steps: d.steps.map((st) =>
        st.evidence.length ? st : { ...st, evidence: [...(obById.get(st.obligationId)?.evidenceIds ?? [])] },
      ),
    };
  });
}

/** Deterministic problems in model drafts (sent back to the model by runStructured). */
export function draftProblems(
  ctx: PlannerContext,
  drafts: readonly CaseDraft[],
  scope: readonly CoverageObligation[],
): string[] {
  const problems: string[] = [];
  const inScope = new Map(scope.map((o) => [o.id, o]));
  const all = new Map(ctx.obligations.map((o) => [o.id, o]));
  const personaIds = new Set(ctx.personas.map((p) => p.id));
  const covered = new Set<string>();
  const keys = new Set<string>();
  for (const d of drafts) {
    if (keys.has(d.key)) problems.push(`case key "${d.key}" is used twice`);
    keys.add(d.key);
    if (!personaIds.has(d.persona))
      problems.push(`${d.key}: persona "${d.persona}" is not one of ${[...personaIds].join(', ')}`);
    if (d.dataRecipe && !(ctx.recipes ?? []).includes(d.dataRecipe)) {
      problems.push(
        `${d.key}: data recipe "${d.dataRecipe}" does not exist (known: ${(ctx.recipes ?? []).join(', ') || 'none'}); omit it`,
      );
    }
    for (const id of d.obligationIds) {
      const o = all.get(id);
      if (!o) problems.push(`${d.key}: obligation ${id} does not exist`);
      else if (!inScope.has(id)) problems.push(`${d.key}: obligation ${id} is not in this batch`);
      else {
        covered.add(id);
        if (o.persona && o.persona !== d.persona) problems.push(`${d.key}: ${id} must run as persona "${o.persona}"`);
        const chosen = ctx.personas.find((p) => p.id === d.persona);
        if (!o.persona && chosen && !chosen.available && d.persona !== ctx.defaultPersona) {
          problems.push(
            `${d.key}: persona "${d.persona}" has no test user and ${id} does not require it — use "${ctx.defaultPersona}" (the missing persona is already recorded in the charter)`,
          );
        }
        if (!d.steps.some((s) => s.obligationId === id)) problems.push(`${d.key}: no step verifies ${id}`);
      }
    }
    if (d.manualTestId && !d.obligationIds.some((id) => all.get(id)?.manualTestIds.includes(d.manualTestId ?? ''))) {
      problems.push(`${d.key}: manual test ${d.manualTestId} is not listed on its obligations`);
    }
    d.steps.forEach((s, n) => {
      const where = `${d.key} step ${String(n + 1)}`;
      const o = all.get(s.obligationId);
      if (!o || !d.obligationIds.includes(s.obligationId)) {
        problems.push(`${where}: obligationId ${s.obligationId} is not one of the case's obligations`);
        return;
      }
      if (o.evidenceIds.length && !s.evidence.length) {
        problems.push(`${where}: cite at least one of ${o.id}'s allowed evidence ids (${o.evidenceIds.join(', ')})`);
      }
      for (const e of s.evidence) {
        const id = ctx.index.resolve(e);
        if (!id) problems.push(`${where}: evidence "${e}" does not exist`);
        else if (!o.evidenceIds.includes(id) && !o.mustCite.includes(id)) {
          problems.push(
            `${where}: evidence "${e}" is not allowed for ${o.id} (allowed: ${o.evidenceIds.join(', ') || 'none'})`,
          );
        }
      }
      for (const g of groundingProblems(ctx.index, s.expected, s.evidence, `${s.action} ${d.preconditions.join(' ')}`))
        problems.push(`${where}: ${g.message}`);
      if (isVagueExpectation(s.expected)) {
        problems.push(
          `${where}: expected "${s.expected}" is not observable — name the field value, message or record state`,
        );
      }
    });
  }
  const missing = scope.filter((o) => !covered.has(o.id)).map((o) => o.id);
  if (missing.length) problems.push(`not covered: ${missing.join(', ')} — every obligation needs at least one case`);
  return problems;
}

const KIND_TYPE: Record<CoverageObligation['kind'], TestType> = {
  positive: 'functional',
  negative: 'negative',
  boundary: 'negative',
  allow: 'security',
  deny: 'security',
  bulk: 'bulk',
  ui: 'ui',
  nfr: 'functional',
  regression: 'functional',
};
const KIND_TECHNIQUE: Record<CoverageObligation['kind'], string> = {
  positive: 'use case',
  negative: 'equivalence partitioning',
  boundary: 'boundary value analysis',
  allow: 'persona matrix',
  deny: 'persona matrix',
  bulk: 'bulk',
  ui: 'use case',
  nfr: 'use case',
  regression: 'regression (re-run of an existing test)',
};

function nfrType(text: string): TestType {
  if (/perform|load|seconds|response/i.test(text)) return 'perf';
  if (/accessib|wcag|screen reader|keyboard/i.test(text)) return 'a11y';
  return 'functional';
}

/**
 * Mechanical drafts (no model / invalid output): one case per obligation, expected text copied verbatim from the
 * strongest cited evidence, so nothing is invented. Labelled `mechanical`.
 */
export function mechanicalDrafts(ctx: PlannerContext, obligations: readonly CoverageObligation[]): CaseDraft[] {
  return obligations.map((o) => {
    const req = ctx.requirements.find((r) => r.id === o.requirementId);
    const ev = o.evidenceIds[0];
    const evText = ev ? (ctx.index.get(ev)?.text ?? '') : '';
    const manual = ctx.manualTests.find((t) => o.manualTestIds.includes(t.id));
    const action =
      o.kind === 'boundary'
        ? `${req?.actions[0] ?? o.detail} — run once per value: ${o.values.join(', ')}`
        : manual
          ? manual.steps.join('; ')
          : (req?.actions[0] ?? o.detail);
    return {
      key: o.id,
      title: o.detail.slice(0, 140),
      obligationIds: [o.id],
      persona: o.persona ?? ctx.defaultPersona,
      type: o.kind === 'nfr' ? nfrType(evText) : KIND_TYPE[o.kind],
      technique: KIND_TECHNIQUE[o.kind],
      preconditions: req?.preconditions ?? [],
      ...(manual ? { manualTestId: manual.id } : {}),
      steps: [
        {
          action: action || o.detail,
          expected: ev ? `As stated in ${ev}: ${evText}` : `No evidence available for ${o.detail}`,
          obligationId: o.id,
          evidence: ev ? [ev] : [],
        },
      ],
    };
  });
}

export function buildRtm(ctx: PlannerContext, cases: readonly TestCase[]): RtmRow[] {
  return ctx.requirements.map((r) => {
    const tcs = cases.filter((c) => c.requirementIds.includes(r.id));
    const obs = ctx.obligations.filter((o) => o.requirementId === r.id);
    const coveredObs = obs.filter((o) => tcs.some((c) => c.obligationIds.includes(o.id)));
    const status: RtmRow['status'] = !tcs.length
      ? 'gap'
      : tcs.every((c) => c.reviewStatus === 'BLOCKED')
        ? 'blocked'
        : tcs.some((c) => c.reviewStatus === 'APPROVED')
          ? 'designed'
          : 'review-required';
    return {
      requirementId: r.id,
      testCaseIds: tcs.map((c) => c.id),
      refs: [...new Set(ctx.index.sectionsOf(r).map((q) => q.split('#')[1] ?? q))],
      riskIds: ctx.risks.filter((k) => k.requirementIds.includes(r.id)).map((k) => k.id),
      types: [...new Set(tcs.map((c) => c.type))],
      manualTestIds: [...new Set(obs.flatMap((o) => o.manualTestIds))],
      status,
      coverage: { covered: coveredObs.length, total: obs.length },
    };
  });
}

export function buildCharter(
  ctx: PlannerContext,
  cases: readonly TestCase[],
  environment: TestCharter['environment'],
): TestCharter {
  const scope = [...new Set(ctx.requirements.flatMap((r) => ctx.index.sectionsOf(r)))];
  return {
    storyKey: ctx.storyKey,
    mission: `Verify ${ctx.storyTitle ?? ctx.storyKey}: every acceptance criterion and rule in scope, with evidence-backed expectations, against snapshot ${ctx.snapshotId}.`,
    scope,
    outOfScope: [...ctx.outOfScope],
    personas: ctx.personas.map((p) => ({ id: p.id, available: p.available, note: p.note })),
    risks: [...ctx.risks]
      .sort((a, b) => b.score - a.score)
      .map((r) => `${r.id} (${r.tier}, score ${String(r.score)}): ${r.desc}`),
    testTypes: [...new Set(cases.map((c) => c.type))],
    exitCriteria: [
      'Every story AC and in-scope rule has at least one test case (RTM coverage 100%)',
      'Every expectation carries an evidence level; only APPROVED_REQUIREMENT / DECLARED_CONFIG / VERIFIED become assertions',
      'Every Test Reviewer finding is resolved or justified',
      'Only APPROVED cases are generated and executed; REVIEW_REQUIRED and BLOCKED cases are reported with their reason',
    ],
    snapshotId: ctx.snapshotId,
    environment,
  };
}

// ------------------------------------------------------------------ model calls

function renderObligations(ctx: PlannerContext, obs: readonly CoverageObligation[]): string {
  const lines: string[] = [];
  for (const reqId of [...new Set(obs.map((o) => o.requirementId))]) {
    const r = ctx.requirements.find((x) => x.id === reqId);
    if (r) {
      lines.push(
        `REQUIREMENT ${r.id} (${r.type}, ${r.status}): ${r.title ?? ''} — ${r.businessObjective}`,
        `  preconditions: ${r.preconditions.join('; ') || '—'} | actions: ${r.actions.join('; ') || '—'} | outcomes: ${r.expectedOutcomes.join('; ') || '—'}`,
      );
    }
    for (const o of obs.filter((x) => x.requirementId === reqId)) {
      lines.push(
        `  ${o.id} [${o.ref} · ${o.kind} · ${o.tier} · reachable level ${o.level}] ${o.detail}${o.persona ? ` · persona ${o.persona}` : ''}${o.values.length ? ` · values ${o.values.join(', ')}` : ''}`,
      );
      for (const t of ctx.manualTests.filter((m) => o.manualTestIds.includes(m.id))) {
        lines.push(`    manual test ${t.id} "${t.title}": ${t.steps.join(' > ')} | expected: ${t.expected ?? '—'}`);
      }
      lines.push('    allowed evidence:');
      for (const id of o.evidenceIds) {
        const e = ctx.index.get(id);
        if (e) lines.push(`    - ${id} (${e.level}): ${e.text.slice(0, 400)}`);
      }
      if (!o.evidenceIds.length) lines.push('    - none (describe the outcome; the case will be REVIEW_REQUIRED)');
    }
    lines.push('');
  }
  return lines.join('\n');
}

const personaList = (ctx: PlannerContext): string =>
  ctx.personas.map((p) => `${p.id}${p.available ? '' : ' (no test user: cases will be BLOCKED)'}`).join(', ');

function batches(obs: readonly CoverageObligation[], size: number): CoverageObligation[][] {
  const out: CoverageObligation[][] = [];
  let cur: CoverageObligation[] = [];
  for (const reqId of [...new Set(obs.map((o) => o.requirementId))]) {
    const group = obs.filter((o) => o.requirementId === reqId);
    if (cur.length && cur.length + group.length > size) {
      out.push(cur);
      cur = [];
    }
    cur.push(...group);
  }
  if (cur.length) out.push(cur);
  return out;
}

const isInvalidOutput = (e: unknown): boolean => e instanceof QAError && e.kind === 'INVALID_LLM_OUTPUT';

export async function planTests(
  ctx: PlannerContext,
  deps: PlannerDeps,
  mode: 'llm' | 'mechanical',
): Promise<PlanResult> {
  const prompts = loadPrompts();
  const models: string[] = [];
  const envs: ('LIVE' | 'MOCK')[] = [];
  const degraded: PlanResult['degraded'] = [];
  const cases: TestCase[] = [];

  for (const batch of batches(ctx.obligations, deps.batchSize ?? 6)) {
    if (mode === 'mechanical' || !deps.router) {
      cases.push(...buildCases(ctx, mechanicalDrafts(ctx, batch), 'mechanical', deps.ids));
      continue;
    }
    try {
      const res = await runStructured({
        router: deps.router,
        role: 'reasoning',
        agent: 'test-planner:plan',
        schema: PlanOutput,
        system: fill(prompts['plan'] ?? '', {
          defaultPersona: ctx.defaultPersona,
          personas: personaList(ctx),
          outOfScope: ctx.outOfScope.join('; ') || 'none stated',
          story: `${ctx.storyKey} ${ctx.storyTitle ?? ''}`,
        }),
        user: `OBLIGATIONS TO COVER (${String(batch.length)})\n\n${renderObligations(ctx, batch)}`,
        ...(deps.skills ? { skills: { loader: deps.skills, names: TEST_PLANNER_SKILLS } } : {}),
        ...(deps.redactor ? { redactor: deps.redactor } : {}),
        ...(deps.logger ? { logger: deps.logger } : {}),
        check: (out) => draftProblems(ctx, normalizeDrafts(ctx, out.cases), batch),
      });
      models.push(`planner=${res.model}${res.usedFallback ? ' (fallback)' : ''}`);
      envs.push(res.environment);
      cases.push(...buildCases(ctx, normalizeDrafts(ctx, res.value.cases), 'planned', deps.ids));
    } catch (e) {
      if (!isInvalidOutput(e)) throw e;
      degraded.push({ obligationIds: batch.map((o) => o.id), reason: (e as Error).message.slice(0, 300) });
      deps.logger?.warn({ obligations: batch.length }, 'planner batch degraded to mechanical drafts');
      cases.push(...buildCases(ctx, mechanicalDrafts(ctx, batch), 'mechanical', deps.ids));
    }
  }
  deps.ids.save();
  const environment: DesignEnvironment = envs.includes('MOCK') ? 'MOCK' : envs.length ? 'LIVE' : 'NONE';
  return {
    charter: buildCharter(ctx, cases, environment),
    testCases: cases,
    rtm: buildRtm(ctx, cases),
    evidence: caseEvidence(cases, environment === 'MOCK' ? 'MOCK' : 'LIVE', 'test-planner'),
    environment,
    models,
    degraded,
  };
}

export function caseEvidence(cases: readonly TestCase[], environment: 'LIVE' | 'MOCK', agent: string): EvidenceEntry[] {
  const now = new Date().toISOString();
  return cases.map((c) => ({
    id: `EV-${c.id}-${agent === 'test-planner' ? 'PLAN' : 'REVIEW'}`,
    claim: `${c.id} (${c.reviewStatus}) covers ${c.obligationIds.join(', ')}; expectations: ${c.steps.map((s) => s.expected.evidenceLevel).join(', ')}`,
    sources: [...new Set(c.steps.flatMap((s) => s.expected.evidenceIds))].concat(c.obligationIds).slice(0, 20),
    agent,
    confidence: c.reviewStatus === 'APPROVED' ? 0.9 : 0.5,
    environment,
    createdAt: now,
  }));
}

// ------------------------------------------------------------------ revise (Reviewer loop)

export interface ReviseResult {
  testCases: TestCase[];
  justifications: { findingId: string; reason: string }[];
  /** Finding ids the model changed cases for. */
  changedFor: string[];
  /** Revised cases (or removals) rejected by the deterministic checks; the original case stays. */
  rejected?: { key: string; problems: string[] }[];
  environment: DesignEnvironment;
  models: string[];
  degraded: boolean;
}

/**
 * Planner answers Reviewer findings: change cases (re-validated with the same deterministic checks) or justify.
 * Without a model nothing changes; the QA Lead settles what is left.
 */
export async function revisePlan(
  ctx: PlannerContext,
  deps: PlannerDeps,
  cases: readonly TestCase[],
  findings: readonly ReviewFinding[],
  mode: 'llm' | 'mechanical',
): Promise<ReviseResult> {
  const open = findings.filter((f) => f.status === 'OPEN');
  if (!open.length || mode === 'mechanical' || !deps.router) {
    return {
      testCases: [...cases],
      justifications: [],
      changedFor: [],
      environment: 'NONE',
      models: [],
      degraded: mode === 'llm' && open.length > 0,
    };
  }
  const prompts = loadPrompts();
  const affected = new Set(open.flatMap((f) => f.caseIds));
  const affectedReqs = new Set(open.flatMap((f) => f.requirementIds));
  const scopeObs = ctx.obligations.filter(
    (o) => affectedReqs.has(o.requirementId) || cases.some((c) => affected.has(c.id) && c.obligationIds.includes(o.id)),
  );
  const shown = cases.filter((c) => affected.has(c.id) || c.requirementIds.some((r) => affectedReqs.has(r)));
  const caseText = shown
    .map(
      (c) =>
        `${c.id} [${c.persona} · ${c.type} · ${c.reviewStatus}] ${c.title} · obligations ${c.obligationIds.join(', ')}\n${c.steps
          .map(
            (s, i) =>
              `  ${String(i + 1)}. ${s.action} → ${s.expected.text} [${s.expected.evidenceLevel}: ${s.expected.evidenceIds.join(', ')}]`,
          )
          .join('\n')}`,
    )
    .join('\n');
  const findingText = open
    .map(
      (f) =>
        `${f.id} [${f.severity} · ${f.rule}] ${f.text} (cases: ${f.caseIds.join(', ') || '—'}; requirements: ${f.requirementIds.join(', ') || '—'})`,
    )
    .join('\n');
  const openIds = new Set(open.map((f) => f.id));
  const existing = new Set(cases.map((c) => c.id));
  try {
    const res = await runStructured({
      router: deps.router,
      role: 'reasoning',
      agent: 'test-planner:revise',
      schema: ReviseOutput,
      system: fill(prompts['revise'] ?? '', { personas: personaList(ctx) }),
      user: `FINDINGS\n${findingText}\n\nCASES\n${caseText}\n\nOBLIGATIONS AND ALLOWED EVIDENCE\n${renderObligations(ctx, scopeObs)}`,
      ...(deps.skills ? { skills: { loader: deps.skills, names: TEST_PLANNER_SKILLS } } : {}),
      ...(deps.redactor ? { redactor: deps.redactor } : {}),
      ...(deps.logger ? { logger: deps.logger } : {}),
      // Only id-level problems are reflected; each revised case is then validated on its own and accepted or rejected
      // individually, so one bad case does not throw away the whole revision.
      check: (out) => {
        const p: string[] = [];
        for (const j of out.justifications)
          if (!openIds.has(j.findingId)) p.push(`justification for unknown finding ${j.findingId}`);
        for (const r of out.remove) if (!existing.has(r)) p.push(`remove: unknown case ${r}`);
        return p;
      },
    });
    const covered = (list: readonly { obligationIds: readonly string[] }[]): Set<string> =>
      new Set(list.flatMap((c) => c.obligationIds));
    const before = covered(cases);
    const keepsCoverage = (list: readonly { obligationIds: readonly string[] }[]): string[] => {
      const now = covered(list);
      return [...before].filter((o) => !now.has(o));
    };
    const rejected: { key: string; problems: string[] }[] = [];
    const byId = new Map(cases.map((c) => [c.id, c]));
    const accepted: CaseDraft[] = [];
    for (const d of normalizeDrafts(ctx, res.value.cases)) {
      const problems = draftProblems(ctx, [d], ctx.obligations).filter((m) => !m.startsWith('not covered:'));
      if (problems.length) {
        rejected.push({ key: d.key, problems });
        continue;
      }
      const [built] = buildCases(ctx, [d], 'planned', deps.ids, existing.has(d.key) ? { [d.key]: d.key } : {});
      if (!built) continue;
      const trial = new Map(byId);
      const prev = trial.get(built.id);
      trial.set(
        built.id,
        prev?.origin === 'manual-reuse' && !built.manualTestId
          ? { ...built, origin: 'manual-reuse', manualTestId: prev.manualTestId ?? '' }
          : built,
      );
      const lost = keepsCoverage([...trial.values()]);
      if (lost.length) {
        rejected.push({ key: d.key, problems: [`would leave ${lost.join(', ')} without any case`] });
        continue;
      }
      byId.clear();
      for (const [k, v] of trial) byId.set(k, v);
      accepted.push(d);
    }
    const removed: string[] = [];
    for (const id of res.value.remove) {
      const trial = new Map(byId);
      trial.delete(id);
      const lost = keepsCoverage([...trial.values()]);
      if (lost.length) {
        rejected.push({ key: id, problems: [`removal would leave ${lost.join(', ')} without any case`] });
        continue;
      }
      byId.delete(id);
      removed.push(id);
    }
    deps.ids.save();
    for (const r of rejected)
      deps.logger?.warn({ case: r.key, problems: r.problems.slice(0, 3) }, 'revised case rejected');
    const touched = new Set([...accepted.map((d) => d.key), ...removed]);
    const changedFor = open
      .filter((f) => f.caseIds.some((c) => touched.has(c)) || (!f.caseIds.length && accepted.length > 0))
      .map((f) => f.id);
    return {
      testCases: [...byId.values()],
      justifications: res.value.justifications,
      changedFor,
      rejected,
      environment: res.environment,
      models: [`planner=${res.model}${res.usedFallback ? ' (fallback)' : ''}`],
      degraded: false,
    };
  } catch (e) {
    if (!isInvalidOutput(e)) throw e;
    deps.logger?.warn('planner revise output invalid; findings go to the QA Lead');
    return {
      testCases: [...cases],
      justifications: [],
      changedFor: [],
      environment: 'NONE',
      models: [],
      degraded: true,
    };
  }
}
