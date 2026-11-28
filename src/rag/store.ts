import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as lancedb from '@lancedb/lancedb';
import type { Embeddings } from '@langchain/core/embeddings';
import { QAError } from '../core/errors.js';
import { withRetry, type RetryOptions } from '../core/retry.js';
import { checkVectors } from '../models/guarded.js';
import type { RateLimiter } from '../models/rateLimiter.js';
import { RAG_TABLES, type Chunk, type RagTable } from './chunkers.js';

export interface RagRow {
  id: string;
  text: string;
  vector: number[];
  embedModel: string;
  org: string;
  release: string;
  type: string;
  sourceRef: string;
  sourceKey: string;
  createdAt: string;
  confidence: number;
}

export interface IngestStats {
  added: number;
  skipped: number;
  removed: number;
  resumed: number;
  tables: Partial<Record<RagTable, number>>;
}

export interface RetrievedChunk {
  table: RagTable;
  id: string;
  text: string;
  sourceRef: string;
  /** Reciprocal-rank-fusion score (higher = better). */
  score: number;
  via: ('vector' | 'fts')[];
  org: string;
  release: string;
}

const sqlStr = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/**
 * Ingest manifest (`.qa-memory/rag/manifest.db`): sha256 dedupe, per-source replacement (incremental) and per-batch
 * status so an interrupted ingest resumes where it stopped (PENDING rows are re-embedded, EMBEDDED rows skipped).
 */
class Manifest {
  readonly db: DatabaseSync;
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file, { timeout: 10_000 }); // busy timeout: parallel workers (run-p7-fx-base-2 "database is locked")
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, tbl TEXT NOT NULL, source_key TEXT NOT NULL, source_ref TEXT NOT NULL,
        hash TEXT NOT NULL, embed_model TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chunks_source ON chunks(source_key);
    `);
  }
  get(id: string): { status: string; embed_model: string } | undefined {
    return this.db.prepare('SELECT status, embed_model FROM chunks WHERE id = ?').get(id) as
      { status: string; embed_model: string } | undefined;
  }
  idsForSource(key: string): { id: string; tbl: string }[] {
    return this.db.prepare('SELECT id, tbl FROM chunks WHERE source_key = ?').all(key) as { id: string; tbl: string }[];
  }
  put(c: Chunk, model: string, status: 'PENDING' | 'EMBEDDED'): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO chunks (id, tbl, source_key, source_ref, hash, embed_model, status, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(c.id, c.table, c.sourceKey, c.sourceRef, c.hash, model, status, new Date().toISOString());
  }
  remove(id: string): void {
    this.db.prepare('DELETE FROM chunks WHERE id = ?').run(id);
  }
  models(): string[] {
    return (
      this.db.prepare("SELECT DISTINCT embed_model FROM chunks WHERE status = 'EMBEDDED'").all() as {
        embed_model: string;
      }[]
    ).map((r) => r.embed_model);
  }
  counts(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT tbl, COUNT(*) AS n FROM chunks WHERE status = 'EMBEDDED' GROUP BY tbl")
      .all() as { tbl: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.tbl, r.n]));
  }
}

export interface RagStoreOptions {
  /** `.qa-memory/rag` */
  dir: string;
  embeddings: Embeddings;
  /** Stored with every row; vectors of different models never mix. */
  embedModel: string;
  limiter?: RateLimiter;
  batchSize?: number;
  /** Retry policy for TRANSIENT embedding failures (quota / rate limit). */
  retry?: RetryOptions;
}

/** LanceDB-backed RAG memory (PLAN.md §7): hybrid vector + full-text retrieval with reciprocal-rank fusion. */
export class RagStore {
  private dbp: Promise<lancedb.Connection> | undefined;
  private readonly manifest: Manifest;

  constructor(private readonly o: RagStoreOptions) {
    this.manifest = new Manifest(join(o.dir, 'manifest.db'));
  }

  close(): void {
    this.manifest.db.close();
  }

  private db(): Promise<lancedb.Connection> {
    this.dbp ??= lancedb.connect(join(this.o.dir, 'lancedb'));
    return this.dbp;
  }

  private async names(): Promise<string[]> {
    const out: string[] = [];
    for await (const n of (await this.db()).listTables()) out.push(n);
    return out;
  }

  private async table(name: RagTable): Promise<lancedb.Table | undefined> {
    const db = await this.db();
    return (await this.names()).includes(name) ? db.openTable(name) : undefined;
  }

  counts(): Record<string, number> {
    return this.manifest.counts();
  }

  /** Embed + store chunks. Unchanged chunks are skipped; a source's vanished chunks are removed. */
  async ingest(chunks: readonly Chunk[], onProgress?: (m: string) => void): Promise<IngestStats> {
    const other = this.manifest.models().filter((m) => m !== this.o.embedModel);
    if (other.length) {
      throw new QAError(
        'ENVIRONMENT',
        `RAG memory holds vectors from ${other.join(', ')}; current model is ${this.o.embedModel}`,
        {
          fix: 'Run `pnpm qa ingest --reindex` (vectors from different models never mix)',
        },
      );
    }
    const stats: IngestStats = { added: 0, skipped: 0, removed: 0, resumed: 0, tables: {} };
    const wanted = new Set(chunks.map((c) => c.id));
    // Incremental: drop chunks of the same sources that are no longer produced.
    const sources = [...new Set(chunks.map((c) => c.sourceKey))];
    const stale = new Map<RagTable, string[]>();
    for (const key of sources) {
      for (const row of this.manifest.idsForSource(key)) {
        if (wanted.has(row.id)) continue;
        const list = stale.get(row.tbl as RagTable) ?? [];
        list.push(row.id);
        stale.set(row.tbl as RagTable, list);
      }
    }
    for (const [tbl, ids] of stale) {
      const t = await this.table(tbl);
      if (t) await t.delete(`id IN (${ids.map(sqlStr).join(',')})`);
      for (const id of ids) this.manifest.remove(id);
      stats.removed += ids.length;
    }

    const todo: Chunk[] = [];
    for (const c of chunks) {
      const m = this.manifest.get(c.id);
      if (m?.status === 'EMBEDDED') {
        stats.skipped++;
        continue;
      }
      if (m?.status === 'PENDING') stats.resumed++;
      this.manifest.put(c, this.o.embedModel, 'PENDING');
      todo.push(c);
    }
    const batchSize = this.o.batchSize ?? 32;
    const touched = new Set<RagTable>();
    for (let i = 0; i < todo.length; i += batchSize) {
      const batch = todo.slice(i, i + batchSize);
      const vectors = await withRetry(
        async () => {
          await this.o.limiter?.acquire();
          return checkVectors(
            await this.o.embeddings.embedDocuments(batch.map((c) => c.text)),
            batch.length,
            this.o.embedModel,
          );
        },
        this.o.retry ?? {
          maxAttempts: 4,
          backoffSeconds: [15, 30, 60],
          onRetry: (r) => onProgress?.(`  embedding provider busy (${r.message}); retrying in ${r.delayMs / 1000}s`),
        },
      );
      const now = new Date().toISOString();
      const byTable = new Map<RagTable, RagRow[]>();
      batch.forEach((c, j) => {
        const rows = byTable.get(c.table) ?? [];
        rows.push({
          id: c.id,
          text: c.text,
          vector: vectors[j] ?? [],
          embedModel: this.o.embedModel,
          org: c.org,
          release: c.release,
          type: c.type,
          sourceRef: c.sourceRef,
          sourceKey: c.sourceKey,
          createdAt: now,
          confidence: c.confidence ?? 1,
        });
        byTable.set(c.table, rows);
      });
      for (const [tbl, rows] of byTable) {
        const db = await this.db();
        const t = await this.table(tbl);
        if (!t) {
          await db.createTable(tbl, rows as unknown as Record<string, unknown>[]);
        } else {
          // Idempotent upsert: a crashed batch may already be in LanceDB.
          await t.delete(`id IN (${rows.map((r) => sqlStr(r.id)).join(',')})`);
          await t.add(rows as unknown as Record<string, unknown>[]);
        }
        touched.add(tbl);
        stats.tables[tbl] = (stats.tables[tbl] ?? 0) + rows.length;
      }
      for (const c of batch) this.manifest.put(c, this.o.embedModel, 'EMBEDDED');
      stats.added += batch.length;
      onProgress?.(`  embedded ${Math.min(i + batchSize, todo.length)}/${todo.length}`);
    }
    for (const tbl of new Set([...touched, ...stale.keys()])) {
      const t = await this.table(tbl);
      if (t && (await t.countRows()) > 0) await t.createIndex('text', { config: lancedb.Index.fts(), replace: true });
    }
    return stats;
  }

  /**
   * Hybrid retrieval: vector + full-text per table, fused with reciprocal-rank fusion (k = 60). Mandatory `org`
   * filter, optional `release`. Returns chunks with their source reference for evidence citation.
   */
  async retrieve(q: {
    query: string;
    org: string;
    release?: string;
    tables?: RagTable[];
    k?: number;
  }): Promise<RetrievedChunk[]> {
    const k = q.k ?? 8;
    const where = [`org = ${sqlStr(q.org)}`, ...(q.release ? [`release = ${sqlStr(q.release)}`] : [])].join(' AND ');
    const vector = await this.o.embeddings.embedQuery(q.query);
    const fused = new Map<string, RetrievedChunk>();
    const add = (tbl: RagTable, rows: Record<string, unknown>[], via: 'vector' | 'fts'): void => {
      rows.forEach((r, rank) => {
        const id = String(r['id']);
        const prev = fused.get(id);
        const score = 1 / (60 + rank + 1);
        if (prev) {
          prev.score += score;
          if (!prev.via.includes(via)) prev.via.push(via);
        } else {
          fused.set(id, {
            table: tbl,
            id,
            text: String(r['text']),
            sourceRef: String(r['sourceRef']),
            score,
            via: [via],
            org: String(r['org']),
            release: String(r['release']),
          });
        }
      });
    };
    for (const tbl of q.tables ?? [...RAG_TABLES]) {
      const t = await this.table(tbl);
      if (!t) continue;
      add(
        tbl,
        (await t
          .vectorSearch(vector)
          .where(where)
          .limit(k * 2)
          .toArray()) as Record<string, unknown>[],
        'vector',
      );
      try {
        add(
          tbl,
          (await t
            .query()
            .fullTextSearch(q.query)
            .where(where)
            .limit(k * 2)
            .toArray()) as Record<string, unknown>[],
          'fts',
        );
      } catch {
        // no FTS index yet → vector only
      }
    }
    return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, k);
  }

  /** Drop everything (used by `--reindex`). */
  async reset(): Promise<void> {
    const db = await this.db();
    for (const name of await this.names()) await db.dropTable(name);
    this.manifest.db.exec('DELETE FROM chunks');
  }
}
