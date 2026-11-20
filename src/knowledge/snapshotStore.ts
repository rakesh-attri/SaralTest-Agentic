import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ComponentVersion,
  LineageEntry,
  ReverifyMark,
  SnapshotInfo,
  type DiffEntry,
} from '../core/schemas/knowledge.js';
import type { Dependency, DiscoveryResult } from '../sf/discovery/types.js';
import { contentHash } from './hash.js';

export interface StoredSnapshot {
  info: SnapshotInfo;
  components: ComponentVersion[];
  dependencies: Dependency[];
}

export function newSnapshotId(orgId: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `snap-${orgId.slice(0, 15)}-${stamp}-${randomBytes(2).toString('hex')}`;
}

const json = (v: unknown): string => JSON.stringify(v ?? null);
const parse = (s: unknown): unknown => (typeof s === 'string' ? (JSON.parse(s) as unknown) : null);
const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Immutable org-knowledge snapshots in `.qa-memory/knowledge.db` (PLAN.md §7c), plus lineage and RE_VERIFY marks.
 * A snapshot is written once in one transaction and never updated; a second write with the same id is refused.
 */
export class SnapshotStore {
  private readonly db: DatabaseSync;

  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL, org_alias TEXT NOT NULL, captured_at TEXT NOT NULL,
        source_type TEXT NOT NULL, release TEXT NOT NULL, persona TEXT, environment TEXT NOT NULL,
        api_version TEXT NOT NULL, objects TEXT NOT NULL, component_count INTEGER NOT NULL,
        unknown_count INTEGER NOT NULL, run_id TEXT, areas TEXT);
      CREATE INDEX IF NOT EXISTS snapshots_org ON snapshots(org_id, captured_at);
      CREATE TABLE IF NOT EXISTS component_versions (
        snapshot_id TEXT NOT NULL, type TEXT NOT NULL, api_name TEXT NOT NULL, label TEXT, parent TEXT,
        version TEXT, hash TEXT NOT NULL, data_scope TEXT NOT NULL, evidence_status TEXT NOT NULL,
        review_status TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (snapshot_id, type, api_name));
      CREATE TABLE IF NOT EXISTS dependencies (
        snapshot_id TEXT NOT NULL, from_type TEXT NOT NULL, from_name TEXT NOT NULL, to_type TEXT NOT NULL,
        to_name TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS deps_snapshot ON dependencies(snapshot_id);
      CREATE TABLE IF NOT EXISTS lineage (
        asset_type TEXT NOT NULL, asset_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, spec_hash TEXT,
        observation_ids TEXT NOT NULL, recorded_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reverify (
        asset_type TEXT NOT NULL, asset_id TEXT NOT NULL, component_type TEXT NOT NULL,
        component_name TEXT NOT NULL, change TEXT NOT NULL, path TEXT NOT NULL, snapshot_id TEXT NOT NULL,
        created_at TEXT NOT NULL, status TEXT NOT NULL,
        PRIMARY KEY (asset_type, asset_id, component_type, component_name, snapshot_id));
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Store a discovery result as a new immutable snapshot. Returns the stored header + versions. */
  save(o: {
    discovery: DiscoveryResult;
    orgAlias: string;
    release: string;
    persona?: string;
    runId?: string;
    id?: string;
  }): StoredSnapshot {
    const d = o.discovery;
    const id = o.id ?? newSnapshotId(d.orgId, new Date(d.finishedAt));
    if (this.db.prepare('SELECT 1 FROM snapshots WHERE id = ?').get(id)) {
      throw new Error(`snapshot ${id} already exists (snapshots are immutable)`);
    }
    const components: ComponentVersion[] = d.components.map((c) =>
      ComponentVersion.parse({
        snapshotId: id,
        type: c.type,
        apiName: c.apiName,
        ...(c.version ? { version: c.version } : {}),
        hash: contentHash(c.type, c.body),
        dataScope: 'metadata',
        evidenceStatus: c.evidenceStatus,
        reviewStatus: c.evidenceStatus === 'UNKNOWN' ? 'REVIEW_REQUIRED' : 'APPROVED',
        ...(c.label ? { label: c.label } : {}),
        ...(c.parent ? { parent: c.parent } : {}),
        body: c.body,
      }),
    );
    const info = SnapshotInfo.parse({
      id,
      orgId: d.orgId,
      orgAlias: o.orgAlias,
      capturedAt: d.finishedAt,
      sourceType: 'METADATA',
      release: o.release,
      ...(o.persona ? { persona: o.persona } : {}),
      environment: d.environment,
      apiVersion: d.apiVersion,
      objects: d.objects,
      componentCount: components.length,
      unknownCount: components.filter((c) => c.evidenceStatus === 'UNKNOWN').length,
      ...(o.runId ? { runId: o.runId } : {}),
    });
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'INSERT INTO snapshots (id, org_id, org_alias, captured_at, source_type, release, persona, environment, api_version, objects, component_count, unknown_count, run_id, areas) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          info.orgId,
          info.orgAlias,
          info.capturedAt,
          info.sourceType,
          info.release,
          info.persona ?? null,
          info.environment,
          info.apiVersion,
          json(info.objects),
          info.componentCount,
          info.unknownCount,
          info.runId ?? null,
          json(d.areas),
        );
      const ins = this.db.prepare(
        'INSERT INTO component_versions (snapshot_id, type, api_name, label, parent, version, hash, data_scope, evidence_status, review_status, body) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      );
      for (const c of components) {
        ins.run(
          id,
          c.type,
          c.apiName,
          c.label ?? null,
          c.parent ?? null,
          c.version ?? null,
          c.hash,
          c.dataScope,
          c.evidenceStatus,
          c.reviewStatus,
          json(c.body),
        );
      }
      const dep = this.db.prepare(
        'INSERT INTO dependencies (snapshot_id, from_type, from_name, to_type, to_name, kind, source) VALUES (?,?,?,?,?,?,?)',
      );
      for (const x of d.dependencies) dep.run(id, x.fromType, x.fromName, x.toType, x.toName, x.kind, x.source);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { info, components, dependencies: d.dependencies };
  }

  private infoFrom(row: Record<string, unknown>): SnapshotInfo {
    return SnapshotInfo.parse({
      id: row['id'],
      orgId: row['org_id'],
      orgAlias: row['org_alias'],
      capturedAt: row['captured_at'],
      sourceType: row['source_type'],
      release: row['release'],
      ...(text(row['persona']) ? { persona: row['persona'] } : {}),
      environment: row['environment'],
      apiVersion: row['api_version'],
      objects: parse(row['objects']),
      componentCount: row['component_count'],
      unknownCount: row['unknown_count'],
      ...(text(row['run_id']) ? { runId: row['run_id'] } : {}),
    });
  }

  list(orgId?: string): SnapshotInfo[] {
    const rows = orgId
      ? this.db.prepare('SELECT * FROM snapshots WHERE org_id = ? ORDER BY captured_at, id').all(orgId)
      : this.db.prepare('SELECT * FROM snapshots ORDER BY captured_at, id').all();
    return rows.map((r) => this.infoFrom(r as Record<string, unknown>));
  }

  /** Latest snapshot of an org (optionally the one before `beforeId`). */
  latest(orgId: string, beforeId?: string): SnapshotInfo | undefined {
    const all = this.list(orgId);
    if (!beforeId) return all.at(-1);
    const i = all.findIndex((s) => s.id === beforeId);
    return i > 0 ? all[i - 1] : undefined;
  }

  get(id: string): StoredSnapshot | undefined {
    const row = this.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const components = (
      this.db
        .prepare('SELECT * FROM component_versions WHERE snapshot_id = ? ORDER BY type, api_name')
        .all(id) as Record<string, unknown>[]
    ).map((r) =>
      ComponentVersion.parse({
        snapshotId: id,
        type: r['type'],
        apiName: r['api_name'],
        ...(text(r['version']) ? { version: r['version'] } : {}),
        hash: r['hash'],
        dataScope: r['data_scope'],
        evidenceStatus: r['evidence_status'],
        reviewStatus: r['review_status'],
        ...(text(r['label']) ? { label: r['label'] } : {}),
        ...(text(r['parent']) ? { parent: r['parent'] } : {}),
        body: parse(r['body']),
      }),
    );
    const dependencies = (
      this.db.prepare('SELECT * FROM dependencies WHERE snapshot_id = ?').all(id) as Record<string, unknown>[]
    ).map((r) => ({
      fromType: String(r['from_type']),
      fromName: String(r['from_name']),
      toType: String(r['to_type']),
      toName: String(r['to_name']),
      kind: String(r['kind']),
      source: String(r['source']) as Dependency['source'],
    }));
    return { info: this.infoFrom(row), components, dependencies };
  }

  // ---------------------------------------------------------------- lineage
  recordLineage(e: Omit<LineageEntry, 'recordedAt'> & { recordedAt?: string }): LineageEntry {
    const entry = LineageEntry.parse({ ...e, recordedAt: e.recordedAt ?? new Date().toISOString() });
    this.db
      .prepare(
        'INSERT INTO lineage (asset_type, asset_id, snapshot_id, spec_hash, observation_ids, recorded_at) VALUES (?,?,?,?,?,?)',
      )
      .run(
        entry.assetType,
        entry.assetId,
        entry.snapshotId,
        entry.specHash ?? null,
        json(entry.observationIds),
        entry.recordedAt,
      );
    return entry;
  }

  lineageOf(assetType: string, assetId: string): LineageEntry[] {
    return (
      this.db
        .prepare('SELECT * FROM lineage WHERE asset_type = ? AND asset_id = ? ORDER BY recorded_at')
        .all(assetType, assetId) as Record<string, unknown>[]
    ).map((r) =>
      LineageEntry.parse({
        assetType: r['asset_type'],
        assetId: r['asset_id'],
        snapshotId: r['snapshot_id'],
        ...(text(r['spec_hash']) ? { specHash: r['spec_hash'] } : {}),
        observationIds: parse(r['observation_ids']),
        recordedAt: r['recorded_at'],
      }),
    );
  }

  // ---------------------------------------------------------------- RE_VERIFY marks
  markReverify(marks: readonly Omit<ReverifyMark, 'createdAt' | 'status'>[], now: Date = new Date()): ReverifyMark[] {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO reverify (asset_type, asset_id, component_type, component_name, change, path, snapshot_id, created_at, status) VALUES (?,?,?,?,?,?,?,?,?)',
    );
    const out: ReverifyMark[] = [];
    for (const m of marks) {
      const mark = ReverifyMark.parse({ ...m, createdAt: now.toISOString(), status: 'OPEN' });
      stmt.run(
        mark.assetType,
        mark.assetId,
        mark.componentType,
        mark.componentName,
        mark.change,
        json(mark.path),
        mark.snapshotId,
        mark.createdAt,
        mark.status,
      );
      out.push(mark);
    }
    return out;
  }

  openReverify(assetType?: ReverifyMark['assetType']): ReverifyMark[] {
    const rows = (
      assetType
        ? this.db
            .prepare("SELECT * FROM reverify WHERE status = 'OPEN' AND asset_type = ? ORDER BY asset_id")
            .all(assetType)
        : this.db.prepare("SELECT * FROM reverify WHERE status = 'OPEN' ORDER BY asset_type, asset_id").all()
    ) as Record<string, unknown>[];
    return rows.map((r) =>
      ReverifyMark.parse({
        assetType: r['asset_type'],
        assetId: r['asset_id'],
        componentType: r['component_type'],
        componentName: r['component_name'],
        change: r['change'],
        path: parse(r['path']),
        snapshotId: r['snapshot_id'],
        createdAt: r['created_at'],
        status: r['status'],
      }),
    );
  }

  /** A human or a passing re-verification clears the mark (it stays in history). */
  clearReverify(assetType: string, assetId: string): number {
    const r = this.db
      .prepare("UPDATE reverify SET status = 'CLEARED' WHERE asset_type = ? AND asset_id = ? AND status = 'OPEN'")
      .run(assetType, assetId);
    return Number(r.changes);
  }
}

export type { DiffEntry };
