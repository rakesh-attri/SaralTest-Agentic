import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface GraphNode {
  /** `<type>:<apiName>` (unique per org). */
  id: string;
  type: string;
  apiName: string;
  label?: string;
  meta?: Record<string, unknown>;
}
export interface GraphEdge {
  from: string;
  to: string;
  kind: string;
  /** Where the edge came from (describe, formula, flow, MetadataComponentDependency, text-match, explorer, …). */
  source: string;
  /** Short human evidence (e.g. the matched term) — never record data. */
  evidence?: string;
}

export interface ImpactItem {
  node: GraphNode;
  depth: number;
  /** Edge chain from the dependent node to the changed component, e.g. `ManualTest:MTC-005 -covers-> Field:Contact.Phone`. */
  path: string[];
}

export const nodeId = (type: string, apiName: string): string => `${type}:${apiName}`;

/**
 * Edge kinds through which a changed component "governs" other components: a validation rule governs the fields its
 * formula references, a flow the fields it writes, a trigger its object… Impact first follows these from the changed
 * component, then walks *dependents* (incoming edges) up to the depth limit.
 */
export const GOVERNS = [
  'references',
  'error-on',
  'flow-writes-field',
  'flow-writes',
  'trigger-on',
  'controlled-by',
  'depends-on',
] as const;

/** SQLite knowledge graph (`.qa-memory/graph.db`, PLAN.md §7): nodes + edges per org, rebuilt from the latest snapshot. */
export class GraphStore {
  private readonly db: DatabaseSync;

  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS nodes (org TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL, api_name TEXT NOT NULL,
        label TEXT, meta TEXT, PRIMARY KEY (org, id));
      CREATE TABLE IF NOT EXISTS edges (org TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL,
        source TEXT NOT NULL, evidence TEXT, PRIMARY KEY (org, from_id, to_id, kind));
      CREATE INDEX IF NOT EXISTS edges_to ON edges(org, to_id);
      CREATE INDEX IF NOT EXISTS edges_from ON edges(org, from_id);
      CREATE TABLE IF NOT EXISTS graph_meta (org TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, built_at TEXT NOT NULL);
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Replace the org's graph atomically (snapshots keep history; the graph reflects the latest knowledge). */
  replaceOrg(org: string, snapshotId: string, nodes: readonly GraphNode[], edges: readonly GraphEdge[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM nodes WHERE org = ?').run(org);
      this.db.prepare('DELETE FROM edges WHERE org = ?').run(org);
      const n = this.db.prepare(
        'INSERT OR REPLACE INTO nodes (org, id, type, api_name, label, meta) VALUES (?,?,?,?,?,?)',
      );
      for (const x of nodes)
        n.run(org, x.id, x.type, x.apiName, x.label ?? null, x.meta ? JSON.stringify(x.meta) : null);
      const e = this.db.prepare(
        'INSERT OR IGNORE INTO edges (org, from_id, to_id, kind, source, evidence) VALUES (?,?,?,?,?,?)',
      );
      for (const x of edges) e.run(org, x.from, x.to, x.kind, x.source, x.evidence ?? null);
      this.db
        .prepare('INSERT OR REPLACE INTO graph_meta (org, snapshot_id, built_at) VALUES (?,?,?)')
        .run(org, snapshotId, new Date().toISOString());
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Add edges (e.g. new locators from the Explorer) without rebuilding. */
  addEdges(org: string, nodes: readonly GraphNode[], edges: readonly GraphEdge[]): void {
    const n = this.db.prepare(
      'INSERT OR REPLACE INTO nodes (org, id, type, api_name, label, meta) VALUES (?,?,?,?,?,?)',
    );
    for (const x of nodes) n.run(org, x.id, x.type, x.apiName, x.label ?? null, x.meta ? JSON.stringify(x.meta) : null);
    const e = this.db.prepare(
      'INSERT OR IGNORE INTO edges (org, from_id, to_id, kind, source, evidence) VALUES (?,?,?,?,?,?)',
    );
    for (const x of edges) e.run(org, x.from, x.to, x.kind, x.source, x.evidence ?? null);
  }

  builtFrom(org: string): string | undefined {
    const r = this.db.prepare('SELECT snapshot_id FROM graph_meta WHERE org = ?').get(org) as
      { snapshot_id?: string } | undefined;
    return r?.snapshot_id;
  }

  counts(org: string): { nodes: number; edges: number } {
    const n = this.db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE org = ?').get(org) as { c: number };
    const e = this.db.prepare('SELECT COUNT(*) AS c FROM edges WHERE org = ?').get(org) as { c: number };
    return { nodes: n.c, edges: e.c };
  }

  node(org: string, id: string): GraphNode | undefined {
    const r = this.db.prepare('SELECT * FROM nodes WHERE org = ? AND id = ?').get(org, id) as
      Record<string, unknown> | undefined;
    return r ? this.toNode(r) : undefined;
  }

  edgesFrom(org: string, id: string): GraphEdge[] {
    return (
      this.db.prepare('SELECT * FROM edges WHERE org = ? AND from_id = ?').all(org, id) as Record<string, unknown>[]
    ).map((r) => this.toEdge(r));
  }

  edgesTo(org: string, id: string): GraphEdge[] {
    return (
      this.db.prepare('SELECT * FROM edges WHERE org = ? AND to_id = ?').all(org, id) as Record<string, unknown>[]
    ).map((r) => this.toEdge(r));
  }

  private toNode(r: Record<string, unknown>): GraphNode {
    return {
      id: String(r['id']),
      type: String(r['type']),
      apiName: String(r['api_name']),
      ...(typeof r['label'] === 'string' ? { label: r['label'] } : {}),
      ...(typeof r['meta'] === 'string' ? { meta: JSON.parse(r['meta']) as Record<string, unknown> } : {}),
    };
  }
  private toEdge(r: Record<string, unknown>): GraphEdge {
    return {
      from: String(r['from_id']),
      to: String(r['to_id']),
      kind: String(r['kind']),
      source: String(r['source']),
      ...(typeof r['evidence'] === 'string' ? { evidence: r['evidence'] } : {}),
    };
  }

  /**
   * Impact of changed components (PLAN.md §7): seeds + what they govern (one hop over GOVERNS edges), then every
   * node that depends on those (incoming edges), recursively up to `maxDepth` (≤ 3). Recursive CTE; the edge path is
   * returned as citable evidence. Cycles are cut by checking the path.
   */
  impact(org: string, seedIds: readonly string[], maxDepth = 3): ImpactItem[] {
    if (!seedIds.length) return [];
    const depth = Math.min(Math.max(maxDepth, 1), 3);
    const seeds = seedIds.map(() => 'SELECT ? AS id').join(' UNION ALL ');
    const governs = GOVERNS.map(() => '?').join(',');
    const sql = `
      WITH RECURSIVE
        seeds(id) AS (${seeds}),
        touched(id, path) AS (
          SELECT id, '' FROM seeds
          UNION
          SELECT e.to_id, e.from_id || ' -' || e.kind || '-> ' || e.to_id
            FROM edges e JOIN seeds s ON e.from_id = s.id
           WHERE e.org = ? AND e.kind IN (${governs})
        ),
        walk(id, depth, path, visited) AS (
          SELECT id, 0, path, '|' || id || '|' FROM touched
          UNION ALL
          SELECT e.from_id, w.depth + 1,
                 e.from_id || ' -' || e.kind || '-> ' || e.to_id || CASE WHEN w.path = '' THEN '' ELSE ' ;; ' || w.path END,
                 w.visited || e.from_id || '|'
            FROM edges e JOIN walk w ON e.to_id = w.id
           WHERE e.org = ? AND w.depth < ? AND instr(w.visited, '|' || e.from_id || '|') = 0
        )
      SELECT w.id, MIN(w.depth) AS depth, w.path, n.type, n.api_name, n.label
        FROM walk w JOIN nodes n ON n.org = ? AND n.id = w.id
       GROUP BY w.id
       ORDER BY depth, w.id`;
    const rows = this.db.prepare(sql).all(...seedIds, org, ...GOVERNS, org, depth, org) as Record<string, unknown>[];
    return rows
      .filter((r) => !seedIds.includes(String(r['id'])))
      .map((r) => ({
        node: {
          id: String(r['id']),
          type: String(r['type']),
          apiName: String(r['api_name']),
          ...(typeof r['label'] === 'string' ? { label: r['label'] } : {}),
        },
        depth: Number(r['depth']),
        path: (typeof r['path'] === 'string' ? r['path'] : '').split(' ;; ').filter(Boolean),
      }));
  }
}
