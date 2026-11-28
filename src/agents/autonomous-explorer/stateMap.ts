// Visited / unvisited state map (PLAN Phase 7: "visited/unvisited state map, evidence-gain step selection"). A state is
// what the user can see that matters for the charter: page, dialog, invalid fields, message kinds and which fields hold
// which value class. Finished states (every catalog action tried) are never revisited.
import { createHash } from 'node:crypto';
import type { StateEdge, StateNode } from '../../core/schemas/index.js';

export interface Observation {
  page: string;
  dialog?: string;
  /** Fields marked invalid (aria-invalid). */
  invalidFields: string[];
  /** Normalised message texts visible (field errors, page error, toast). */
  messages: string[];
  /** Fields the UI marks required. */
  requiredMarked: string[];
  url: string;
}

/** Value class per field label in the current form ('' = empty). */
export type FormClasses = Record<string, string>;

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 120);

export function signatureOf(o: Observation, form: FormClasses): { id: string; signature: string } {
  const sig = JSON.stringify({
    page: o.page,
    dialog: o.dialog ?? '',
    invalid: [...o.invalidFields].sort(),
    messages: [...new Set(o.messages.map(norm))].sort(),
    form: Object.entries(form)
      .filter(([, v]) => v)
      .sort(([a], [b]) => a.localeCompare(b)),
  });
  return { id: createHash('sha256').update(sig).digest('hex').slice(0, 12), signature: sig };
}

export class StateMap {
  readonly nodes = new Map<string, StateNode>();
  readonly edges: StateEdge[] = [];
  /** Actions tried per state. */
  private readonly tried = new Map<string, Set<string>>();

  visit(id: string, o: Observation, signature: string, step: number): { node: StateNode; isNew: boolean } {
    const prev = this.nodes.get(id);
    if (prev) {
      prev.visits += 1;
      return { node: prev, isNew: false };
    }
    const node: StateNode = {
      id,
      page: o.page,
      ...(o.dialog ? { dialog: o.dialog } : {}),
      signature,
      visits: 1,
      finished: false,
      firstSeenStep: step,
    };
    this.nodes.set(id, node);
    return { node, isNew: true };
  }

  markTried(state: string, action: string, applicable: readonly string[]): void {
    const set = this.tried.get(state) ?? new Set<string>();
    set.add(action);
    this.tried.set(state, set);
    const node = this.nodes.get(state);
    if (node) node.finished = applicable.every((a) => set.has(a));
  }

  triedIn(state: string): ReadonlySet<string> {
    return this.tried.get(state) ?? new Set();
  }

  /** How often an action was tried anywhere (diminishing returns). */
  timesTried(action: string): number {
    let n = 0;
    for (const s of this.tried.values()) if (s.has(action)) n++;
    return n;
  }

  edge(from: string, to: string, actionId: string, step: number): void {
    this.edges.push({ from, to, actionId, step });
  }
}
