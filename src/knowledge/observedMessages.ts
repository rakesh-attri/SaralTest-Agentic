// UI-observed message texts (Phase 5, operator decision 2026-11-26): what the org actually showed when the Explorer
// provoked a required-field error, a format error or a duplicate warning. Evidence level OBSERVED: it grounds a message
// text, it is never a requirement, and a human reviews it before an assertion relies on it (PLAN.md §7f).
// Stored in `.qa-memory/knowledge.db` (table observed_messages); every observation is kept (history), the latest per
// (org, page, field, kind, persona) is what reviewers read.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ObservedMessage } from '../core/schemas/execution.js';

export class ObservedMessageStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`CREATE TABLE IF NOT EXISTS observed_messages (
      id TEXT PRIMARY KEY,
      org TEXT NOT NULL,
      page TEXT NOT NULL,
      field TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      persona TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      row TEXT NOT NULL
    )`);
  }

  add(m: ObservedMessage): void {
    const v = ObservedMessage.parse(m);
    this.db
      .prepare(
        'INSERT OR REPLACE INTO observed_messages (id, org, page, field, kind, persona, observed_at, row) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(v.id, v.org, v.page, v.field ?? '', v.kind, v.persona, v.observedAt, JSON.stringify(v));
  }

  /** Latest observation per (page, field, kind, placement, persona) of an org. */
  latest(org: string): ObservedMessage[] {
    const rows = this.db
      .prepare('SELECT row FROM observed_messages WHERE org = ? ORDER BY observed_at DESC')
      .all(org) as { row: string }[];
    const seen = new Set<string>();
    const out: ObservedMessage[] = [];
    for (const r of rows) {
      const m = ObservedMessage.parse(JSON.parse(r.row));
      const k = `${m.page}|${m.field ?? ''}|${m.kind}|${m.placement}|${m.persona}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(m);
    }
    return out;
  }

  close(): void {
    this.db.close();
  }
}
