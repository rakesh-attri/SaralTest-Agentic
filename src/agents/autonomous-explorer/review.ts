// Exploration findings → test cases (exploratory-testing SKILL: "never straight to code"; policy.exploration
// promoteFindingsVia: [planner, test-reviewer]). Code drafts a REVIEW_REQUIRED case per finding, a deterministic review
// (Test Reviewer pass-1 subset) lists what blocks or needs attention, and only a human promotes it
// (`qa explore promote`): the case then gets a story id and goes into a case-edits file the build reads.
// A promoted case is APPROVED only when every expectation is assertable (DECLARED_CONFIG from the org's own rules);
// observed behaviour stays REVIEW_REQUIRED until someone accepts it as a requirement (PLAN.md §7f).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { ExplorationReport, TestCase, isAssertable, type ExplorationFinding } from '../../core/schemas/index.js';
import { caseEditEvidenceId } from '../../inputs/caseEdits.js';
import { ApprovalStore } from '../../security/approvals.js';
import { TestCaseIdStore } from '../test-planner/index.js';

export const PROMOTE_CHECKPOINT = 'review-required-expectations';
const COMPONENT = /^(Field|ValidationRule|DuplicateRule|SObject):/;

export const ReviewNote = z.object({
  rule: z.enum(['no-expected-result', 'not-assertable', 'similar-design-case', 'question-not-test']),
  blocking: z.boolean(),
  text: z.string(),
});
export type ReviewNote = z.infer<typeof ReviewNote>;

export const DraftCase = z.object({ findingId: z.string(), testCase: TestCase, review: z.array(ReviewNote) });
export type DraftCase = z.infer<typeof DraftCase>;

export function draftCase(
  f: ExplorationFinding,
  o: { storyKey: string; persona: string; snapshotId: string; requirementIds: readonly string[] },
): TestCase {
  const config = f.expectedEvidence.filter((e) => COMPONENT.test(e));
  const level = config.length && f.expected ? 'DECLARED_CONFIG' : 'OBSERVED_ONLY';
  // One step: the action sequence that led to the finding, and the single evidenced expectation (intermediate
  // steps carry no expectation of their own, so they never make the case non-assertable).
  const steps = [
    {
      action: (f.steps.length ? f.steps : ['Open the New Contact dialog from an Account']).join(' → '),
      expected: {
        text: f.expected ?? `As observed: ${f.observation}`,
        evidenceLevel: level,
        evidenceIds: [...config, ...f.evidenceIds],
      },
    },
  ];
  return TestCase.parse({
    id: `XTC-${f.id}`,
    title: f.title,
    requirementIds: o.requirementIds.length ? [...o.requirementIds] : ['EXPLORATORY'],
    riskIds: [],
    technique: `exploratory (${f.kind})`,
    persona: o.persona,
    type: 'exploratory',
    priority: f.severity === 'MAJOR' || f.severity === 'CRITICAL' ? 'P1' : 'P2',
    severity: f.severity,
    preconditions: [
      'A run-tagged Account exists (approved recipe account-contact)',
      `User is logged in as ${o.persona}`,
    ],
    dataRecipe: 'account-contact',
    steps,
    tags: ['@exploratory', `@${o.storyKey}`, `@persona:${o.persona}`],
    reviewStatus: 'REVIEW_REQUIRED',
    reviewReasons: ['exploratory finding: a human reviews and promotes it (never auto-approved)'],
    snapshotId: o.snapshotId,
    origin: 'exploratory',
  });
}

const tokens = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2),
  );
const jaccard = (a: Set<string>, b: Set<string>): number => {
  let i = 0;
  for (const t of a) if (b.has(t)) i++;
  return a.size + b.size - i ? i / (a.size + b.size - i) : 0;
};

/** Deterministic review of a drafted case against the design run's cases. */
export function reviewDraft(f: ExplorationFinding, tc: TestCase, design: readonly TestCase[]): ReviewNote[] {
  const notes: ReviewNote[] = [];
  if (f.suggestion === 'question')
    notes.push({
      rule: 'question-not-test',
      blocking: true,
      text: 'a question about intended behaviour: clarify it first (QA Lead → chat), it is not a test case yet',
    });
  if (!f.expected)
    notes.push({
      rule: 'no-expected-result',
      blocking: f.suggestion !== 'question',
      text: 'no org fact or requirement states the expected result; the case would only record what was observed',
    });
  if (tc.steps.some((s) => !isAssertable(s.expected.evidenceLevel)))
    notes.push({
      rule: 'not-assertable',
      blocking: false,
      text: 'OBSERVED_ONLY expectations: after promotion the case stays REVIEW_REQUIRED until the behaviour is accepted as a requirement',
    });
  const mine = tokens(`${tc.title} ${tc.steps.map((s) => s.action).join(' ')}`);
  for (const c of design) {
    const sim = jaccard(mine, tokens(`${c.title} ${c.steps.map((s) => s.action).join(' ')}`));
    if (sim >= 0.45)
      notes.push({
        rule: 'similar-design-case',
        blocking: false,
        text: `similar to ${c.id} "${c.title}" (${sim.toFixed(2)}) — check it is not a duplicate`,
      });
  }
  return notes;
}

export const exploreDir = (root: string, runId: string): string => join(root, 'runs', runId, 'explore');
export const exploratoryEditsFile = (root: string, storyKey: string): string =>
  join(root, 'examples', 'case-edits', `${storyKey}-exploratory.yaml`);

export function readExploration(root: string, runId: string): { report: ExplorationReport; drafts: DraftCase[] } {
  const dir = exploreDir(root, runId);
  return {
    report: ExplorationReport.parse(JSON.parse(readFileSync(join(dir, 'exploration.json'), 'utf8'))),
    drafts: z.array(DraftCase).parse(JSON.parse(readFileSync(join(dir, 'draft-cases.json'), 'utf8'))),
  };
}

export interface PromoteResult {
  caseId: string;
  reviewStatus: TestCase['reviewStatus'];
  approvalId: string;
  editsFile: string;
}

/** Human promotion of one reviewed finding into a story case (case-edits file `<story>-exploratory.yaml`). */
export function promoteFinding(o: {
  root: string;
  runId: string;
  findingId: string;
  by: string;
  storyKey: string;
  orgId: string;
  now?: Date;
}): PromoteResult {
  const { report, drafts } = readExploration(o.root, o.runId);
  const f = report.findings.find((x) => x.id === o.findingId);
  const d = drafts.find((x) => x.findingId === o.findingId);
  if (!f || !d) throw new Error(`no finding ${o.findingId} in ${o.runId}`);
  if (f.promoted) throw new Error(`${o.findingId} was already promoted (${f.testCaseId ?? '?'})`);
  const blocking = d.review.filter((n) => n.blocking);
  if (blocking.length) throw new Error(`${o.findingId} cannot be promoted: ${blocking.map((n) => n.text).join('; ')}`);
  const ids = new TestCaseIdStore(o.storyKey, join(o.root, '.qa-memory'));
  const caseId = ids.idFor(`exploratory|${o.findingId}`);
  ids.save();
  const decisionId = o.findingId.replace(/[^A-Z0-9-]/gi, '-').toUpperCase();
  const decisionRef = caseEditEvidenceId(o.storyKey, decisionId);
  const allAssertable = d.testCase.steps.every((s) => isAssertable(s.expected.evidenceLevel));
  const tc = TestCase.parse({
    ...d.testCase,
    id: caseId,
    // Ledger ids live in .qa-memory: the promoted case cites the recorded decision (which quotes them) + org components.
    steps: d.testCase.steps.map((s) => ({
      ...s,
      expected: {
        ...s.expected,
        evidenceIds: [...s.expected.evidenceIds.filter((e) => COMPONENT.test(e)), decisionRef],
      },
    })),
    reviewStatus: allAssertable ? 'APPROVED' : 'REVIEW_REQUIRED',
    reviewReasons: allAssertable
      ? []
      : ['promoted exploratory case: observed behaviour, accept it as a requirement before it is asserted'],
  });
  const sha = createHash('sha256').update(JSON.stringify(tc)).digest('hex');
  const approval = new ApprovalStore(join(o.root, '.qa-memory', 'approvals.jsonl')).record({
    checkpoint: PROMOTE_CHECKPOINT,
    subject: `explore-finding:${o.findingId}@${sha.slice(0, 16)}`,
    orgId: o.orgId,
    approvedBy: o.by,
    runId: o.runId,
    note: `promoted to ${caseId}: ${tc.title}`,
  });
  // Case-edits file the build can read alongside the story's own edits (qa build --case-edits a.yaml,b.yaml).
  const file = exploratoryEditsFile(o.root, o.storyKey);
  const doc = existsSync(file)
    ? (parse(readFileSync(file, 'utf8')) as Record<string, unknown>)
    : {
        storyKey: o.storyKey,
        decidedBy: o.by,
        decidedOn: (o.now ?? new Date()).toISOString().slice(0, 10),
        decisions: [],
        addCases: [],
      };
  const decisions = (doc['decisions'] as unknown[] | undefined) ?? [];
  const addCases = (doc['addCases'] as unknown[] | undefined) ?? [];
  decisions.push({
    id: decisionId,
    text: `Exploration ${o.runId} (${report.environment}) finding ${o.findingId}, reviewed and promoted by ${o.by} (${approval.id}): ${f.observation}. Evidence: ${f.evidenceIds.join(', ')}.`,
  });
  addCases.push(tc);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `# Exploratory findings promoted by a human (qa explore promote). Read by: qa build --case-edits examples/case-edits/${o.storyKey}.yaml,${file.split(/[\\/]/).pop() ?? ''}\n${stringify({ ...doc, decisions, addCases })}`,
  );
  // Mark the finding promoted in the run's report.
  const updated = {
    ...report,
    findings: report.findings.map((x) =>
      x.id === o.findingId
        ? {
            ...x,
            testCaseId: caseId,
            promoted: { by: o.by, at: (o.now ?? new Date()).toISOString(), approvalId: approval.id },
          }
        : x,
    ),
  };
  writeFileSync(
    join(exploreDir(o.root, o.runId), 'exploration.json'),
    `${JSON.stringify(ExplorationReport.parse(updated), null, 2)}\n`,
  );
  return { caseId, reviewStatus: tc.reviewStatus, approvalId: approval.id, editsFile: file };
}
