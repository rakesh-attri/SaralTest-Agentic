import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { AuditEntry } from '../core/schemas/data.js';
import type { Redactor } from './redact.js';

/**
 * Append-only audit log `runs/<runId>/audit.jsonl` (PLAN.md §7d). One AuditEntry per mutation (and per refused
 * action). Entries are validated and redacted before they touch disk; writes are synchronous so a crash cannot lose
 * the record of a write that was already sent.
 */
export class AuditLog {
  constructor(
    readonly file: string,
    private readonly redactor: Redactor,
  ) {
    mkdirSync(dirname(file), { recursive: true });
  }

  append(entry: Omit<AuditEntry, 'at'> & { at?: string }): AuditEntry {
    const full = AuditEntry.parse({ ...entry, at: entry.at ?? new Date().toISOString() });
    const safe: AuditEntry = {
      ...full,
      ...(full.before !== undefined ? { before: this.redactor.redactValue(full.before) } : {}),
      ...(full.after !== undefined ? { after: this.redactor.redactValue(full.after) } : {}),
    };
    appendFileSync(this.file, `${JSON.stringify(safe)}\n`, 'utf8');
    return safe;
  }

  read(): AuditEntry[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => AuditEntry.parse(JSON.parse(line)));
  }
}
