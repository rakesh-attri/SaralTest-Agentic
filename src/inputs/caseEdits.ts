// Operator edits to the wording of reviewed test cases (e.g. a test value that does not exist in the org). An edit
// replaces exact text in one step; it never changes a case's expected result evidence or review status, and an
// edit that matches nothing is an error (no silent drift). Applied by `qa build --case-edits <file>`.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { isAssertable, TestCase } from '../core/schemas/testCase.js';

export const CaseEditsFile = z.object({
  storyKey: z.string().min(1),
  decidedBy: z.string().min(1),
  decidedOn: z.string().min(1),
  /** Cases the operator rules not automatable: excluded from generation, kept in the RTM as manual. */
  manualOnly: z.array(z.object({ caseId: z.string().min(1), reason: z.string().min(1) })).default([]),
  edits: z
    .array(
      z.object({
        caseId: z.string().min(1),
        /** 1-based case step. */
        step: z.number().int().positive(),
        field: z.enum(['action', 'expected']).default('action'),
        from: z.string().min(1),
        to: z.string().min(1),
        reason: z.string().min(1),
      }),
    )
    .default([]),
  /**
   * Steps the operator rules not automatable inside an otherwise automatable case (e.g. "confirm manual test MTC-009
   * passed"): removed from the generated test, listed in the changes. 1-based, numbered as in the design run; applied
   * after the text edits. A case keeps at least one step.
   */
  dropSteps: z
    .array(z.object({ caseId: z.string().min(1), step: z.number().int().positive(), reason: z.string().min(1) }))
    .default([]),
  // ---- Phase 7 (operator 2026-11-27, BR-08): structured edits a reviewer can check. None changes an expected result.
  /** Preconditions the design run lost or never wrote (e.g. TC-031's "Contact with an open Case"). */
  preconditions: z
    .array(z.object({ caseId: z.string().min(1), add: z.array(z.string().min(1)).min(1), reason: z.string().min(1) }))
    .default([]),
  /** Bind an approved data recipe (examples/recipes/<name>.yaml) to a case. */
  dataRecipe: z
    .array(z.object({ caseId: z.string().min(1), recipe: z.string().regex(/^[a-z0-9-]+$/), reason: z.string().min(1) }))
    .default([]),
  /**
   * Operator approval of a REVIEW_REQUIRED case after its findings are resolved (e.g. RF-004 "add the positive
   * counterpart" → the counterpart is added below). Code refuses it unless every expectation is assertable.
   */
  approve: z
    .array(
      z.object({
        caseId: z.string().min(1),
        findingIds: z.array(z.string().min(1)).default([]),
        resolution: z.string().min(1),
      }),
    )
    .default([]),
  /**
   * Operator decisions recorded with the edits (e.g. the positive counterpart of BR-08). Cited as
   * `<storyKey>-CASE-EDITS#<id>` by operator-added cases; the investigator resolves them like source sections.
   */
  decisions: z.array(z.object({ id: z.string().regex(/^[A-Z0-9-]+$/), text: z.string().min(10) })).default([]),
  /** Operator-authored cases (origin 'operator'); evidence ids must exist in the design run or in `decisions`. */
  addCases: z.array(z.unknown()).default([]),
});
export type CaseEditsFile = z.infer<typeof CaseEditsFile>;

/** Evidence id of an operator decision recorded in a case-edits file. */
export const caseEditEvidenceId = (storyKey: string, id: string): string => `${storyKey}-CASE-EDITS#${id}`;

export function loadCaseEdits(file: string): CaseEditsFile {
  return CaseEditsFile.parse(parse(readFileSync(file, 'utf8')));
}

/**
 * Applies the edits to copies of the cases; returns the edited cases and one line per change. `knownEvidence` (ids
 * of the design run's evidence) is required for `addCases`: an added case may only cite evidence that exists.
 */
export function applyCaseEdits(
  cases: TestCase[],
  f: CaseEditsFile,
  knownEvidence?: ReadonlySet<string>,
): { cases: TestCase[]; changes: string[] } {
  const out = structuredClone(cases);
  const changes: string[] = [];
  const by = ` — ${f.decidedBy}, ${f.decidedOn}`;
  const known = new Set([...(knownEvidence ?? []), ...f.decisions.map((d) => caseEditEvidenceId(f.storyKey, d.id))]);
  for (const raw of f.addCases) {
    const r0 = raw as { origin?: unknown };
    const tc = TestCase.parse({ ...r0, origin: r0.origin ?? 'operator' });
    if (tc.origin !== 'operator' && tc.origin !== 'exploratory')
      throw new Error(`added case ${tc.id}: origin must be operator or exploratory (a promoted finding)`);
    if (out.some((c) => c.id === tc.id)) throw new Error(`added case ${tc.id} already exists in the design run`);
    const unknown = tc.steps
      .flatMap((st) => st.expected.evidenceIds)
      .filter((id) => !known.has(id) && !/^(Field|ValidationRule|DuplicateRule|SObject):[A-Za-z0-9_.]+$/.test(id));
    if (unknown.length)
      throw new Error(
        `added case ${tc.id} cites evidence the design run does not have: ${[...new Set(unknown)].join(', ')}`,
      );
    out.push(tc);
    changes.push(`${tc.id} added by the operator (${tc.reviewStatus}): ${tc.title}${by}`);
  }
  for (const e of f.preconditions) {
    const tc = out.find((c) => c.id === e.caseId);
    if (!tc) throw new Error(`preconditions: ${e.caseId} is not a case of this design run`);
    const add = e.add.filter((x) => !tc.preconditions.includes(x));
    tc.preconditions.push(...add);
    changes.push(`${e.caseId} preconditions + ${add.map((x) => `"${x}"`).join(', ')} (${e.reason})`);
  }
  for (const e of f.dataRecipe) {
    const tc = out.find((c) => c.id === e.caseId);
    if (!tc) throw new Error(`data recipe: ${e.caseId} is not a case of this design run`);
    tc.dataRecipe = e.recipe;
    changes.push(`${e.caseId} data recipe → ${e.recipe} (${e.reason})`);
  }
  for (const e of f.edits) {
    const tc = out.find((c) => c.id === e.caseId);
    if (!tc) throw new Error(`case edit: ${e.caseId} is not a case of this design run`);
    const st = tc.steps[e.step - 1];
    if (!st) throw new Error(`case edit: ${e.caseId} has no step ${String(e.step)}`);
    const text = e.field === 'action' ? st.action : st.expected.text;
    if (!text.includes(e.from))
      throw new Error(`case edit: ${e.caseId} step ${String(e.step)} ${e.field} has no "${e.from}"`);
    const next = text.split(e.from).join(e.to);
    if (e.field === 'action') st.action = next;
    else st.expected.text = next;
    changes.push(`${e.caseId} step ${String(e.step)} ${e.field}: "${e.from}" → "${e.to}" (${e.reason})`);
  }
  const drops = [...f.dropSteps].sort((x, y) => y.step - x.step); // highest first: earlier numbers stay valid
  for (const d of drops) {
    const tc = out.find((c) => c.id === d.caseId);
    if (!tc) throw new Error(`drop step: ${d.caseId} is not a case of this design run`);
    if (!tc.steps[d.step - 1]) throw new Error(`drop step: ${d.caseId} has no step ${String(d.step)}`);
    if (tc.steps.length === 1) throw new Error(`drop step: ${d.caseId} would have no step left`);
    const [gone] = tc.steps.splice(d.step - 1, 1);
    changes.push(`${d.caseId} step ${String(d.step)} removed: "${gone?.action ?? ''}" (${d.reason})`);
  }
  for (const m of f.manualOnly) {
    const tc = out.find((c) => c.id === m.caseId);
    if (!tc) throw new Error(`manual-only: ${m.caseId} is not a case of this design run`);
    tc.execution = 'manual';
    tc.executionReason = m.reason;
    changes.push(`${m.caseId} manual-only (${m.reason})`);
  }
  for (const a of f.approve) {
    const tc = out.find((c) => c.id === a.caseId);
    if (!tc) throw new Error(`approve: ${a.caseId} is not a case of this design run`);
    const weak = tc.steps.map((st, i) => (isAssertable(st.expected.evidenceLevel) ? -1 : i + 1)).filter((i) => i > 0);
    if (weak.length)
      throw new Error(
        `approve: ${a.caseId} steps ${weak.join(', ')} are not assertable — a case can only be approved when every expectation is`,
      );
    const before = tc.reviewStatus;
    tc.reviewStatus = 'APPROVED';
    tc.reviewReasons = [];
    changes.push(
      `${a.caseId} ${before} → APPROVED${a.findingIds.length ? ` (resolves ${a.findingIds.join(', ')})` : ''}: ${a.resolution}${by}`,
    );
  }
  return { cases: out, changes };
}
