// Operator edits to the wording of reviewed test cases (e.g. a test value that does not exist in the org). An edit
// replaces exact text in one step; it never changes a case's expected result evidence or review status, and an
// edit that matches nothing is an error (no silent drift). Applied by `qa build --case-edits <file>`.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import type { TestCase } from '../core/schemas/testCase.js';

export const CaseEditsFile = z.object({
  storyKey: z.string().min(1),
  decidedBy: z.string().min(1),
  decidedOn: z.string().min(1),
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
    .min(1),
});
export type CaseEditsFile = z.infer<typeof CaseEditsFile>;

export function loadCaseEdits(file: string): CaseEditsFile {
  return CaseEditsFile.parse(parse(readFileSync(file, 'utf8')));
}

/** Applies the edits to copies of the cases; returns the edited cases and one line per change. */
export function applyCaseEdits(cases: TestCase[], f: CaseEditsFile): { cases: TestCase[]; changes: string[] } {
  const out = structuredClone(cases);
  const changes: string[] = [];
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
  return { cases: out, changes };
}
