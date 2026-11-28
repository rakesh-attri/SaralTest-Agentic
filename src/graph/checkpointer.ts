import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  MemorySaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
} from '@langchain/langgraph-checkpoint';

type Storage = MemorySaver['storage'];
type Writes = MemorySaver['writes'];

/** JSON with Uint8Array support (checkpoint payloads are serialized bytes). */
function encode(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v instanceof Uint8Array ? { __u8: Buffer.from(v).toString('base64') } : v,
  );
}
function decode(text: string): unknown {
  return JSON.parse(text, (_k, v: unknown) => {
    if (v && typeof v === 'object' && '__u8' in v && typeof v.__u8 === 'string') {
      return new Uint8Array(Buffer.from(v.__u8, 'base64'));
    }
    return v;
  });
}

const threadOfWriteKey = (key: string): string => {
  const parsed = JSON.parse(key) as unknown;
  return Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : '';
};

/**
 * Durable LangGraph checkpointer on Node's built-in `node:sqlite` (no native module to build on Windows).
 * It reuses MemorySaver's tested checkpoint logic and persists each thread (= run) as one row after every write,
 * so `qa resume --run <id>` survives a process exit. One row per run keeps it simple; runs are small.
 */
export class SqliteCheckpointSaver extends MemorySaver {
  private readonly db: DatabaseSync;
  private readonly loaded = new Set<string>();

  constructor(file: string) {
    super();
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file, { timeout: 10_000 }); // busy timeout: parallel workers (run-p7-fx-base-2 "database is locked")
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS lg_threads (thread_id TEXT PRIMARY KEY, storage TEXT NOT NULL, writes TEXT NOT NULL, updated_at TEXT NOT NULL)',
    );
  }

  private threadId(config: RunnableConfig): string | undefined {
    const t: unknown = config.configurable?.['thread_id'];
    return typeof t === 'string' ? t : undefined;
  }

  private load(threadId: string | undefined): void {
    if (threadId === undefined || this.loaded.has(threadId)) return;
    this.loaded.add(threadId);
    const row = this.db.prepare('SELECT storage, writes FROM lg_threads WHERE thread_id = ?').get(threadId) as
      { storage: string; writes: string } | undefined;
    if (!row) return;
    const storage = decode(row.storage) as Storage[string];
    const writes = decode(row.writes) as Writes;
    this.storage[threadId] = Object.assign(Object.create(null) as Storage[string], storage);
    for (const [k, v] of Object.entries(writes)) this.writes[k] = v;
  }

  private persist(threadId: string | undefined): void {
    if (threadId === undefined) return;
    const writes: Writes = {};
    for (const [k, v] of Object.entries(this.writes)) if (threadOfWriteKey(k) === threadId) writes[k] = v;
    this.db
      .prepare(
        'INSERT INTO lg_threads (thread_id, storage, writes, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET storage = excluded.storage, writes = excluded.writes, updated_at = excluded.updated_at',
      )
      .run(threadId, encode(this.storage[threadId] ?? {}), encode(writes), new Date().toISOString());
  }

  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    this.load(this.threadId(config));
    return super.getTuple(config);
  }

  override async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    this.load(this.threadId(config));
    yield* super.list(config, options);
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    const id = this.threadId(config);
    this.load(id);
    const out = await super.put(config, checkpoint, metadata);
    this.persist(id);
    return out;
  }

  override async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string, taskPath?: string) {
    const id = this.threadId(config);
    this.load(id);
    await super.putWrites(config, writes, taskId, taskPath);
    this.persist(id);
  }

  override async deleteThread(threadId: string): Promise<void> {
    await super.deleteThread(threadId);
    this.db.prepare('DELETE FROM lg_threads WHERE thread_id = ?').run(threadId);
  }

  /** Thread ids with a stored checkpoint (newest first). */
  threads(): string[] {
    return (
      this.db.prepare('SELECT thread_id FROM lg_threads ORDER BY updated_at DESC').all() as { thread_id: string }[]
    ).map((r) => r.thread_id);
  }

  close(): void {
    this.db.close();
  }
}
