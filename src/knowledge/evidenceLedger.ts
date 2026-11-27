// Evidence ledger (PLAN.md §7): every claim an agent makes, with its sources and confidence. Phase 7 makes it durable:
// SQLite `.qa-memory/evidence.db`, one row per claim, plus a per-run export `runs/<id>/evidence/evidence.json` that
// reports and the independent validator read. Sources are typed and, where possible, content-hashed, so a reviewer can
// tell whether the file a claim cites is still the one the agent saw.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { Environment, IsoDate } from '../core/schemas/common.js';
import type { EvidenceEntry } from '../core/schemas/result.js';

export const SourceType = z.enum([
  'file', // run artifact (error-context, results.json, report)
  'screenshot',
  'trace',
  'aria', // ARIA snapshot
  'soql', // query text; result hash in sha256
  'api', // REST call (method + path); response hash in sha256
  'audit', // audit.jsonl row
  'config', // config / metadata fact
  'requirement', // requirement / decision / evidence id from design
  'result', // a TestResult (runId/testId)
  'model', // a model answer (name), never a source of truth on its own
  'evidence', // another ledger row (a verdict citing its experiments)
]);
export type SourceType = z.infer<typeof SourceType>;

export const SourceRef = z.object({
  type: SourceType,
  /** Repo-relative path (forward slashes), query text, `GET /sobjects/...`, requirement id … */
  ref: z.string(),
  sha256: z.string().optional(),
});
export type SourceRef = z.infer<typeof SourceRef>;

export const LedgerKind = z.enum([
  'observation',
  'experiment',
  'reproduction',
  'verdict',
  'judge',
  'heal',
  'exploration',
  'defect',
]);
export type LedgerKind = z.infer<typeof LedgerKind>;

export const LedgerEntry = z.object({
  id: z.string(),
  runId: z.string(),
  kind: LedgerKind,
  claim: z.string(),
  sources: z.array(SourceRef).min(1),
  agent: z.string(),
  confidence: z.number().min(0).max(1),
  environment: Environment,
  createdAt: IsoDate,
  /** Optional link to the subject (failureId, repair id, finding id …). */
  subject: z.string().optional(),
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

const hash = (b: string | Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** Forward-slash path relative to root (absolute paths outside root stay absolute). */
export function relPath(root: string, file: string): string {
  const r = isAbsolute(file) ? relative(root, file) : file;
  return r.split(sep).join('/');
}

/** A file source with its sha256 (missing files are cited without a hash). */
export function fileSource(root: string, file: string, type: SourceType = 'file'): SourceRef {
  const abs = isAbsolute(file) ? file : join(root, file);
  return {
    type,
    ref: relPath(root, file),
    ...(existsSync(abs) ? { sha256: hash(readFileSync(abs)) } : {}),
  };
}

/** A query / API source: the request text plus the hash of the (redacted) result it returned. */
export function querySource(type: 'soql' | 'api', request: string, result: unknown): SourceRef {
  return { type, ref: request, sha256: hash(JSON.stringify(result ?? null)) };
}

export class EvidenceLedger {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      subject TEXT,
      created_at TEXT NOT NULL,
      row TEXT NOT NULL
    )`);
    this.db.exec('CREATE INDEX IF NOT EXISTS evidence_run ON evidence(run_id)');
  }

  /** Insert or replace (re-running an investigation with the same ids replaces its evidence). */
  add(entry: LedgerEntry): LedgerEntry {
    const v = LedgerEntry.parse(entry);
    this.db
      .prepare('INSERT OR REPLACE INTO evidence (id, run_id, kind, subject, created_at, row) VALUES (?, ?, ?, ?, ?, ?)')
      .run(v.id, v.runId, v.kind, v.subject ?? null, v.createdAt, JSON.stringify(v));
    return v;
  }

  get(id: string): LedgerEntry | undefined {
    const r = this.db.prepare('SELECT row FROM evidence WHERE id = ?').get(id) as { row: string } | undefined;
    return r ? LedgerEntry.parse(JSON.parse(r.row)) : undefined;
  }

  forRun(runId: string): LedgerEntry[] {
    const rows = this.db.prepare('SELECT row FROM evidence WHERE run_id = ? ORDER BY created_at, id').all(runId) as {
      row: string;
    }[];
    return rows.map((r) => LedgerEntry.parse(JSON.parse(r.row)));
  }

  forSubject(subject: string): LedgerEntry[] {
    const rows = this.db.prepare('SELECT row FROM evidence WHERE subject = ? ORDER BY created_at, id').all(subject) as {
      row: string;
    }[];
    return rows.map((r) => LedgerEntry.parse(JSON.parse(r.row)));
  }

  /** Ids that do not resolve to a ledger row. */
  missing(ids: readonly string[]): string[] {
    return [...new Set(ids)].filter((id) => !this.get(id));
  }

  /** Remove a run's rows of the given kinds (a re-investigation replaces its own evidence only). */
  removeRun(runId: string, kinds?: readonly LedgerKind[]): number {
    const before = this.forRun(runId).filter((e) => !kinds || kinds.includes(e.kind));
    for (const e of before) this.db.prepare('DELETE FROM evidence WHERE id = ?').run(e.id);
    return before.length;
  }

  /** Write `runs/<id>/evidence/evidence.json` (sorted, stable) and return the entries. */
  exportRun(runId: string, file: string): LedgerEntry[] {
    const rows = this.forRun(runId);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(rows, null, 2) + '\n', 'utf8');
    return rows;
  }

  close(): void {
    this.db.close();
  }
}

/** Graph-state view of a ledger row (QARunState.evidence keeps plain string sources). */
export function toStateEvidence(e: LedgerEntry): EvidenceEntry {
  return {
    id: e.id,
    claim: e.claim,
    sources: e.sources.map((s) => `${s.type}:${s.ref}${s.sha256 ? `@${s.sha256.slice(0, 12)}` : ''}`),
    agent: e.agent,
    confidence: e.confidence,
    environment: e.environment,
    createdAt: e.createdAt,
  };
}

/** Read a per-run export (validator / reports). */
export function readEvidenceExport(file: string): LedgerEntry[] {
  if (!existsSync(file)) return [];
  return z.array(LedgerEntry).parse(JSON.parse(readFileSync(file, 'utf8')));
}

/** Helper for writers outside the class: write an export from entries already in memory. */
export function writeEvidenceExport(file: string, entries: readonly LedgerEntry[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify(
      [...entries].sort((a, b) => a.id.localeCompare(b.id)),
      null,
      2,
    ) + '\n',
    'utf8',
  );
}
