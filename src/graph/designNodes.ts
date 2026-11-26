import type { Logger } from '../core/logger.js';
import { createIssue } from '../core/issues.js';
import type { ComponentVersion, ImpactReport, Issue, Requirement } from '../core/schemas/index.js';
import type { ModelRouter } from '../models/router.js';
import type { Redactor } from '../security/redact.js';
import type { SkillLoader } from '../skills/skillLoader.js';
import type { LocatorEntry } from '../knowledge/locatorRegistry.js';
import type { OrgCheck } from '../agents/sf-intelligence/schema.js';
import { EvidenceIndex } from '../oracles/index.js';
import {
  assessRisks,
  deriveObligations,
  resolvePersona,
  tierObligations,
  withRiskScores,
  type ConfiguredPersona,
  type ResolvedPersona,
} from '../agents/impact-risk/index.js';
import {
  buildCases,
  buildCharter,
  buildRtm,
  caseEvidence,
  mechanicalDrafts,
  planTests,
  revisePlan,
  TestCaseIdStore,
  type PlannerContext,
} from '../agents/test-planner/index.js';
import { MAX_REVIEW_ROUNDS, reviewRound, settleFindings } from '../agents/test-reviewer/index.js';
import type { QAGraphStateType, QAGraphUpdate } from './state.js';

/** Org-side inputs for test design, supplied by the CLI (snapshot store, cross-check, registry, personas.yaml). */
export interface DesignInputs {
  snapshotId: string;
  snapshotEnvironment?: 'LIVE' | 'FIXTURE';
  components: ComponentVersion[];
  orgChecks: OrgCheck[];
  locators: LocatorEntry[];
  impact?: ImpactReport;
  personas: ConfiguredPersona[];
  defaultPersona: string;
  /** Data recipe names that exist (examples/recipes). */
  recipes: string[];
  notes?: string[];
}
export type DesignHook = (
  s: Pick<QAGraphStateType, 'runId' | 'requirements' | 'findings' | 'existingTests' | 'impact' | 'orgContext'>,
) => Promise<DesignInputs>;

export interface DesignDeps {
  design: DesignHook;
  router?: ModelRouter;
  skills?: SkillLoader;
  redactor?: Redactor;
  logger: Logger;
  memoryDir: string;
  say: (m: string) => void;
}

/** Charter personas: the default test user first, then every persona the requirements or obligations name. */
export function charterPersonas(
  s: QAGraphStateType,
  inputs: DesignInputs,
  checks: readonly OrgCheck[],
): ResolvedPersona[] {
  const out: ResolvedPersona[] = [resolvePersona(inputs.defaultPersona, inputs.personas, checks)];
  const names = [...new Set(inScope(s.requirements).flatMap((r) => r.personas))];
  for (const n of names) {
    const p = resolvePersona(n, inputs.personas, checks);
    if (!out.some((x) => x.id === p.id)) out.push(p);
  }
  return out;
}

/** Requirements the operator DEFERRED are out of scope: no obligations, risks or cases (RTM row `excluded`). */
export const inScope = (reqs: readonly Requirement[]): Requirement[] => reqs.filter((r) => r.status !== 'DEFERRED');

export function buildContext(s: QAGraphStateType, inputs: DesignInputs): { ctx: PlannerContext; index: EvidenceIndex } {
  const index = new EvidenceIndex({
    docs: s.sources,
    requirements: s.requirements,
    findings: s.findings,
    clarifications: s.clarifications,
    orgChecks: inputs.orgChecks,
    components: inputs.components,
    locators: inputs.locators,
    manualTests: s.existingTests,
    ...(inputs.snapshotEnvironment ? { snapshotEnvironment: inputs.snapshotEnvironment } : {}),
  });
  const personas = charterPersonas(s, inputs, inputs.orgChecks);
  const outOfScope = s.sources.flatMap((d) => d.sections.filter((x) => x.kind === 'out-of-scope').map((x) => x.text));
  const ctx: PlannerContext = {
    storyKey: s.storyKey ?? s.sources[0]?.docId ?? 'REQ',
    ...(s.story?.summary ? { storyTitle: s.story.summary } : s.sources[0] ? { storyTitle: s.sources[0].title } : {}),
    requirements: inScope(s.requirements),
    deferred: s.requirements.filter((r) => r.status === 'DEFERRED'),
    obligations: s.obligations,
    risks: s.risks,
    index,
    manualTests: s.existingTests,
    personas,
    defaultPersona: inputs.defaultPersona,
    snapshotId: inputs.snapshotId,
    outOfScope,
    recipes: inputs.recipes,
  };
  return { ctx, index };
}

const env = (e: 'LIVE' | 'MOCK' | 'NONE', prev: 'LIVE' | 'MOCK' | 'NONE'): 'LIVE' | 'MOCK' | 'NONE' =>
  e === 'MOCK' || prev === 'MOCK' ? 'MOCK' : e === 'LIVE' || prev === 'LIVE' ? 'LIVE' : 'NONE';

/**
 * `plan` node: first visit = risk model + obligations + Planner; later visits (open Reviewer findings) = revise.
 */
export function createPlanNode(d: DesignDeps) {
  const cache = new Map<string, DesignInputs>();
  const inputsFor = async (s: QAGraphStateType): Promise<DesignInputs> => {
    let i = cache.get(s.runId);
    if (!i) {
      i = await d.design(s);
      cache.set(s.runId, i);
      for (const n of i.notes ?? []) d.say(n);
    }
    return i;
  };
  const plan = async (s: QAGraphStateType): Promise<QAGraphUpdate> => {
    const inputs = await inputsFor(s);
    const mechanical = s.degradedNodes.includes('plan') || !d.router;
    const mode = mechanical ? 'mechanical' : 'llm';
    const ids = new TestCaseIdStore(s.storyKey ?? 'REQ', d.memoryDir);
    const plannerDeps = {
      ...(d.router ? { router: d.router } : {}),
      ...(d.skills ? { skills: d.skills } : {}),
      ...(d.redactor ? { redactor: d.redactor } : {}),
      logger: d.logger,
      ids,
    };
    const issues: Issue[] = [];

    // ---- revise after a Reviewer round
    if (s.testCases.length && s.reviewFindings.some((f) => f.status === 'OPEN')) {
      const { ctx } = buildContext(s, inputs);
      const open = s.reviewFindings.filter((f) => f.status === 'OPEN');
      d.say(
        `Test Planner: answering ${String(open.length)} reviewer finding(s)${mechanical ? ' (no model: left for the QA Lead)' : ''} …`,
      );
      const r = await revisePlan(ctx, plannerDeps, s.testCases, s.reviewFindings, mode);
      if (r.degraded && !mechanical) {
        issues.push(
          createIssue({
            kind: 'INVALID_LLM_OUTPUT',
            node: 'plan',
            message: 'planner revise output unusable; open findings go to the QA Lead',
            resolution: 'DEGRADED',
          }),
        );
      }
      d.say(
        `  ✓ ${String(r.changedFor.length)} finding(s) addressed by changes, ${String(r.justifications.length)} justified${r.rejected?.length ? `, ${String(r.rejected.length)} revised case(s) rejected by the checks (originals kept)` : ''}`,
      );
      return {
        testCases: r.testCases,
        rtm: buildRtm(ctx, r.testCases),
        planJustifications: r.justifications,
        designEnvironment: env(r.environment, s.designEnvironment),
        designModels: [...new Set([...s.designModels, ...r.models])],
        issues,
      };
    }

    // ---- first plan
    const { index } = buildContext(s, inputs);
    const risks = assessRisks({
      requirements: inScope(s.requirements),
      index,
      orgChecks: inputs.orgChecks,
      manualTests: s.existingTests,
      defects: s.defectHistory,
      ...(inputs.impact ? { impact: inputs.impact } : s.impact ? { impact: s.impact } : {}),
    });
    const obligations = tierObligations(
      deriveObligations({
        requirements: inScope(s.requirements),
        index,
        orgChecks: inputs.orgChecks,
        components: inputs.components,
        manualTests: s.existingTests,
        personas: inputs.personas,
        defaultPersona: inputs.defaultPersona,
        reverify: inputs.impact?.reverify ?? s.impact?.reverify ?? [],
      }),
      risks,
    );
    const { ctx } = buildContext({ ...s, risks, obligations }, inputs);
    d.say(
      `Test Planner: ${String(obligations.length)} coverage obligations, ${String(risks.length)} risks (${String(risks.filter((r) => r.tier === 'mandatory').length)} mandatory) against snapshot ${inputs.snapshotId}${mechanical ? ' — mechanical (no model)' : ''} …`,
    );
    const res = await planTests(ctx, plannerDeps, mode);
    for (const g of res.degraded) {
      issues.push(
        createIssue({
          kind: 'INVALID_LLM_OUTPUT',
          node: 'plan',
          message: `planner batch (${g.obligationIds.join(', ')}) drafted mechanically: ${g.reason}`,
          resolution: 'DEGRADED',
        }),
      );
    }
    if (mechanical) {
      issues.push(
        createIssue({
          kind: d.router ? 'INVALID_LLM_OUTPUT' : 'TOOL_UNAVAILABLE',
          node: 'plan',
          message: d.router
            ? 'test cases drafted mechanically after triage chose degrade'
            : 'test cases drafted mechanically (no model: offline or not configured)',
          resolution: 'DEGRADED',
        }),
      );
    }
    d.say(
      `  ✓ ${String(res.testCases.length)} cases (${String(res.testCases.filter((c) => c.reviewStatus === 'APPROVED').length)} approved, ${String(res.testCases.filter((c) => c.reviewStatus === 'REVIEW_REQUIRED').length)} review required, ${String(res.testCases.filter((c) => c.reviewStatus === 'BLOCKED').length)} blocked) [${res.environment}]`,
    );
    return {
      risks,
      obligations,
      impact: withRiskScores(inputs.impact ?? s.impact, risks),
      charter: res.charter,
      testCases: res.testCases,
      rtm: res.rtm,
      evidence: res.evidence,
      reviewFindings: [],
      reviewRound: 0,
      planJustifications: [],
      designEnvironment: res.environment,
      designModels: res.models,
      orgEnvironment: inputs.snapshotEnvironment ?? 'NONE',
      issues,
    };
  };

  /** `review` node: Reviewer pass-1 round; after the last round the QA Lead settles what is still open. */
  const review = async (s: QAGraphStateType): Promise<QAGraphUpdate> => {
    const inputs = await inputsFor(s);
    const { ctx } = buildContext(s, inputs);
    const round = s.reviewRound + 1;
    const mechanical = s.degradedNodes.includes('review') || !d.router;
    d.say(`Test Reviewer pass 1 — round ${String(round)}${mechanical ? ' (deterministic checks only)' : ''} …`);
    const r = await reviewRound(
      {
        ctx,
        cases: s.testCases,
        prior: s.reviewFindings,
        round,
        justifications: s.planJustifications,
        mode: mechanical ? 'mechanical' : 'llm',
      },
      {
        ...(d.router ? { router: d.router } : {}),
        ...(d.skills ? { skills: d.skills } : {}),
        ...(d.redactor ? { redactor: d.redactor } : {}),
        logger: d.logger,
      },
    );
    const issues: Issue[] = [];
    if (r.judgeDegraded && !mechanical) {
      issues.push(
        createIssue({
          kind: 'INVALID_LLM_OUTPUT',
          node: 'review',
          message: `judge unusable in round ${String(round)}: deterministic review only`,
          resolution: 'DEGRADED',
        }),
      );
    }
    const open = r.findings.filter((f) => f.status === 'OPEN');
    let findings = r.findings;
    let cases = s.testCases;
    if (open.length && round >= MAX_REVIEW_ROUNDS) {
      const restoreIds = new TestCaseIdStore(s.storyKey ?? 'REQ', d.memoryDir);
      const settled = settleFindings(ctx, r.findings, s.testCases, (obIds) => {
        const added = buildCases(
          ctx,
          mechanicalDrafts(
            ctx,
            ctx.obligations.filter((o) => obIds.includes(o.id)),
          ),
          'mechanical',
          restoreIds,
        );
        restoreIds.save();
        return added;
      });
      findings = settled.findings;
      cases = settled.cases;
      d.say(`  QA Lead settled ${String(open.length)} open finding(s) after ${String(round)} rounds`);
    }
    const counts = (st: string): number => findings.filter((f) => f.status === st).length;
    d.say(
      `  ✓ findings: ${String(counts('OPEN'))} open, ${String(counts('RESOLVED'))} resolved, ${String(counts('JUSTIFIED'))} justified [${r.environment}]`,
    );
    const done = !findings.some((f) => f.status === 'OPEN');
    const charter = done ? buildCharter(ctx, cases, env(r.environment, s.designEnvironment)) : s.charter;
    return {
      reviewFindings: findings,
      reviewRound: round,
      testCases: cases,
      rtm: buildRtm(ctx, cases),
      planJustifications: [],
      designEnvironment: env(r.environment, s.designEnvironment),
      designModels: [...new Set([...s.designModels, ...r.models])],
      ...(charter ? { charter } : {}),
      ...(done
        ? {
            evidence: caseEvidence(
              cases,
              s.designEnvironment === 'MOCK' || r.environment === 'MOCK' ? 'MOCK' : 'LIVE',
              'test-reviewer',
            ),
          }
        : {}),
      issues,
    };
  };
  return { plan, review };
}
