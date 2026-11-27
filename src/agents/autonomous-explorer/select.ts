// Evidence-gain step selection: score every approved, applicable, untried action in the current state; the model (if
// any) may pick among the top candidates with a reason, the deterministic score otherwise. Saves are worth most when
// the oracle predicts a rejection the org has not yet been seen to enforce, or when the form state was never saved.
import type { ActionDef } from './catalog.js';
import { KIND_WEIGHT } from './catalog.js';
import type { Prediction } from './oracle.js';
import type { FormClasses, StateMap } from './stateMap.js';

export interface Candidate {
  action: ActionDef;
  score: number;
  parts: string[];
}

export interface SelectInput {
  catalog: readonly ActionDef[];
  state: string;
  dialogOpen: boolean;
  form: FormClasses;
  map: StateMap;
  savesLeft: number;
  /** Form signatures already saved (no evidence in saving the same form twice). */
  savedForms: ReadonlySet<string>;
  prediction: Prediction;
  /** Fields with an active rule / required / format constraint (from the snapshot). */
  constrainedFields: ReadonlySet<string>;
}

export const formKey = (form: FormClasses): string =>
  JSON.stringify(
    Object.entries(form)
      .filter(([, v]) => v)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

/** Actions that make sense in the state (dialog open or not). */
export function applicable(catalog: readonly ActionDef[], dialogOpen: boolean): ActionDef[] {
  return catalog.filter((a) => (a.kind === 'open-dialog' ? !dialogOpen : dialogOpen));
}

export function candidates(i: SelectInput): Candidate[] {
  const tried = i.map.triedIn(i.state);
  const out: Candidate[] = [];
  for (const a of applicable(i.catalog, i.dialogOpen)) {
    if (tried.has(a.id)) continue;
    const parts: string[] = [];
    let score = KIND_WEIGHT[a.kind];
    parts.push(`${a.kind} ${String(KIND_WEIGHT[a.kind])}`);
    if (a.target && i.constrainedFields.has(a.target)) {
      score += 2;
      parts.push('constrained field +2');
    }
    if ((a.kind === 'fill' || a.kind === 'clear') && a.target && i.form[a.target] === (a.valueClass ?? '')) {
      score -= 5; // already in the form
      parts.push('same value -5');
    }
    if (a.kind === 'save-attempt') {
      if (i.savesLeft <= 0) continue;
      const fresh = !i.savedForms.has(formKey(i.form));
      if (!fresh) continue;
      if (i.prediction.verdict === 'reject') {
        score += 3;
        parts.push(`org rules predict a rejection (${i.prediction.reasons.map((r) => r.kind).join(', ')}) +3`);
      }
      if (!Object.values(i.form).some(Boolean)) {
        score -= 2;
        parts.push('empty form -2');
      }
    }
    if (a.kind === 'cancel' || a.kind === 'escape') {
      // interruptions late: after the form has been explored a little
      if (Object.values(i.form).filter(Boolean).length < 2) score -= 1;
    }
    const n = i.map.timesTried(a.id);
    if (n) {
      score -= n;
      parts.push(`tried ${String(n)}× elsewhere -${String(n)}`);
    }
    out.push({ action: a, score, parts });
  }
  return out.sort((x, y) => y.score - x.score || x.action.id.localeCompare(y.action.id));
}
