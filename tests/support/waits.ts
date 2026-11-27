// Wait scaling (Phase 7). Only waits are scaled, never assertions or expected values (CLAUDE.md rule 7):
//   - QA_WAIT_FACTOR (env): the Failure Investigator's rerun-extended-waits experiment, whole run.
//   - tests/support/wait-overrides.json: per-case factors written by the Self-Healer for SCRIPT_TIMING repairs.
//     Each entry names the repair id, so `qa heal revert` can remove it.
// Rule 6 still holds: no fixed sleeps; a longer timeout only lets a web-first wait wait longer.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_FACTOR = 10;

export interface WaitOverride {
  factor: number;
  repairId: string;
}

const clamp = (n: number): number => (Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_FACTOR) : 1);

/** Run-wide factor from QA_WAIT_FACTOR (1 when unset or invalid). */
export function waitFactor(): number {
  return clamp(Number(process.env['QA_WAIT_FACTOR'] ?? '1'));
}

export const waitOverridesFile = (root: string): string => join(root, 'tests', 'support', 'wait-overrides.json');

/** Per-case factors (Self-Healer). Missing / unreadable file → none. */
export function readWaitOverrides(root: string): Record<string, WaitOverride> {
  const f = waitOverridesFile(root);
  if (!existsSync(f)) return {};
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8')) as Record<string, WaitOverride>;
    const out: Record<string, WaitOverride> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (/^TC-[A-Z0-9-]+$/.test(k) && typeof v.factor === 'number' && typeof v.repairId === 'string') {
        out[k] = { factor: clamp(v.factor), repairId: v.repairId };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Case id from a spec file path (…/TC-SF-219-007-name.spec.ts → TC-SF-219-007). */
export const caseIdOfSpec = (file: string): string | undefined => /(TC-[A-Z0-9]+-\d+-\d+)/.exec(file)?.[1];

/** Effective factor for a case: the larger of the run-wide and the per-case factor. */
export function waitFactorFor(root: string, specFile: string | undefined): number {
  const id = specFile ? caseIdOfSpec(specFile) : undefined;
  const o = id ? readWaitOverrides(root)[id] : undefined;
  return Math.max(waitFactor(), o?.factor ?? 1);
}
