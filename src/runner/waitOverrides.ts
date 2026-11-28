// Per-case wait factors written by the Self-Healer for SCRIPT_TIMING repairs (`tests/support/wait-overrides.json`).
// Read by tests/support/waits.ts inside Playwright workers; written / reverted by src/agents/self-healer.
// Only waits are scaled — never assertions or expected values (CLAUDE.md rule 7).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_WAIT_FACTOR = 10;

export interface WaitOverride {
  factor: number;
  repairId: string;
}

export const clampFactor = (n: number): number => (Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_WAIT_FACTOR) : 1);

export const waitOverridesFile = (root: string): string => join(root, 'tests', 'support', 'wait-overrides.json');

/** Per-case factors. Missing / unreadable file → none. */
export function readWaitOverrides(root: string): Record<string, WaitOverride> {
  const f = waitOverridesFile(root);
  if (!existsSync(f)) return {};
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8')) as Record<string, WaitOverride>;
    const out: Record<string, WaitOverride> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (/^TC-[A-Z0-9-]+$/.test(k) && typeof v.factor === 'number' && typeof v.repairId === 'string') {
        out[k] = { factor: clampFactor(v.factor), repairId: v.repairId };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Case id from a spec file path (…/TC-SF-219-007-name.spec.ts → TC-SF-219-007). */
export const caseIdOfSpec = (file: string): string | undefined => /(TC-[A-Z0-9]+-\d+-\d+)/.exec(file)?.[1];
