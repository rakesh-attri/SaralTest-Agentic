// Test data engine — execution (PLAN.md §7e, salesforce-test-data skill steps 6–10): create in dependency order
// with idempotency keys → read back & verify → negative variants (rejection only) → reverse-order cleanup of
// run-owned records → independent re-query → cleanup/reconciliation report. Every write goes through
// GuardedSalesforce (org-profile guard + write-ahead audit); every state change goes through the WriteLedger.
import type { OrgEntry } from '../../config/schemas.js';
import { classifyError } from '../../core/classifyError.js';
import { HardStopError, QAError } from '../../core/errors.js';
import {
  CleanupReport,
  type CleanupEntry,
  type CreatedRecord,
  type DataPlan,
  type DataPlanStep,
  type DataWrite,
  type NegativeOutcome,
  type RecordVerification,
} from '../../core/schemas/data.js';
import type { WriteLedger } from '../../security/idempotency.js';
import type { GuardedSalesforce } from '../client.js';

export type DataClient = Pick<GuardedSalesforce, 'query' | 'create' | 'update' | 'destroy'>;

export interface DataEngineOptions {
  sf: DataClient;
  plan: DataPlan;
  ledger: WriteLedger;
  org: OrgEntry;
  log?: (m: string) => void;
  now?: () => Date;
  /** Errors whose outcome is unknown (timeout, connection reset): default = classified TRANSIENT. */
  isUncertain?: (err: unknown) => boolean;
}

/** SOQL string literal (bind-safe quoting). */
export const soqlString = (v: string): string => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const KNOWN_CODES =
  /\b(REQUIRED_FIELD_MISSING|FIELD_CUSTOM_VALIDATION_EXCEPTION|DUPLICATES_DETECTED|DUPLICATE_VALUE|STRING_TOO_LONG|INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST|INVALID_CROSS_REFERENCE_KEY|INVALID_FIELD|INVALID_EMAIL_ADDRESS|FIELD_INTEGRITY_EXCEPTION|ENTITY_IS_DELETED|INSUFFICIENT_ACCESS_OR_READONLY|CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY)\b/g;

/** Salesforce error codes carried by a jsforce / REST error (errorCode, name, body, message). */
export function sfErrorCodes(err: unknown): string[] {
  const out = new Set<string>();
  const bag = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {};
  for (const k of ['errorCode', 'name']) {
    const v = bag[k];
    if (typeof v === 'string' && /^[A-Z_]{5,}$/.test(v)) out.add(v);
  }
  const body = bag['body'] ?? bag['content'] ?? bag['data'];
  const list: unknown[] = Array.isArray(body) ? body : body ? [body] : [];
  for (const b of list) {
    const code = typeof b === 'object' && b !== null ? (b as Record<string, unknown>)['errorCode'] : undefined;
    if (typeof code === 'string') out.add(code);
  }
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  for (const m of msg.matchAll(KNOWN_CODES)) if (m[1]) out.add(m[1]);
  return [...out];
}

const errText = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).split('\n')[0]?.slice(0, 300) ?? 'error';

const sameId = (a: unknown, b: unknown): boolean =>
  typeof a === 'string' && typeof b === 'string' && a.slice(0, 15) === b.slice(0, 15);

const emailDomains = (fields: Record<string, unknown>): string[] =>
  Object.values(fields)
    .filter((v): v is string => typeof v === 'string' && /^[^@\s]+@[^@\s]+$/.test(v))
    .map((v) => v.split('@')[1]?.toLowerCase() ?? '');

export class DataEngine {
  private readonly ids = new Map<string, string>();
  private readonly log: (m: string) => void;
  private readonly now: () => Date;
  private readonly uncertain: (err: unknown) => boolean;
  private adopted = 0;
  private attempts = 0;

  constructor(private readonly o: DataEngineOptions) {
    this.log = o.log ?? (() => undefined);
    this.now = o.now ?? (() => new Date());
    this.uncertain = o.isUncertain ?? ((e) => classifyError(e).kind === 'TRANSIENT');
    // Resume: ids of writes already CONFIRMED in this run's ledger.
    for (const w of o.ledger.all())
      if (w.state === 'CONFIRMED' && w.recordId && w.step) this.ids.set(w.step, w.recordId);
  }

  get plan(): DataPlan {
    return this.o.plan;
  }

  recordId(stepId: string): string {
    const id = this.ids.get(stepId);
    if (!id) throw new QAError('DATA', `no record for data step ${stepId} (create() first)`);
    return id;
  }

  private tagFilter(): string {
    const f = this.o.plan.runTag.field;
    return f ? ` AND ${f} = ${soqlString(this.o.plan.runTag.value)}` : '';
  }

  /** Find a record this run created by its unique key (+ run tag): reconciles UNCERTAIN writes. */
  private async lookup(step: DataPlanStep): Promise<string | undefined> {
    if (!step.uniqueKey.field) return undefined;
    const rows = await this.o.sf.query<{ Id: string }>(
      `SELECT Id FROM ${step.object} WHERE ${step.uniqueKey.field} = ${soqlString(step.uniqueKey.value)}${this.tagFilter()}`,
    );
    if (rows.length > 1) {
      throw new QAError('DATA', `${rows.length} ${step.object} records share the unique key of step ${step.stepId}`);
    }
    return rows[0]?.Id;
  }

  private body(step: { fields: DataPlanStep['fields']; parent?: DataPlanStep['parent'] }): Record<string, unknown> {
    const body: Record<string, unknown> = { ...step.fields };
    if (step.parent) body[step.parent.field] = this.recordId(step.parent.stepId);
    return body;
  }

  private async send(step: DataPlanStep, w: DataWrite, attempt: number): Promise<string> {
    const key = w.idempotencyKey;
    const body = this.body(step);
    this.o.ledger.transition(key, 'SENT');
    try {
      const id = await this.o.sf.create(step.object, body, { emailDomains: emailDomains(body) });
      this.o.ledger.transition(key, 'CONFIRMED', id);
      return id;
    } catch (err) {
      if (err instanceof HardStopError) throw err;
      if (this.uncertain(err)) {
        // Unknown outcome: never blind-retry. Ask the org whether the record exists.
        this.o.ledger.transition(key, 'UNCERTAIN');
        const r = await this.o.ledger.reconcile(key, () => this.lookup(step));
        if (r.state === 'CONFIRMED' && r.recordId) {
          this.log(`  ${step.stepId}: uncertain write reconciled → record exists, adopted`);
          return r.recordId;
        }
        if (attempt < 1) {
          this.log(`  ${step.stepId}: uncertain write reconciled → not created, sending once more`);
          return this.send(step, r, attempt + 1);
        }
      }
      const codes = sfErrorCodes(err);
      if (this.o.ledger.get(key)?.state === 'SENT') {
        this.o.ledger.transition(key, 'FAILED', undefined, codes.join(',') || errText(err));
      }
      throw new QAError('DATA', `create ${step.object} (${step.stepId}) failed: ${codes.join(', ') || errText(err)}`, {
        step: step.stepId,
        codes,
      });
    }
  }

  /**
   * Create plan steps in dependency order (all, or `only` these step ids). Already-confirmed steps (resume) are
   * reused, never re-sent.
   */
  async create(only?: readonly string[]): Promise<CreatedRecord[]> {
    if (!this.o.plan.valid) throw new QAError('DATA', 'the data plan has errors; it cannot be executed');
    const wanted = only ? new Set(only) : undefined;
    for (const p of only ?? []) {
      const parent = this.o.plan.steps.find((s) => s.stepId === p)?.parent?.stepId;
      if (parent && !wanted?.has(parent))
        throw new QAError('DATA', `step ${p} needs its parent ${parent} in the same create`);
    }
    for (const step of [...this.o.plan.steps].sort((a, b) => a.order - b.order)) {
      if (wanted && !wanted.has(step.stepId)) continue;
      let w = this.o.ledger.plan({
        runId: this.o.plan.runId,
        object: step.object,
        step: step.stepId,
        fields: step.fields,
        key: step.idempotencyKey,
        order: step.order,
        ...(step.parent ? { parentRef: step.parent.stepId } : {}),
      });
      if (w.state === 'UNCERTAIN') w = await this.o.ledger.reconcile(w.idempotencyKey, () => this.lookup(step));
      if (w.state === 'CONFIRMED' && w.recordId) {
        this.ids.set(step.stepId, w.recordId);
        this.log(`  ${step.stepId}: already created in this run (${step.object})`);
        continue;
      }
      if (w.state !== 'PLANNED') {
        throw new QAError('DATA', `data step ${step.stepId} is ${w.state}; run qa cleanup and start a new run`);
      }
      const id = await this.send(step, w, 0);
      this.ids.set(step.stepId, id);
      this.log(`  created ${step.object} (${step.stepId})`);
    }
    return this.createdRecords();
  }

  createdRecords(): CreatedRecord[] {
    return this.o.ledger
      .all()
      .filter((w) => (w.state === 'CONFIRMED' || w.state === 'CLEANED') && w.recordId)
      .map((w) => ({
        idempotencyKey: w.idempotencyKey,
        object: w.object,
        recordId: w.recordId ?? '',
        createdAt: this.now().toISOString(),
        order: w.order ?? 0,
        ...(w.step ? { step: w.step } : {}),
        via: (w.order ?? 0) >= 500 && (w.order ?? 0) < 900 ? ('ui' as const) : ('api' as const),
      }));
  }

  /** Read every created record back and compare the planned values (and the parent lookup). */
  async verify(): Promise<RecordVerification[]> {
    const out: RecordVerification[] = [];
    for (const step of this.o.plan.steps) {
      const id = this.ids.get(step.stepId);
      if (!id) continue;
      const fields = [...new Set([...Object.keys(step.fields), ...(step.parent ? [step.parent.field] : [])])];
      const rows = await this.o.sf.query(
        `SELECT Id, ${fields.join(', ')} FROM ${step.object} WHERE Id = ${soqlString(id)}`,
      );
      const row = rows[0];
      const checks = fields.map((f) => {
        const expected: unknown = step.parent?.field === f ? this.ids.get(step.parent.stepId) : step.fields[f];
        const actual = row?.[f];
        const ok =
          step.parent?.field === f
            ? sameId(expected, actual)
            : typeof expected === 'string' && typeof actual === 'string'
              ? expected.toLowerCase() === actual.toLowerCase()
              : expected === actual;
        return { field: f, expected, actual: actual ?? null, ok: Boolean(row) && ok };
      });
      out.push({ stepId: step.stepId, object: step.object, recordId: id, checks, ok: checks.every((c) => c.ok) });
    }
    return out;
  }

  /** Negative variants: only used to assert rejection; an unexpectedly saved record is adopted and cleaned up. */
  async negatives(): Promise<NegativeOutcome[]> {
    const out: NegativeOutcome[] = [];
    let n = 0;
    for (const neg of this.o.plan.negatives) {
      const parent = this.o.plan.steps.find((s) => s.stepId === neg.stepId)?.parent;
      const body = this.body({ fields: neg.fields, ...(parent ? { parent } : {}) });
      const w = this.o.ledger.plan({
        runId: this.o.plan.runId,
        object: neg.object,
        step: `${neg.stepId}:${neg.name}`,
        fields: neg.fields,
        key: neg.idempotencyKey,
        order: 900 + n++,
        ...(parent ? { parentRef: parent.stepId } : {}),
      });
      if (w.state !== 'PLANNED') continue; // resumed run: already attempted
      this.o.ledger.transition(w.idempotencyKey, 'SENT');
      try {
        const id = await this.o.sf.create(neg.object, body, { emailDomains: emailDomains(body) });
        this.o.ledger.transition(w.idempotencyKey, 'CONFIRMED', id);
        out.push({ name: neg.name, object: neg.object, outcome: 'UNEXPECTEDLY_SAVED', errorCodes: [], recordId: id });
        this.log(`  negative ${neg.name}: UNEXPECTEDLY SAVED (adopted for cleanup)`);
      } catch (err) {
        if (err instanceof HardStopError) throw err;
        const codes = sfErrorCodes(err);
        this.o.ledger.transition(w.idempotencyKey, 'FAILED', undefined, codes.join(',') || errText(err));
        const expected = codes.some((c) => neg.expectedErrorCodes.includes(c));
        out.push({
          name: neg.name,
          object: neg.object,
          outcome: expected ? 'REJECTED_AS_EXPECTED' : 'REJECTED_OTHER_REASON',
          errorCodes: codes,
          message: errText(err),
        });
        this.log(
          `  negative ${neg.name}: rejected (${codes.join(', ') || 'no code'})${expected ? '' : ' — not the expected reason'}`,
        );
      }
    }
    return out;
  }

  /**
   * API oracle: try to create a variant of a plan step (some fields set / removed) and report whether Salesforce
   * saved it. Rejection is the expected outcome of a negative check; a saved record is adopted and cleaned up.
   */
  async attempt(
    stepId: string,
    set: Record<string, unknown> = {},
    remove: string[] = [],
  ): Promise<{ saved: boolean; errorCodes: string[]; message?: string }> {
    const step = this.o.plan.steps.find((s) => s.stepId === stepId);
    if (!step) throw new QAError('DATA', `unknown data step ${stepId}`);
    const fields: DataPlanStep['fields'] = Object.fromEntries(
      Object.entries({ ...step.fields, ...set }).filter(([k]) => !remove.includes(k)),
    ) as DataPlanStep['fields'];
    const body = this.body({ fields, ...(step.parent ? { parent: step.parent } : {}) });
    const w = this.o.ledger.plan({
      runId: this.o.plan.runId,
      object: step.object,
      step: `${stepId}:attempt-${this.attempts}`,
      fields,
      order: 900 + 50 + this.attempts++,
      ...(step.parent ? { parentRef: step.parent.stepId } : {}),
    });
    this.o.ledger.transition(w.idempotencyKey, 'SENT');
    try {
      const id = await this.o.sf.create(step.object, body, { emailDomains: emailDomains(body) });
      this.o.ledger.transition(w.idempotencyKey, 'CONFIRMED', id);
      return { saved: true, errorCodes: [] };
    } catch (err) {
      if (err instanceof HardStopError) throw err;
      const codes = sfErrorCodes(err);
      this.o.ledger.transition(w.idempotencyKey, 'FAILED', undefined, codes.join(',') || errText(err));
      return { saved: false, errorCodes: codes, message: errText(err) };
    }
  }

  /** Guarded update of a run-owned record (e.g. to produce field history). */
  async update(stepId: string, fields: Record<string, unknown>): Promise<void> {
    const step = this.o.plan.steps.find((s) => s.stepId === stepId);
    if (!step) throw new QAError('DATA', `unknown data step ${stepId}`);
    await this.o.sf.update(step.object, this.recordId(stepId), fields, { emailDomains: emailDomains(fields) });
  }

  /**
   * Adopt a record a test created through the UI: find it by a run-unique value, tag it with the run, and add it to
   * the ledger so cleanup removes it. The value must contain the run id (never matches foreign data).
   */
  async adopt(as: string, object: string, field: string, value: string): Promise<string> {
    if (!value.includes(this.o.plan.runId)) {
      throw new QAError('DATA', `adopt ${object}: the value must contain the run id ${this.o.plan.runId}`);
    }
    const rows = await this.o.sf.query<{ Id: string }>(
      `SELECT Id FROM ${object} WHERE ${field} = ${soqlString(value)}`,
    );
    if (rows.length !== 1 || !rows[0]) {
      throw new QAError(
        'DATA',
        `adopt ${object}: expected 1 record with ${field} = the run-unique value, found ${rows.length}`,
      );
    }
    const id = rows[0].Id;
    const tag = this.o.plan.runTag.field;
    if (tag) await this.o.sf.update(object, id, { [tag]: this.o.plan.runTag.value });
    const w = this.o.ledger.plan({
      runId: this.o.plan.runId,
      object,
      step: as,
      fields: { [field]: value },
      order: 500 + this.adopted++,
    });
    if (w.state === 'PLANNED') {
      this.o.ledger.transition(w.idempotencyKey, 'SENT');
      this.o.ledger.transition(w.idempotencyKey, 'CONFIRMED', id);
    }
    this.ids.set(as, id);
    return id;
  }

  /**
   * Reverse-order cleanup of run-owned records only. Before each delete the record is re-read: it must still carry
   * this run's tag (else HARD_STOP, CLAUDE.md rule 4). Then an independent re-query proves nothing is left.
   */
  async cleanup(opts: { keep?: boolean } = {}): Promise<CleanupReport> {
    const startedAt = this.now().toISOString();
    const reconciled: CleanupReport['reconciled'] = [];
    for (const w of this.o.ledger.all().filter((x) => x.state === 'UNCERTAIN')) {
      const step = this.o.plan.steps.find((s) => s.stepId === w.step);
      if (!step) continue;
      const r = await this.o.ledger.reconcile(w.idempotencyKey, () => this.lookup(step));
      reconciled.push({
        idempotencyKey: w.idempotencyKey,
        outcome: r.state === 'CONFIRMED' ? 'ADOPTED' : 'NOT_CREATED',
        ...(r.recordId ? { recordId: r.recordId } : {}),
      });
    }
    const tag = this.o.plan.runTag.field;
    const owned = this.o.ledger
      .all()
      .filter((w) => w.state === 'CONFIRMED' && w.recordId)
      .sort((a, b) => (b.order ?? 0) - (a.order ?? 0));
    const entries: CleanupEntry[] = [];
    for (const w of owned) {
      const recordId = w.recordId ?? '';
      const base = {
        idempotencyKey: w.idempotencyKey,
        object: w.object,
        recordId,
        ...(w.step ? { stepId: w.step } : {}),
      };
      if (opts.keep) {
        entries.push({ ...base, action: 'KEPT', reason: 'kept on request (--keep / keepDataOnFailure)' });
        continue;
      }
      const rows = await this.o.sf.query(
        `SELECT Id${tag ? `, ${tag}` : ''} FROM ${w.object} WHERE Id = ${soqlString(recordId)}`,
      );
      const row = rows[0];
      if (!row) {
        this.o.ledger.transition(w.idempotencyKey, 'CLEANED');
        entries.push({ ...base, action: 'ALREADY_GONE' });
        continue;
      }
      if (tag && row[tag] !== this.o.plan.runTag.value) {
        throw new HardStopError(
          'UNTAGGED_CLEANUP',
          `${w.object} ${recordId} does not carry ${tag} = ${this.o.plan.runTag.value}; cleanup refused`,
        );
      }
      try {
        await this.o.sf.destroy(w.object, recordId, { cleanup: true, untaggedCount: 0 });
        this.o.ledger.transition(w.idempotencyKey, 'CLEANED');
        entries.push({ ...base, action: 'DELETED' });
        this.log(`  deleted ${w.object} (${w.step ?? '?'})`);
      } catch (err) {
        if (err instanceof HardStopError) throw err;
        entries.push({ ...base, action: 'FAILED', reason: sfErrorCodes(err).join(', ') || errText(err) });
      }
    }

    // Independent re-query: nothing tagged with this run, and none of the ledger ids, may remain.
    const queries: string[] = [];
    const remaining = new Map<string, { object: string; recordId: string }>();
    const objects = [...new Set([...this.o.plan.steps.map((s) => s.object), ...owned.map((w) => w.object)])];
    for (const object of objects) {
      const ids = owned.filter((w) => w.object === object).map((w) => w.recordId ?? '');
      const where = [
        ...(tag ? [`${tag} = ${soqlString(this.o.plan.runTag.value)}`] : []),
        ...(ids.length ? [`Id IN (${ids.map(soqlString).join(', ')})`] : []),
      ];
      for (const cond of where) {
        const q = `SELECT Id FROM ${object} WHERE ${cond}`;
        queries.push(q);
        for (const r of await this.o.sf.query<{ Id: string }>(q)) remaining.set(r.Id, { object, recordId: r.Id });
      }
    }
    const failed = entries.some((e) => e.action === 'FAILED' || e.action === 'REFUSED');
    return CleanupReport.parse({
      runId: this.o.plan.runId,
      orgId: this.o.plan.orgId,
      environment: this.o.plan.environment,
      startedAt,
      finishedAt: this.now().toISOString(),
      reconciled,
      entries,
      verify: { queries, remaining: [...remaining.values()] },
      status: opts.keep ? 'KEPT' : !failed && remaining.size === 0 ? 'CLEAN' : 'INCOMPLETE',
    });
  }
}
