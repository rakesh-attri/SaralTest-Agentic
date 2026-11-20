import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { QAError } from '../core/errors.js';
import { DataWrite, DataWriteState } from '../core/schemas/data.js';

/**
 * Deterministic idempotency key for one logical write of a run: same run + object + step → same key, so a resumed
 * run recognises a write it already sent. Field values are included so a changed plan is a new write.
 */
export function idempotencyKey(
  runId: string,
  object: string,
  step: string,
  fields: Record<string, unknown> = {},
): string {
  const canonical = JSON.stringify([
    runId,
    object,
    step,
    Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)),
  ]);
  return `qa-${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`;
}

const ALLOWED: Record<DataWriteState, readonly DataWriteState[]> = {
  PLANNED: ['SENT'],
  SENT: ['CONFIRMED', 'UNCERTAIN'],
  UNCERTAIN: ['CONFIRMED', 'PLANNED'], // only via reconcile()
  CONFIRMED: ['CLEANED'],
  CLEANED: [],
};

const LedgerEvent = z.object({
  at: z.string(),
  key: z.string(),
  state: DataWriteState,
  write: DataWrite.optional(),
  recordId: z.string().optional(),
});
type LedgerEvent = z.infer<typeof LedgerEvent>;

/**
 * Write ledger with the DataWrite state machine (safety skill §Writes):
 * PLANNED → SENT → CONFIRMED | UNCERTAIN; UNCERTAIN → reconcile() → CONFIRMED (found) | PLANNED (safe to retry);
 * CONFIRMED → CLEANED. A write may only be sent from PLANNED — never blind-retry an uncertain write.
 * Events are persisted as JSONL so a crashed run can resume.
 */
export class WriteLedger {
  private readonly writes = new Map<string, DataWrite>();

  constructor(readonly file?: string) {
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      if (existsSync(file)) this.replay(file);
    }
  }

  private replay(file: string): void {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
      const ev = LedgerEvent.parse(JSON.parse(line));
      if (ev.write) this.writes.set(ev.key, ev.write);
      const w = this.writes.get(ev.key);
      if (w) this.writes.set(ev.key, { ...w, state: ev.state, ...(ev.recordId ? { recordId: ev.recordId } : {}) });
    }
    // A write that was SENT when the process died has an unknown outcome.
    for (const [k, w] of this.writes) if (w.state === 'SENT') this.writes.set(k, { ...w, state: 'UNCERTAIN' });
  }

  private persist(ev: Omit<LedgerEvent, 'at'>): void {
    if (this.file) appendFileSync(this.file, `${JSON.stringify({ at: new Date().toISOString(), ...ev })}\n`, 'utf8');
  }

  plan(input: { runId: string; object: string; step: string; fields: Record<string, unknown> }): DataWrite {
    const key = idempotencyKey(input.runId, input.object, input.step, input.fields);
    const existing = this.writes.get(key);
    if (existing) return existing;
    const write = DataWrite.parse({
      idempotencyKey: key,
      runId: input.runId,
      object: input.object,
      plannedFields: input.fields,
      state: 'PLANNED',
    });
    this.writes.set(key, write);
    this.persist({ key, state: 'PLANNED', write });
    return write;
  }

  get(key: string): DataWrite | undefined {
    return this.writes.get(key);
  }

  all(): DataWrite[] {
    return [...this.writes.values()];
  }

  canSend(key: string): boolean {
    return this.writes.get(key)?.state === 'PLANNED';
  }

  transition(key: string, to: DataWriteState, recordId?: string): DataWrite {
    const w = this.writes.get(key);
    if (!w) throw new QAError('DATA', `unknown write ${key}`);
    if (!ALLOWED[w.state].includes(to)) {
      throw new QAError('DATA', `illegal write transition ${w.state} → ${to} for ${key}`, { from: w.state, to });
    }
    const next: DataWrite = { ...w, state: to, ...(recordId ? { recordId } : {}) };
    this.writes.set(key, next);
    this.persist({ key, state: to, ...(recordId ? { recordId } : {}) });
    return next;
  }

  /**
   * Resolve an UNCERTAIN write by asking the org whether a record with this key exists (e.g. SOQL on the run-tag /
   * idempotency field). Found → CONFIRMED; not found → PLANNED (now safe to send again).
   */
  async reconcile(key: string, lookup: (key: string) => Promise<string | undefined>): Promise<DataWrite> {
    const w = this.writes.get(key);
    if (!w) throw new QAError('DATA', `unknown write ${key}`);
    if (w.state !== 'UNCERTAIN') return w;
    const recordId = await lookup(key);
    return recordId ? this.transition(key, 'CONFIRMED', recordId) : this.transition(key, 'PLANNED');
  }
}
