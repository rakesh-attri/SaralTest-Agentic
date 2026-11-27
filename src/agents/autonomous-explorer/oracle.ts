// What the org's own declared configuration says a Save should do with the current form values (CLAUDE.md rule 12:
// expectations only from evidence). Sources: required fields + lengths + email type (describe in the snapshot) and the
// active validation rules (formula subset evaluator shared with the fixture). A formula outside the subset makes the
// prediction `unknown`, never a guess.
import { errorConditionHolds, FormulaError } from '../../fixture/formula.js';
import type { SnapshotFacts } from '../../sf/data/plan.js';

export interface Reason {
  kind: 'required' | 'format' | 'rule' | 'length';
  /** Component id, e.g. Field:Contact.LastName or ValidationRule:Contact.Phone_Must_Be_10_Digits. */
  ref: string;
  message: string;
}

export interface Prediction {
  verdict: 'reject' | 'accept' | 'unknown';
  reasons: Reason[];
  unknown: string[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** values: Contact API field → value as typed (truncation already applied by the input). */
export function predictSave(
  values: Record<string, string>,
  facts: SnapshotFacts | undefined,
  object = 'Contact',
): Prediction {
  const reasons: Reason[] = [];
  const unknown: string[] = [];
  if (!facts) return { verdict: 'unknown', reasons, unknown: ['no snapshot of the org'] };
  for (const f of facts.requiredFields(object)) {
    const api = f.apiName.split('.').pop() ?? f.apiName;
    if (api in values || ['LastName'].includes(api)) {
      if (!values[api]) reasons.push({ kind: 'required', ref: `Field:${f.apiName}`, message: `${api} is required` });
    }
  }
  for (const [api, v] of Object.entries(values)) {
    const f = facts.field(object, api);
    if (!f || !v) continue;
    if (f.type === 'email' && !EMAIL.test(v))
      reasons.push({ kind: 'format', ref: `Field:${f.apiName}`, message: `${api} is not an email address` });
    if (f.length && v.length > f.length)
      reasons.push({ kind: 'length', ref: `Field:${f.apiName}`, message: `${api} longer than ${String(f.length)}` });
  }
  const record: Record<string, unknown> = { ...values };
  for (const vr of facts.activeValidationRules(object)) {
    const formula =
      typeof vr.body?.['errorConditionFormula'] === 'string' ? vr.body['errorConditionFormula'] : undefined;
    if (!formula) {
      unknown.push(`${vr.apiName}: formula not readable`);
      continue;
    }
    try {
      if (errorConditionHolds(formula, record)) {
        reasons.push({
          kind: 'rule',
          ref: `ValidationRule:${vr.apiName}`,
          message: typeof vr.body?.['errorMessage'] === 'string' ? vr.body['errorMessage'] : vr.apiName,
        });
      }
    } catch (e) {
      unknown.push(`${vr.apiName}: ${e instanceof FormulaError ? e.message : String(e)}`);
    }
  }
  const blocking = reasons.filter((r) => r.kind !== 'length');
  return { verdict: blocking.length ? 'reject' : unknown.length ? 'unknown' : 'accept', reasons, unknown };
}
