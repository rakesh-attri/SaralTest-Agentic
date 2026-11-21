import type {
  CoverageObligation,
  DefectRecord,
  ImpactLevel,
  ImpactReport,
  ManualTestCase,
  RegressionTier,
  Requirement,
  RiskDriver,
  RiskItem,
} from '../../core/schemas/index.js';
import type { OrgCheck } from '../sf-intelligence/schema.js';
import type { EvidenceIndex } from '../../oracles/index.js';

/**
 * Deterministic risk model (Impact & Risk Analyst, test-design skill). One risk per requirement: "this requirement
 * fails or is mis-specified". Likelihood = base from the requirement's risk + evidence-backed drivers (capped 0.95);
 * impact from requirement risk/type; score = likelihood × impact weight (H 1, M 0.6, L 0.3).
 *
 * Tiers: mandatory = covers a story AC, or has a changed-component / RE_VERIFY / past-defect driver; recommended =
 * score ≥ 0.35; optional = the rest. A tier never removes obligations: AC coverage is mandatory regardless of score.
 */
export interface RiskInput {
  requirements: readonly Requirement[];
  index: EvidenceIndex;
  orgChecks: readonly OrgCheck[];
  manualTests: readonly ManualTestCase[];
  defects?: readonly DefectRecord[];
  impact?: ImpactReport;
}

const BASE: Record<Requirement['risk'], number> = { HIGH: 0.5, MEDIUM: 0.35, LOW: 0.2 };
const WEIGHT: Record<ImpactLevel, number> = { H: 1, M: 0.6, L: 0.3 };
export const RECOMMENDED_THRESHOLD = 0.35;

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function impactOf(r: Requirement): ImpactLevel {
  if (r.risk === 'HIGH' || r.type === 'security' || r.type === 'data') return 'H';
  if (r.risk === 'MEDIUM') return 'M';
  return 'L';
}

export function assessRisks(i: RiskInput): RiskItem[] {
  const reverify = new Set(i.impact?.reverify ?? []);
  const changed = i.impact?.changed ?? [];
  return i.requirements.map((r, n) => {
    const sections = i.index.sectionsOf(r);
    const short = sections.map((q) => q.split('#')[1] ?? q);
    const drivers: RiskDriver[] = [];
    for (const c of i.orgChecks.filter((x) => x.requirementIds.includes(r.id))) {
      if (c.result === 'CONFLICT')
        drivers.push({
          kind: 'org-conflict',
          text: `${c.id}: ${c.subject} — ${c.orgFact}`,
          refs: [c.id],
          weight: 0.25,
        });
      else if (c.result === 'NOT_FOUND')
        drivers.push({ kind: 'org-not-found', text: `${c.id}: ${c.subject}`, refs: [c.id], weight: 0.25 });
      else if (c.result === 'UNKNOWN' && c.check !== 'persona')
        drivers.push({ kind: 'org-unknown', text: `${c.id}: ${c.subject}`, refs: [c.id], weight: 0.1 });
    }
    if (r.status === 'REVIEW_REQUIRED') {
      drivers.push({
        kind: 'review-required',
        text: `${r.id} is REVIEW_REQUIRED: ${r.reviewReasons.slice(0, 2).join('; ')}`,
        refs: [r.id],
        weight: 0.1,
      });
    }
    const tests = i.manualTests.filter((t) =>
      t.requirementRefs.some((x) => {
        const q = i.index.resolve(x);
        return q !== undefined && sections.includes(q);
      }),
    );
    for (const t of tests.filter((x) => x.lastRun.status === 'FAIL')) {
      drivers.push({
        kind: 'manual-test-failed',
        text: `${t.id} "${t.title}" failed on its last run${t.lastRun.date ? ` (${t.lastRun.date})` : ''}`,
        refs: [t.id],
        weight: 0.2,
      });
    }
    const marks = [`requirement:${r.id}`, ...tests.map((t) => `manual-test:${t.id}`)].filter((m) => reverify.has(m));
    if (marks.length)
      drivers.push({ kind: 're-verify', text: `open RE_VERIFY: ${marks.join(', ')}`, refs: marks, weight: 0.15 });
    const touched = (i.impact?.impacted ?? []).filter((x) => x.node === `Requirement:${r.id}`);
    if (touched.length && changed.length) {
      drivers.push({
        kind: 'changed-component',
        text: `depends on changed components: ${touched
          .flatMap((x) => x.path)
          .slice(0, 2)
          .join(' ; ')}`,
        refs: changed.slice(0, 5),
        weight: 0.2,
      });
    }
    const text = `${r.title ?? ''} ${r.businessObjective}`.toLowerCase();
    for (const d of i.defects ?? []) {
      const terms = [
        ...d.components,
        ...d.summary
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length > 4),
      ];
      const hits = terms.filter((t) => text.includes(t.toLowerCase()));
      if (hits.length >= 2)
        drivers.push({
          kind: 'past-defect',
          text: `${d.key} "${d.summary}" (matched: ${hits.slice(0, 3).join(', ')})`,
          refs: [d.key],
          weight: 0.2,
        });
    }
    const likelihood = round2(Math.min(0.95, BASE[r.risk] + drivers.reduce((a, d) => a + d.weight, 0)));
    const impact = impactOf(r);
    const score = round2(likelihood * WEIGHT[impact]);
    const coversAc = short.some((s) => /^AC\d+$/i.test(s));
    const forced = drivers.some(
      (d) => d.kind === 'changed-component' || d.kind === 're-verify' || d.kind === 'past-defect',
    );
    const tier: RegressionTier =
      coversAc || forced ? 'mandatory' : score >= RECOMMENDED_THRESHOLD ? 'recommended' : 'optional';
    return {
      id: `RISK-${String(n + 1).padStart(2, '0')}`,
      desc: `${r.title ?? r.businessObjective} fails or is mis-specified`,
      likelihood,
      impact,
      score,
      tier,
      drivers,
      requirementIds: [r.id],
      refs: short,
      components: [],
    };
  });
}

/** Apply risk tiers to obligations: AC obligations and regressions always stay mandatory. */
export function tierObligations(
  obligations: readonly CoverageObligation[],
  risks: readonly RiskItem[],
): CoverageObligation[] {
  return obligations.map((o) => {
    if (o.isAc || o.kind === 'regression') return { ...o, tier: 'mandatory' };
    const risk = risks.find((r) => r.requirementIds.includes(o.requirementId));
    return { ...o, tier: risk?.tier ?? 'optional' };
  });
}

/** Impact report scores keyed by requirement id (kept in the Phase 2 `riskScores` field). */
export function withRiskScores(impact: ImpactReport | undefined, risks: readonly RiskItem[]): ImpactReport {
  return {
    dependencies: impact?.dependencies ?? [],
    regressionCandidates: impact?.regressionCandidates ?? [],
    changed: impact?.changed ?? [],
    impacted: impact?.impacted ?? [],
    reverify: impact?.reverify ?? [],
    riskScores: Object.fromEntries(risks.flatMap((r) => r.requirementIds.map((id) => [id, r.score]))),
  };
}
