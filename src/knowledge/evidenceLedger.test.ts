import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EvidenceLedger, fileSource, querySource, readEvidenceExport, toStateEvidence } from './evidenceLedger.js';

const at = '2026-11-27T10:00:00.000Z';

describe('EvidenceLedger', () => {
  let dir: string;
  let ledger: EvidenceLedger;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qa ledger '));
    ledger = new EvidenceLedger(join(dir, 'mem', 'evidence.db'));
  });
  afterEach(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores claims with hashed file and query sources and exports a run', () => {
    writeFileSync(join(dir, 'error-context.md'), 'button "Save Record"');
    const src = fileSource(dir, 'error-context.md', 'aria');
    expect(src.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fileSource(dir, 'missing.md').sha256).toBeUndefined();
    ledger.add({
      id: 'EV-INV-1',
      runId: 'run-1',
      kind: 'observation',
      claim: 'Save button not found',
      sources: [src, querySource('soql', 'SELECT Id FROM Contact', [{ Id: '003' }])],
      agent: 'failure-investigator',
      confidence: 1,
      environment: 'FIXTURE',
      createdAt: at,
      subject: 'F1',
    });
    expect(ledger.get('EV-INV-1')?.claim).toBe('Save button not found');
    expect(ledger.missing(['EV-INV-1', 'EV-X'])).toEqual(['EV-X']);
    expect(ledger.forSubject('F1')).toHaveLength(1);
    const file = join(dir, 'runs', 'run-1', 'evidence', 'evidence.json');
    ledger.exportRun('run-1', file);
    expect(readEvidenceExport(file)).toHaveLength(1);
    expect(readFileSync(file, 'utf8')).toContain('"type": "aria"');
    expect(toStateEvidence(ledger.get('EV-INV-1')!).sources[0]).toMatch(/^aria:error-context\.md@/);
  });

  it('refuses a claim without sources and replaces only the given kinds of a run', () => {
    expect(() =>
      ledger.add({
        id: 'EV-0',
        runId: 'r',
        kind: 'verdict',
        claim: 'x',
        sources: [],
        agent: 'a',
        confidence: 1,
        environment: 'MOCK',
        createdAt: at,
      }),
    ).toThrow();
    const base = {
      runId: 'r',
      claim: 'c',
      sources: [{ type: 'config' as const, ref: 'x' }],
      agent: 'a',
      confidence: 1,
      environment: 'MOCK' as const,
      createdAt: at,
    };
    ledger.add({ ...base, id: 'A', kind: 'experiment' });
    ledger.add({ ...base, id: 'B', kind: 'heal' });
    expect(ledger.removeRun('r', ['experiment'])).toBe(1);
    expect(ledger.forRun('r').map((e) => e.id)).toEqual(['B']);
  });
});
