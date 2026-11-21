// Human checkpoints (PLAN.md §7d, config/policy.yaml `checkpoints` + `approvals`): which checkpoints wait at the
// run's autonomy level, and a persistent record of who approved what (`.qa-memory/approvals.jsonl`).
// An approval is per subject (e.g. one recipe version) and per org; a changed recipe needs a new approval.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PolicyConfig } from '../config/schemas.js';
import { Approval } from '../core/schemas/data.js';
import type { Autonomy } from '../core/state.js';

export const NEW_RECIPE_CHECKPOINT = 'new-data-recipe-or-mutation-type';

/** True when `checkpoint` waits for a human at this autonomy level. */
export function checkpointRequired(policy: PolicyConfig, autonomy: Autonomy, checkpoint: string): boolean {
  const a = policy.approvals[autonomy];
  return a === 'all' || a.includes(checkpoint);
}

export const recipeSubject = (recipe: string, hash: string): string => `recipe:${recipe}@${hash}`;

export class ApprovalStore {
  constructor(readonly file: string) {}

  all(): Approval[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => Approval.parse(JSON.parse(l)));
  }

  find(checkpoint: string, subject: string, orgId: string): Approval | undefined {
    return this.all().find((a) => a.checkpoint === checkpoint && a.subject === subject && a.orgId === orgId);
  }

  record(input: Omit<Approval, 'id' | 'approvedAt'> & { approvedAt?: string }): Approval {
    const approvedAt = input.approvedAt ?? new Date().toISOString();
    const id = `AP-${createHash('sha256')
      .update(`${input.checkpoint}|${input.subject}|${input.orgId}|${approvedAt}`)
      .digest('hex')
      .slice(0, 12)}`;
    const a = Approval.parse({ ...input, id, approvedAt });
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(a)}\n`, 'utf8');
    return a;
  }
}
