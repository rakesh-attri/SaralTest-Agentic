import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConsoleNoise, matchConsoleNoise } from './consoleNoise.js';

const repo = join(import.meta.dirname, '..', '..', '..');

describe('console-noise baseline', () => {
  it('the repo baseline holds the two Salesforce-owned messages from explore-p7-live-2, for qa-prod only', () => {
    const qa = loadConsoleNoise(repo, 'qa-prod');
    expect(qa.map((e) => e.id)).toEqual(['CN-001', 'CN-002']);
    expect(loadConsoleNoise(repo, 'fixture')).toEqual([]);
    const csp =
      "Executing inline event handler violates the following Content Security Policy directive 'script-src 'nonce-x' 'self''. Either the 'unsafe-inline' keyword …";
    expect(matchConsoleNoise(qa, csp)?.id).toBe('CN-001');
    expect(matchConsoleNoise(qa, 'Toast: please provide at least the "label" property to show the toast')?.id).toBe('CN-002');
    expect(matchConsoleNoise(qa, 'TypeError: Cannot read properties of undefined (reading "x")')).toBeUndefined();
  });

  it('refuses a non-Salesforce owner, a too-short pattern and duplicate ids; no file means no noise', () => {
    const root = mkdtempSync(join(tmpdir(), 'qa noise '));
    try {
      expect(loadConsoleNoise(root, 'qa-prod')).toEqual([]);
      mkdirSync(join(root, 'config'));
      const entry = (id: string, extra = ''): string =>
        `  - id: ${id}\n    orgs: [qa-prod]\n    owner: salesforce\n    contains: "a long enough Salesforce message"\n    reason: known\n    acceptedBy: Op\n    acceptedOn: "2026-11-28"\n    source: run / XF-1\n${extra}`;
      writeFileSync(join(root, 'config', 'console-noise.yaml'), `entries:\n${entry('CN-001')}${entry('CN-001')}`);
      expect(() => loadConsoleNoise(root, 'qa-prod')).toThrow(/duplicate id CN-001/);
      writeFileSync(join(root, 'config', 'console-noise.yaml'), `entries:\n${entry('CN-001').replace('owner: salesforce', 'owner: ours')}`);
      expect(() => loadConsoleNoise(root, 'qa-prod')).toThrow();
      writeFileSync(join(root, 'config', 'console-noise.yaml'), `entries:\n${entry('CN-001').replace('a long enough Salesforce message', 'error')}`);
      expect(() => loadConsoleNoise(root, 'qa-prod')).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
