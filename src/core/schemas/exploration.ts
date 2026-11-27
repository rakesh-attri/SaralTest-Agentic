// Phase 7 Autonomous Explorer contracts (.claude/skills/exploratory-testing/SKILL.md). A charter is time-boxed; the
// state map records what was visited so finished states are never revisited; findings never become tests without
// review (policy.exploration.promoteFindingsVia).
import { z } from 'zod';
import { Environment, IsoDate, Severity } from './common.js';

export const ExplorationCharter = z.object({
  id: z.string(),
  /** Area explored (e.g. contact-create). */
  area: z.string(),
  persona: z.string(),
  resources: z.string(),
  risk: z.string(),
  /** "Explore <area> as <persona> with <resources> to discover <risk>". */
  mission: z.string(),
  timeBoxMin: z.number().positive(),
  maxSteps: z.number().int().positive(),
  maxSaves: z.number().int().nonnegative(),
  /** Stop after this many steps without reaching a new state. */
  saturationSteps: z.number().int().positive(),
  stopConditions: z.array(z.string()),
  /** Why this area was chosen (scored signals), also written to the evidence ledger. */
  reason: z.string(),
  requirementIds: z.array(z.string()).default([]),
});
export type ExplorationCharter = z.infer<typeof ExplorationCharter>;

export const ActionKind = z.enum([
  'open-page',
  'open-dialog',
  'open-tab',
  'fill',
  'clear',
  'tab-key',
  'cancel',
  'escape',
  'save-attempt',
]);
export type ActionKind = z.infer<typeof ActionKind>;

/** One entry of the approved action catalog. Only `save-attempt` mutates (guarded, audited, capped). */
export const ExplorationAction = z.object({
  id: z.string(),
  kind: ActionKind,
  /** Field label / tab name / dialog name. */
  target: z.string().optional(),
  /** Value class, never a real person's data (e.g. 'empty', 'max+1', 'special-chars', 'invalid-email'). */
  valueClass: z.string().optional(),
  mutate: z.boolean(),
  /** Exploratory heuristic it serves (boundaries, interruptions, CRUD …). */
  heuristic: z.string(),
});
export type ExplorationAction = z.infer<typeof ExplorationAction>;

export const StateNode = z.object({
  /** sha256 prefix of page + dialog + tab + form signature. */
  id: z.string(),
  page: z.string(),
  dialog: z.string().optional(),
  tab: z.string().optional(),
  /** Visible field errors / required markers / message kinds that make this state distinct. */
  signature: z.string(),
  visits: z.number().int().positive(),
  /** All catalog actions from this state were tried (or are not applicable). */
  finished: z.boolean(),
  firstSeenStep: z.number().int().nonnegative(),
});
export type StateNode = z.infer<typeof StateNode>;

export const StateEdge = z.object({
  from: z.string(),
  to: z.string(),
  actionId: z.string(),
  step: z.number().int().nonnegative(),
});
export type StateEdge = z.infer<typeof StateEdge>;

export const ExplorationStep = z.object({
  step: z.number().int().nonnegative(),
  actionId: z.string(),
  from: z.string(),
  to: z.string(),
  newState: z.boolean(),
  /** Why the action was chosen (score parts or the model's reason). */
  reason: z.string(),
  chosenBy: z.enum(['score', 'model']),
  observation: z.string(),
  evidenceIds: z.array(z.string()).default([]),
  at: IsoDate,
});
export type ExplorationStep = z.infer<typeof ExplorationStep>;

export const ExplorationFindingKind = z.enum([
  'console-error',
  'rule-not-enforced', // the org's own rule (describe / validation rule) did not reject the input
  'required-mismatch', // required marker in the UI differs from describe / layout
  'unexpected-message', // a message not among the org's known texts
  'record-created-unexpectedly', // a save that should have been rejected created a record
  'navigation', // landed somewhere unexpected after an action
  'question', // behaviour without a stated expectation
]);
export type ExplorationFindingKind = z.infer<typeof ExplorationFindingKind>;

export const ExplorationFinding = z.object({
  id: z.string(),
  charterId: z.string(),
  kind: ExplorationFindingKind,
  title: z.string(),
  observation: z.string(),
  /** Steps (action descriptions) that led to the finding. */
  steps: z.array(z.string()),
  /** Only an org fact or requirement may be stated as expected; otherwise empty and the finding is a question. */
  expected: z.string().optional(),
  expectedEvidence: z.array(z.string()).default([]),
  severity: Severity,
  suggestion: z.enum(['test-case', 'suspected-defect', 'question']),
  evidenceIds: z.array(z.string()).min(1),
  /** Draft test case id created from it (REVIEW_REQUIRED until a human promotes it). */
  testCaseId: z.string().optional(),
  promoted: z.object({ by: z.string(), at: IsoDate, approvalId: z.string() }).optional(),
});
export type ExplorationFinding = z.infer<typeof ExplorationFinding>;

export const ExplorationReport = z.object({
  runId: z.string(),
  org: z.string(),
  environment: Environment,
  charter: ExplorationCharter,
  startedAt: IsoDate,
  endedAt: IsoDate,
  stoppedBy: z.enum(['time-box', 'max-steps', 'saturation', 'error-budget', 'off-domain', 'hard-stop', 'catalog-done']),
  steps: z.array(ExplorationStep),
  states: z.array(StateNode),
  edges: z.array(StateEdge),
  saves: z.number().int().nonnegative(),
  findings: z.array(ExplorationFinding),
  coverageNote: z.string(),
  dataCleanup: z.enum(['CLEAN', 'INCOMPLETE', 'NONE']),
});
export type ExplorationReport = z.infer<typeof ExplorationReport>;
