// Wait scaling (Phase 7). Only waits are scaled, never assertions or expected values (CLAUDE.md rule 7):
//   - QA_WAIT_FACTOR (env): the Failure Investigator's rerun-extended-waits experiment, whole run.
//   - tests/support/wait-overrides.json: per-case factors written by the Self-Healer for SCRIPT_TIMING repairs
//     (src/runner/waitOverrides.ts). Each entry names the repair id, so `qa heal revert` can remove it.
// Rule 6 still holds: no fixed sleeps; a longer timeout only lets a web-first wait wait longer.
import { test } from '@playwright/test';
import { caseIdOfSpec, clampFactor, readWaitOverrides } from '../../src/runner/waitOverrides.js';

/** Run-wide factor from QA_WAIT_FACTOR (1 when unset or invalid). */
export function waitFactor(): number {
  return clampFactor(Number(process.env['QA_WAIT_FACTOR'] ?? '1'));
}

/** Effective factor for a case: the larger of the run-wide and the per-case factor. */
export function waitFactorFor(root: string, specFile: string | undefined): number {
  const id = specFile ? caseIdOfSpec(specFile) : undefined;
  const o = id ? readWaitOverrides(root)[id] : undefined;
  return Math.max(waitFactor(), o?.factor ?? 1);
}

/**
 * A helper's wait, scaled for the running test (QA_WAIT_FACTOR × per-case override). Outside a test (unit tests,
 * page-object probes) only QA_WAIT_FACTOR applies. The Runner starts Playwright in the repo root (cwd).
 */
export function scaled(ms: number): number {
  let file: string | undefined;
  try {
    file = test.info().file;
  } catch {
    file = undefined;
  }
  return Math.round(ms * waitFactorFor(process.cwd(), file));
}
