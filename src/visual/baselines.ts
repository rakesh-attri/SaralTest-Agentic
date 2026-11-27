// Visual baselines on disk (PLAN.md §7g): `<visual.baselineDir>/<org>/<name>.png` + `baselines.json`
// (BaselineManifest). Fixture and live baselines never mix (one folder per org alias). Only `qa visual approve`
// writes here; a test run never updates a baseline (playwright.visual.config.ts: updateSnapshots 'none').
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { OrgEntry } from '../config/schemas.js';
import { BaselineManifest, type BaselineRecord } from '../core/schemas/visual.js';

export const baselineFolder = (root: string, baselineDir: string, orgAlias: string): string =>
  join(root, baselineDir, orgAlias);
export const baselineImage = (folder: string, name: string): string => join(folder, `${name}.png`);
export const baselineManifestFile = (folder: string): string => join(folder, 'baselines.json');

export const sha256File = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
export const sha256Buffer = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

export function loadBaselines(folder: string, org: OrgEntry): BaselineManifest {
  const f = baselineManifestFile(folder);
  if (!existsSync(f))
    return { org: org.alias, orgId: org.orgId, environment: org.environment, baselines: [], a11y: [] };
  const m = BaselineManifest.parse(JSON.parse(readFileSync(f, 'utf8')));
  if (m.orgId !== org.orgId) {
    throw new Error(`baselines in ${folder} belong to org ${m.orgId}, not ${org.alias} (${org.orgId})`);
  }
  return m;
}

export function saveBaselines(folder: string, m: BaselineManifest): string {
  const f = baselineManifestFile(folder);
  mkdirSync(dirname(f), { recursive: true });
  const sorted: BaselineManifest = {
    ...m,
    baselines: [...m.baselines].sort((a, b) => a.name.localeCompare(b.name)),
    a11y: [...m.a11y].sort((a, b) => `${a.region}-${a.viewport}`.localeCompare(`${b.region}-${b.viewport}`)),
  };
  writeFileSync(f, `${JSON.stringify(BaselineManifest.parse(sorted), null, 2)}\n`, 'utf8');
  return f;
}

export type BaselineTrust =
  { ok: true; record: BaselineRecord } | { ok: false; reason: string; record?: BaselineRecord };

/**
 * Is the baseline file for `name` one a human approved, untouched, on this release? Used to turn a Playwright
 * "match" into MATCH or RE_APPROVE.
 */
export function trustBaseline(folder: string, m: BaselineManifest, name: string, release: string): BaselineTrust {
  const file = baselineImage(folder, name);
  const record = m.baselines.find((b) => b.name === name);
  if (!existsSync(file)) return { ok: false, reason: 'no baseline image', ...(record ? { record } : {}) };
  if (!record) return { ok: false, reason: 'baseline image exists but was never approved with qa visual approve' };
  if (sha256File(file) !== record.sha256) {
    return { ok: false, reason: 'baseline image changed since it was approved (hash differs)', record };
  }
  if (record.release !== release) {
    return { ok: false, reason: `approved on release "${record.release}", the org is now on "${release}"`, record };
  }
  return { ok: true, record };
}
