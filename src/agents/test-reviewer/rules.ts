import type { ReviewRule, TestCase } from '../../core/schemas/index.js';
import { groundingProblems } from '../../oracles/index.js';
import { jaccard } from '../spec-analyst/lint.js';
import type { PlannerContext } from '../test-planner/graph.js';

/** A finding before ids/round/status are assigned. `key` identifies "the same finding" across review rounds. */
export interface FindingDraft {
  key: string;
  severity: 'H' | 'M' | 'L';
  rule: ReviewRule;
  caseIds: string[];
  requirementIds: string[];
  refs: string[];
  text: string;
}

const VAGUE =
  /\b(works?( correctly| fine| properly)?|as expected|is correct|properly|appropriately|successfully)\s*\.?\s*$/i;
/** Restates the rule instead of naming what is observed ("the system enforces the requirement"). */
const RESTATES =
  /\b(as per|according to)\b.*\b(rule|requirement)|\b(system )?(enforces|validates|handles|applies|checks)\b/i;
const words = (t: string): Set<string> =>
  new Set(
    t
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2),
  );

/**
 * Test Reviewer pass 1, deterministic part (test-design skill checklist). Pure function of the current design; run
 * again every round so fixed problems disappear (RESOLVED by recheck) and unfixed ones stay.
 */
export function deterministicFindings(ctx: PlannerContext, cases: readonly TestCase[]): FindingDraft[] {
  const out: FindingDraft[] = [];
  const add = (f: FindingDraft): void => {
    if (!out.some((x) => x.key === f.key)) out.push(f);
  };
  const casesFor = (obId: string): TestCase[] => cases.filter((c) => c.obligationIds.includes(obId));
  const reqIds = new Set(ctx.requirements.map((r) => r.id));
  const obById = new Map(ctx.obligations.map((o) => [o.id, o]));

  // every obligation (incl. every AC) has a case
  for (const o of ctx.obligations) {
    if (!casesFor(o.id).length) {
      add({
        key: `uncovered:${o.id}`,
        severity: o.isAc || o.tier === 'mandatory' ? 'H' : 'M',
        rule: o.isAc ? 'ac-positive' : 'obligation-uncovered',
        caseIds: [],
        requirementIds: [o.requirementId],
        refs: o.ref === '*' ? [] : [o.ref],
        text: `${o.id} (${o.kind}, ${o.ref}) has no test case: ${o.detail}`,
      });
    }
  }

  for (const r of ctx.requirements) {
    const rc = cases.filter((c) => c.requirementIds.includes(r.id));
    // validation rules need a negative case
    if (r.type === 'validation' && rc.length && !rc.some((c) => c.type === 'negative')) {
      add({
        key: `negative:${r.id}`,
        severity: 'M',
        rule: 'ac-negative',
        caseIds: rc.map((c) => c.id),
        requirementIds: [r.id],
        refs: [],
        text: `${r.id} is a validation rule but none of its cases is a negative case (${rc.map((c) => c.id).join(', ')})`,
      });
    }
    // permission requirements need a deny case as a non-admin persona
    if (r.type === 'security' && !rc.some((c) => c.type === 'security' && c.persona !== ctx.defaultPersona)) {
      add({
        key: `deny:${r.id}`,
        severity: 'H',
        rule: 'deny-missing',
        caseIds: rc.map((c) => c.id),
        requirementIds: [r.id],
        refs: [],
        text: `${r.id} is a permission requirement without a deny case run as a non-admin persona`,
      });
    }
    // High risks need an executable case
    const risk = ctx.risks.find((k) => k.requirementIds.includes(r.id));
    if (risk && risk.impact === 'H' && rc.length && !rc.some((c) => c.reviewStatus === 'APPROVED')) {
      add({
        key: `highrisk:${r.id}`,
        severity: 'M',
        rule: 'high-risk-uncovered',
        caseIds: rc.map((c) => c.id),
        requirementIds: [r.id],
        refs: risk.refs,
        text: `High-impact ${risk.id} (${r.id}) has no executable (APPROVED) case: ${[...new Set(rc.flatMap((c) => c.reviewReasons))].slice(0, 3).join('; ')}`,
      });
    }
  }

  // every charter persona is used
  for (const p of ctx.personas) {
    if (!cases.some((c) => c.persona === p.id)) {
      add({
        key: `persona:${p.id}`,
        severity: 'M',
        rule: 'persona-unused',
        caseIds: [],
        requirementIds: [],
        refs: [],
        text: `charter persona "${p.id}" is used by no case (${p.note})`,
      });
    }
  }

  for (const o of ctx.obligations) {
    const oc = casesFor(o.id);
    if (!oc.length) continue;
    // boundary values actually at the boundary
    if (o.kind === 'boundary') {
      const actions = oc.flatMap((c) => c.steps.map((s) => s.action)).join(' ');
      const missing = o.values.filter((v) => !new RegExp(`(?<!\\d)${v}(?!\\d)`).test(actions));
      if (missing.length) {
        add({
          key: `boundary:${o.id}`,
          severity: 'M',
          rule: 'boundary-values',
          caseIds: oc.map((c) => c.id),
          requirementIds: [o.requirementId],
          refs: [o.ref],
          text: `${o.id} boundary values ${missing.join(', ')} are not exercised by ${oc.map((c) => c.id).join(', ')} (need ${o.values.join(' / ')})`,
        });
      }
    }
    // bulk case for automation
    if (o.kind === 'bulk' && !oc.some((c) => c.type === 'bulk' && c.steps.some((s) => /\b200\b/.test(s.action)))) {
      add({
        key: `bulk:${o.id}`,
        severity: 'M',
        rule: 'bulk-missing',
        caseIds: oc.map((c) => c.id),
        requirementIds: [o.requirementId],
        refs: [o.ref],
        text: `${o.id} needs a bulk case (type bulk, 200 records) for ${o.values.join(', ')}`,
      });
    }
  }

  for (const c of cases) {
    // scope creep: unknown requirements / obligations, or out-of-scope items
    const unknownReq = c.requirementIds.filter((r) => !reqIds.has(r));
    const unknownOb = c.obligationIds.filter((o) => !obById.has(o));
    if (unknownReq.length || unknownOb.length || !c.obligationIds.length) {
      add({
        key: `scope:${c.id}`,
        severity: 'H',
        rule: 'scope-creep',
        caseIds: [c.id],
        requirementIds: c.requirementIds.filter((r) => reqIds.has(r)),
        refs: [],
        text: `${c.id} tests something outside the requirements (unknown: ${[...unknownReq, ...unknownOb].join(', ') || 'no obligation'})`,
      });
    }
    const body = `${c.title} ${c.steps.map((s) => s.action).join(' ')}`.toLowerCase();
    for (const item of ctx.outOfScope) {
      for (const phrase of item
        .split(/[,;]|\band\b|\bor\b/i)
        .map((p) => p.trim().toLowerCase())
        .filter((p) => p.length > 4)) {
        if (body.includes(phrase)) {
          add({
            key: `scope:${c.id}:${phrase}`,
            severity: 'H',
            rule: 'scope-creep',
            caseIds: [c.id],
            requirementIds: c.requirementIds,
            refs: [],
            text: `${c.id} touches out-of-scope "${phrase}"`,
          });
        }
      }
    }
    c.steps.forEach((s, n) => {
      const where = `${c.id} step ${String(n + 1)}`;
      const t = s.expected.text.trim();
      if ((VAGUE.test(t) && t.split(/\s+/).length < 8) || (RESTATES.test(t) && t.split(/\s+/).length < 12)) {
        add({
          key: `vague:${c.id}:${String(n)}`,
          severity: 'M',
          rule: 'vague-expectation',
          caseIds: [c.id],
          requirementIds: c.requirementIds,
          refs: c.refs,
          text: `${where}: expected "${s.expected.text}" is not specific or observable`,
        });
      }
      if (s.expected.text.startsWith('As stated in ')) return; // mechanical: verbatim evidence, grounded by construction
      for (const g of groundingProblems(
        ctx.index,
        s.expected.text,
        s.expected.evidenceIds,
        `${s.action} ${c.preconditions.join(' ')}`,
      )) {
        add({
          key: `ground:${c.id}:${String(n)}:${g.value}`,
          severity: 'H',
          rule: 'ungrounded-expectation',
          caseIds: [c.id],
          requirementIds: c.requirementIds,
          refs: c.refs,
          text: `${where}: ${g.message}`,
        });
      }
    });
  }

  // duplicates: same persona + requirements + (same obligations or near-identical steps)
  for (let a = 0; a < cases.length; a++) {
    for (let b = a + 1; b < cases.length; b++) {
      const x = cases[a];
      const y = cases[b];
      if (!x || !y || x.persona !== y.persona || x.requirementIds.join() !== y.requirementIds.join()) continue;
      const sameObs = x.obligationIds.slice().sort().join() === y.obligationIds.slice().sort().join();
      const sim = jaccard(
        words(x.steps.map((s) => `${s.action} ${s.expected.text}`).join(' ')),
        words(y.steps.map((s) => `${s.action} ${s.expected.text}`).join(' ')),
      );
      if (sameObs || sim >= 0.85) {
        add({
          key: `dup:${x.id}:${y.id}`,
          severity: 'L',
          rule: 'duplicate',
          caseIds: [x.id, y.id],
          requirementIds: x.requirementIds,
          refs: [],
          text: `${x.id} and ${y.id} look like duplicates (${sameObs ? 'same obligations' : `step similarity ${sim.toFixed(2)}`}, same persona)`,
        });
      }
    }
  }
  return out;
}

/** Stable "same finding" key for judge findings (rule + cases + first words). */
export function judgeKey(f: { caseIds: readonly string[]; requirementIds: readonly string[]; text: string }): string {
  return `judge:${[...f.caseIds].sort().join(',')}:${[...f.requirementIds].sort().join(',')}:${f.text.toLowerCase().split(/\W+/).slice(0, 6).join(' ')}`;
}
