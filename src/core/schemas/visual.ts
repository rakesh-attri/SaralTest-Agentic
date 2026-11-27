// Phase 6 contracts (PLAN.md §7g): screenshot baselines per region × persona × viewport, visual candidates, local
// layout findings, accessibility findings and the visual run summary. A difference is a candidate for human review,
// never a defect by itself; approving a baseline is a human checkpoint (`approve-visual-baseline`).
import { z } from 'zod';
import { Environment, IsoDate, OrgId18 } from './common.js';

/** Screenshot regions of the Phase 6 suite (one baseline per region × persona × viewport). */
export const VISUAL_REGIONS = ['new-contact-dialog', 'contact-details', 'account-record'] as const;
export const VisualRegion = z.enum(VISUAL_REGIONS);
export type VisualRegion = z.infer<typeof VisualRegion>;

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** `<region>-<persona>-<viewport>` (the baseline file is `<name>.png`). */
export const snapshotName = (region: string, persona: string, viewport: string): string =>
  `${region}-${persona}-${viewport}`;

/** One approved baseline image. */
export const BaselineRecord = z.object({
  name: Slug,
  region: VisualRegion,
  persona: Slug,
  viewport: Slug,
  /** sha256 of the approved PNG; a baseline file with another hash is not trusted (re-approve). */
  sha256: Sha256,
  /** Salesforce release the baseline was approved on (e.g. `Winter '27`); `FIXTURE` for the offline fixture. */
  release: z.string().min(1),
  approvedBy: z.string().min(2),
  approvalId: z.string().regex(/^AP-[0-9a-f]{12}$/),
  approvedAt: IsoDate,
  sourceRun: z.string().min(1),
});
export type BaselineRecord = z.infer<typeof BaselineRecord>;

/** Salesforce-owned axe violations accepted as known for one region × viewport (custom-namespace ones always fail). */
export const A11yBaselineEntry = z.object({
  region: VisualRegion,
  viewport: Slug,
  ruleIds: z.array(z.string().min(1)),
  approvalId: z.string().regex(/^AP-[0-9a-f]{12}$/),
  approvedAt: IsoDate,
  sourceRun: z.string().min(1),
});
export type A11yBaselineEntry = z.infer<typeof A11yBaselineEntry>;

/** Salesforce-owned layout findings accepted for one region × viewport (`qa visual approve --layout`). */
export const LayoutBaselineEntry = z.object({
  region: VisualRegion,
  viewport: Slug,
  keys: z.array(z.string().min(1)),
  approvalId: z.string().regex(/^AP-[0-9a-f]{12}$/),
  approvedAt: IsoDate,
  sourceRun: z.string().min(1),
});
export type LayoutBaselineEntry = z.infer<typeof LayoutBaselineEntry>;

/** `tests/visual-baselines/<org>/baselines.json`: baselines of one org (fixture and live never mix). */
export const BaselineManifest = z.object({
  org: Slug,
  orgId: OrgId18,
  environment: Environment,
  baselines: z.array(BaselineRecord).default([]),
  a11y: z.array(A11yBaselineEntry).default([]),
  layout: z.array(LayoutBaselineEntry).default([]),
});
export type BaselineManifest = z.infer<typeof BaselineManifest>;

/**
 * Candidate status of one screenshot:
 * - `MATCH`: within the allowed ratio of an approved, untampered baseline on the same release;
 * - `NO_BASELINE`: nothing approved yet (the actual image is the proposal);
 * - `DIFF`: differs from the approved baseline;
 * - `RE_APPROVE`: baseline approved on another release, or its file hash no longer matches the record;
 * - `NOT_CAPTURED`: the region could not be captured (test failed before the screenshot) — no image to judge.
 */
export const CandidateStatus = z.enum(['MATCH', 'NO_BASELINE', 'DIFF', 'RE_APPROVE', 'NOT_CAPTURED']);
export type CandidateStatus = z.infer<typeof CandidateStatus>;

export const VisualCandidate = z.object({
  name: Slug,
  region: VisualRegion,
  persona: Slug,
  viewport: Slug,
  status: CandidateStatus,
  maxDiffPixelRatio: z.number().min(0).max(1),
  /** Pixels / ratio reported by Playwright for a DIFF (absent when Playwright gave no count, e.g. size change). */
  diffPixels: z.number().int().nonnegative().optional(),
  diffPixelRatio: z.number().min(0).max(1).optional(),
  /** Image paths relative to the run folder. */
  images: z.object({ baseline: z.string().optional(), actual: z.string().optional(), diff: z.string().optional() }),
  /** sha256 of the actual image (what `qa visual approve` would store). */
  actualSha256: Sha256.optional(),
  reason: z.string().min(1),
  environment: Environment,
});
export type VisualCandidate = z.infer<typeof VisualCandidate>;

export const LayoutFindingKind = z.enum([
  'overlap',
  'clipped-text',
  'hidden-required',
  'off-screen',
  'layout-shift',
  'blank-page',
  'loading-not-finished',
  'error-banner',
]);
export type LayoutFindingKind = z.infer<typeof LayoutFindingKind>;

/** A deterministic layout observation from element boxes / page state (no AI). Reported as a candidate. */
export const LayoutFinding = z.object({
  region: VisualRegion,
  viewport: Slug,
  kind: LayoutFindingKind,
  /** Accessible names (or roles) of the elements involved — never field values. */
  elements: z.array(z.string()).default([]),
  detail: z.string().min(1),
  /** Measured value where one exists (overlap px², layout-shift score, overflow px). */
  value: z.number().optional(),
  /**
   * Whose component the finding is in: `salesforce` (standard namespaces: sticky header/footer, Preview buttons,
   * load-time layout shift) or `ours` (custom namespace, or a page that is not Lightning, e.g. the fixture).
   */
  owner: z.enum(['salesforce', 'ours']).default('ours'),
  /** Overlap of two field controls outside any pinned (fixed / sticky) container: a real overlap, always FAIL. */
  fieldOverlap: z.boolean().default(false),
  /** Set by the runner (src/visual/collect.ts): FAIL · BASELINE (accepted) · NEW_STANDARD (Salesforce-owned, new). */
  status: z.enum(['FAIL', 'BASELINE', 'NEW_STANDARD']).optional(),
});
export type LayoutFinding = z.infer<typeof LayoutFinding>;

/** Kinds that describe the page state, not a component: they always fail (blank page, error, endless loading). */
export const PAGE_STATE_KINDS: readonly LayoutFindingKind[] = [
  'blank-page',
  'loading-not-finished',
  'error-banner',
  'hidden-required',
];

/** A layout finding fails the test: our component, a real field overlap, or a broken page state. */
export function layoutFindingFails(f: Pick<LayoutFinding, 'owner' | 'fieldOverlap' | 'kind'>): boolean {
  return f.owner === 'ours' || f.fieldOverlap || PAGE_STATE_KINDS.includes(f.kind);
}

/** Stable key of a Salesforce-owned layout finding (no measured value: CLS and px change per run). */
export function layoutFindingKey(f: Pick<LayoutFinding, 'kind' | 'elements'>): string {
  return `${f.kind}:${[...f.elements].sort().join('|')}`;
}

/**
 * - `FAIL`: violation inside our custom namespaces (fails the test);
 * - `BASELINE`: Salesforce-owned violation already accepted for this region × viewport;
 * - `NEW_STANDARD`: Salesforce-owned violation not in the accepted list (candidate for review / acceptance).
 */
export const A11yFindingStatus = z.enum(['FAIL', 'BASELINE', 'NEW_STANDARD']);

export const A11yFinding = z.object({
  region: VisualRegion,
  viewport: Slug,
  ruleId: z.string().min(1),
  impact: z.string().nullable().default(null),
  status: A11yFindingStatus,
  targets: z.number().int().nonnegative(),
  help: z.string().default(''),
});
export type A11yFinding = z.infer<typeof A11yFinding>;

/** Keyboard + accessible-name checks of one region × viewport (deterministic; a failure fails the test). */
export const A11yRegionCheck = z.object({
  region: VisualRegion,
  viewport: Slug,
  tabOrderInOrder: z.boolean().nullable(),
  missingFromTabOrder: z.array(z.string()).default([]),
  unnamedControls: z.array(z.string()).default([]),
});
export type A11yRegionCheck = z.infer<typeof A11yRegionCheck>;

export const VisualRunSummary = z.object({
  runId: z.string().min(1),
  org: Slug,
  orgId: OrgId18,
  environment: Environment,
  release: z.string().min(1),
  persona: Slug,
  viewports: z.array(Slug).min(1),
  browser: z.string().min(1),
  candidates: z.array(VisualCandidate),
  layout: z.array(LayoutFinding).default([]),
  a11y: z.array(A11yFinding).default([]),
  a11yChecks: z.array(A11yRegionCheck).default([]),
  /** Playwright test outcomes of the suite (PASS / FAIL …) by test title. */
  tests: z.array(z.object({ title: z.string(), state: z.string(), error: z.string().optional() })).default([]),
  counts: z.object({
    match: z.number().int().nonnegative(),
    candidates: z.number().int().nonnegative(),
    layout: z.number().int().nonnegative(),
    layoutFail: z.number().int().nonnegative().default(0),
    layoutNewStandard: z.number().int().nonnegative().default(0),
    a11yFail: z.number().int().nonnegative(),
    a11yNewStandard: z.number().int().nonnegative(),
  }),
  createdAt: IsoDate,
});
export type VisualRunSummary = z.infer<typeof VisualRunSummary>;
