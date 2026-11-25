import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { IsoDate } from '../core/schemas/common.js';

/** salesforce-lightning-locators skill ranking: role > label > text > testid > css (css only with a reason). */
export const LocatorStrategy = z.enum(['role', 'label', 'text', 'testid', 'css']);
export const STRATEGY_RANK: Record<z.infer<typeof LocatorStrategy>, number> = {
  role: 1,
  label: 2,
  text: 3,
  testid: 4,
  css: 5,
};

export const LocatorEntry = z
  .object({
    org: z.string(),
    /** Page id (account-record, contact-record, contact-new …). */
    page: z.string(),
    /** Stable element key, e.g. `button:Edit`, `field:Contact.Phone`. */
    element: z.string(),
    persona: z.string(),
    recordType: z.string().optional(),
    /** Region the locator is scoped to (main, dialog "New Contact" …). */
    scope: z.string(),
    role: z.string().optional(),
    accessibleName: z.string().optional(),
    /** Playwright expression relative to the scope, e.g. `getByRole('button', { name: 'Edit', exact: true })`. */
    expression: z.string(),
    strategy: LocatorStrategy,
    strategyRank: z.number().int().min(1).max(5),
    /** Required for rank 5 (skill rule). */
    reason: z.string().optional(),
    /** Metadata field this element represents (label verified against the snapshot). */
    fieldApiName: z.string().optional(),
    /** How the accessible name was matched to the field (label = exact metadata label, the skill's preferred check). */
    fieldMatch: z.enum(['label', 'label-without-ID', 'api-name', 'relationship-name']).optional(),
    lastVerifiedAt: IsoDate,
    verifiedBy: z.enum(['explorer', 'healer', 'human']),
    snapshotId: z.string().optional(),
    observationId: z.string(),
    status: z.enum(['ACTIVE', 'RE_VERIFY', 'RETIRED']).default('ACTIVE'),
    environment: z.enum(['LIVE', 'FIXTURE']),
  })
  .superRefine((l, ctx) => {
    if (l.strategyRank !== STRATEGY_RANK[l.strategy])
      ctx.addIssue({ code: 'custom', message: `rank ${l.strategyRank} ≠ ${l.strategy}` });
    if (l.strategy === 'css' && !l.reason) ctx.addIssue({ code: 'custom', message: 'rank 5 (css) needs a reason' });
    if (/xpath|\/\/|nth-child|\.nth\(|\.first\(|\.last\(|waitForTimeout|data-aura|slds-/i.test(l.expression)) {
      ctx.addIssue({ code: 'custom', message: `fragile locator rejected: ${l.expression}` });
    }
  });
export type LocatorEntry = z.infer<typeof LocatorEntry>;

/**
 * Locator registry (PLAN.md §7, `.qa-memory/locators.db`): the single source page objects are generated from
 * (Phase 4). One row per (org, page, element, persona, recordType); re-verification updates `lastVerifiedAt`.
 */
export class LocatorRegistry {
  private readonly db: DatabaseSync;

  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS locators (org TEXT NOT NULL, page TEXT NOT NULL, element TEXT NOT NULL, persona TEXT NOT NULL,
        record_type TEXT NOT NULL DEFAULT '', data TEXT NOT NULL, status TEXT NOT NULL, last_verified_at TEXT NOT NULL,
        PRIMARY KEY (org, page, element, persona, record_type));
    `);
  }

  close(): void {
    this.db.close();
  }

  upsert(entries: readonly LocatorEntry[]): number {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO locators (org, page, element, persona, record_type, data, status, last_verified_at) VALUES (?,?,?,?,?,?,?,?)',
    );
    for (const raw of entries) {
      const e = LocatorEntry.parse(raw);
      stmt.run(e.org, e.page, e.element, e.persona, e.recordType ?? '', JSON.stringify(e), e.status, e.lastVerifiedAt);
    }
    return entries.length;
  }

  list(filter: { org?: string; page?: string; status?: LocatorEntry['status'] } = {}): LocatorEntry[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.org) {
      where.push('org = ?');
      args.push(filter.org);
    }
    if (filter.page) {
      where.push('page = ?');
      args.push(filter.page);
    }
    if (filter.status) {
      where.push('status = ?');
      args.push(filter.status);
    }
    const rows = this.db
      .prepare(
        `SELECT data, status FROM locators ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY page, element`,
      )
      .all(...args) as { data: string; status: string }[];
    return rows.map((r) => LocatorEntry.parse({ ...(JSON.parse(r.data) as object), status: r.status }));
  }

  pages(org: string): { page: string; count: number }[] {
    return (
      this.db
        .prepare(
          "SELECT page, COUNT(*) AS count FROM locators WHERE org = ? AND status != 'RETIRED' GROUP BY page ORDER BY page",
        )
        .all(org) as {
        page: string;
        count: number;
      }[]
    ).map((r) => ({ page: r.page, count: r.count }));
  }

  /**
   * After a page was explored successfully: registered elements of that page + persona that were NOT observed are
   * RETIRED (kept for history, never used for page objects). Seen 2026-11-25: QA Run Id was removed from the
   * layouts, but its locators stayed ACTIVE because exploration only upserted what it saw. Returns the retired
   * element keys.
   */
  retireMissing(org: string, page: string, persona: string, seen: readonly string[]): string[] {
    const keep = new Set(seen);
    const gone = this.list({ org, page })
      .filter((l) => l.persona === persona && l.status !== 'RETIRED' && !keep.has(l.element))
      .map((l) => l.element);
    const stmt = this.db.prepare(
      "UPDATE locators SET status = 'RETIRED' WHERE org = ? AND page = ? AND element = ? AND persona = ?",
    );
    for (const e of gone) stmt.run(org, page, e, persona);
    return gone;
  }

  /** Mark one locator RE_VERIFY by its graph asset id (`<page>/<element>`). Returns rows changed. */
  markAssetReverify(org: string, assetId: string): number {
    const slash = assetId.indexOf('/');
    if (slash < 0) return 0;
    const r = this.db
      .prepare(
        "UPDATE locators SET status = 'RE_VERIFY' WHERE org = ? AND page = ? AND element = ? AND status != 'RETIRED'",
      )
      .run(org, assetId.slice(0, slash), assetId.slice(slash + 1));
    return Number(r.changes);
  }

  /** Mark locators RE_VERIFY (e.g. their field changed in a new snapshot). */
  markReverify(org: string, element: { page?: string; fieldApiName?: string }): number {
    let n = 0;
    for (const l of this.list({ org })) {
      if (
        (element.page && l.page !== element.page) ||
        (element.fieldApiName && l.fieldApiName !== element.fieldApiName)
      )
        continue;
      this.db
        .prepare(
          "UPDATE locators SET status = 'RE_VERIFY' WHERE org = ? AND page = ? AND element = ? AND persona = ? AND record_type = ?",
        )
        .run(l.org, l.page, l.element, l.persona, l.recordType ?? '');
      n++;
    }
    return n;
  }
}
