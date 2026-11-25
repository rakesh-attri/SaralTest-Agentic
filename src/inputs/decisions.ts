// Operator decisions on an analysed story: answers to clarification questions, deferred requirements and notes on org
// conflicts. Applied deterministically to the outputs of a `qa analyze` run (no model involved), so a design run can
// start from what the human decided instead of from assumptions. Every change is listed in the result.
import { z } from 'zod';
import type { SourceDocument, SourceSection } from '../core/schemas/inputs.js';
import type { AnalysisFinding, Clarification, Requirement } from '../core/schemas/requirement.js';
import { normalizeText, sha256 } from './sections.js';

export const DecisionsFile = z.object({
  storyKey: z.string().min(1),
  /** Who decided (a role or name, never an email or secret). */
  decidedBy: z.string().min(1),
  decidedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  answers: z
    .array(
      z.object({
        /** Clarification id from the analysis run (Q1 …). */
        id: z.string().min(1),
        answer: z.string().min(1),
        /** Analysis findings the answer resolves (removed from the design inputs). */
        resolvesFindings: z.array(z.string()).default([]),
        /** Expected outcomes the answer states, added to the linked requirements when not already there. */
        expectedOutcomes: z.array(z.string()).default([]),
        /**
         * The answer settles every review reason of the linked requirements. Otherwise only the reasons that name
         * this clarification or a resolved finding are removed.
         */
        settlesRequirement: z.boolean().default(false),
      }),
    )
    .default([]),
  deferred: z
    .array(
      z.object({
        requirementId: z.string().min(1),
        reason: z.string().min(1),
        resolvesFindings: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  /** Decisions about org conflicts (C1 …): recorded as context, not as approved requirements. */
  notes: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) })).default([]),
});
export type DecisionsFile = z.infer<typeof DecisionsFile>;

export interface AnalysisInputs {
  sources: SourceDocument[];
  requirements: Requirement[];
  findings: AnalysisFinding[];
  clarifications: Clarification[];
}

export interface DecisionsResult extends AnalysisInputs {
  changes: string[];
}

export const decisionsDocId = (storyKey: string): string => `${storyKey}-DECISIONS`;

/** Apply operator decisions. Unknown ids are errors: a decision that matches nothing must not pass silently. */
export function applyDecisions(input: AnalysisInputs, d: DecisionsFile): DecisionsResult {
  const changes: string[] = [];
  const docId = decisionsDocId(d.storyKey);
  const requirements = input.requirements.map((r) => ({ ...r, reviewReasons: [...r.reviewReasons] }));
  const reqById = new Map(requirements.map((r) => [r.id, r]));
  const removeFindings = new Set<string>();
  const sections: SourceSection[] = [];
  const addSource = (r: Requirement, section: string): void => {
    if (!r.sources.some((s) => s.ref === docId && s.section === section)) {
      r.sources = [...r.sources, { type: 'chat', ref: docId, hash: '', section }];
    }
  };

  const clarifications = input.clarifications.map((c) => ({ ...c }));
  for (const a of d.answers) {
    const c = clarifications.find((x) => x.id === a.id);
    if (!c) throw new Error(`decision ${a.id}: no clarification with that id in the analysis run`);
    for (const f of a.resolvesFindings) {
      if (!input.findings.some((x) => x.id === f)) throw new Error(`decision ${a.id}: unknown finding ${f}`);
      removeFindings.add(f);
    }
    c.status = 'ANSWERED';
    c.answer = a.answer;
    delete c.assumption;
    changes.push(`${c.id} ANSWERED (was ${input.clarifications.find((x) => x.id === a.id)?.status ?? '?'})`);
    sections.push({
      ref: c.id,
      kind: 'rule',
      heading: `Answered clarification (${d.decidedBy}, ${d.decidedOn})`,
      text: `${c.question}\nAnswer: ${a.answer}${a.expectedOutcomes.length ? `\nExpected: ${a.expectedOutcomes.join(' ')}` : ''}`,
    });
    const linked = [...new Set([...(c.requirementId ? [c.requirementId] : []), ...c.requirementIds])];
    for (const id of linked) {
      const r = reqById.get(id);
      if (!r) throw new Error(`decision ${a.id}: linked requirement ${id} not in the analysis run`);
      addSource(r, c.id);
      for (const o of a.expectedOutcomes) {
        if (!r.expectedOutcomes.includes(o)) {
          r.expectedOutcomes.push(o);
          changes.push(`${r.id}: expected outcome added from ${c.id}: ${o}`);
        }
      }
      const before = r.reviewReasons.length;
      r.reviewReasons = a.settlesRequirement
        ? []
        : r.reviewReasons.filter(
            (x) =>
              !new RegExp(`\\b${c.id}\\b`).test(x) &&
              !a.resolvesFindings.some((f) => x.startsWith(`${f} `)) &&
              !(a.expectedOutcomes.length && /^no expected outcome/i.test(x)),
          );
      if (before !== r.reviewReasons.length) {
        changes.push(`${r.id}: ${String(before - r.reviewReasons.length)} review reason(s) settled by ${c.id}`);
      }
    }
  }

  for (const x of d.deferred) {
    const r = reqById.get(x.requirementId);
    if (!r) throw new Error(`deferred ${x.requirementId}: not in the analysis run`);
    for (const f of x.resolvesFindings) {
      if (!input.findings.some((y) => y.id === f)) throw new Error(`deferred ${x.requirementId}: unknown finding ${f}`);
      removeFindings.add(f);
    }
    const ref = `DEFER-${r.id}`;
    r.status = 'DEFERRED';
    r.reviewReasons = [`deferred by ${d.decidedBy} on ${d.decidedOn}: ${x.reason}`];
    addSource(r, ref);
    sections.push({
      ref,
      kind: 'out-of-scope',
      heading: `Deferred requirement (${d.decidedBy}, ${d.decidedOn})`,
      text: `${r.id} (${r.title ?? r.businessObjective}) is out of scope for now: ${x.reason}`,
    });
    changes.push(`${r.id} DEFERRED: ${x.reason}`);
  }

  for (const n of d.notes) {
    sections.push({ ref: n.id, kind: 'text', heading: `Decision ${n.id}`, text: n.text });
    changes.push(`${n.id} recorded: ${n.text}`);
  }

  // Requirement status follows what is left: no reasons and a stated outcome → EXECUTABLE.
  for (const r of requirements) {
    if (r.status === 'REVIEW_REQUIRED' && !r.reviewReasons.length && r.expectedOutcomes.length) {
      r.status = 'EXECUTABLE';
      changes.push(`${r.id} EXECUTABLE (review reasons settled by decisions)`);
    }
  }

  const findings = input.findings.filter((f) => !removeFindings.has(f.id)).map((f) => ({ ...f }));
  for (const f of removeFindings) changes.push(`finding ${f} resolved by decision`);

  const text = normalizeText(sections.map((s) => `${s.ref}: ${s.heading ?? ''}\n${s.text}`).join('\n\n'));
  const hash = sha256(text);
  const doc: SourceDocument = {
    docId,
    source: { type: 'chat', ref: docId, hash },
    title: `${d.storyKey} operator decisions (${d.decidedOn})`,
    meta: { format: 'decisions', decidedBy: d.decidedBy, decidedOn: d.decidedOn },
    sections,
    text,
    warnings: [],
  };
  for (const r of requirements) {
    r.sources = r.sources.map((s) => (s.ref === docId ? { ...s, hash } : s));
  }
  return {
    sources: [...input.sources.filter((s) => s.docId !== docId), doc],
    requirements,
    findings,
    clarifications,
    changes,
  };
}
