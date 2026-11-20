import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, makeTempProject } from '../../tests/helpers/tempProject.js';

const QA = join(REPO_ROOT, 'bin', 'qa.mjs');
const root = makeTempProject();
const elsewhere = mkdtempSync(join(tmpdir(), 'qa somewhere else '));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

function qa(args: string[], cwd: string): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [QA, ...args], { cwd, encoding: 'utf8', timeout: 150_000, windowsHide: true });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('qa CLI end-to-end (paths with spaces)', () => {
  it('qa doctor --offline --json from inside a project folder with spaces', () => {
    const r = qa(['doctor', '--offline', '--json'], root);
    expect(r.code, r.stderr).toBe(0);
    const report = JSON.parse(r.stdout) as { root: string; counts: { red: number }; savedTo: string };
    expect(report.root).toBe(root);
    expect(report.counts.red).toBe(0);
    expect(report.savedTo.startsWith(join(root, 'runs'))).toBe(true);
    expect(existsSync(report.savedTo)).toBe(true);
  }, 160_000);

  it('qa --root "<path with spaces>" doctor works from another folder', () => {
    const r = qa(['--root', root, 'doctor', '--offline', '--json'], elsewhere);
    expect(r.code, r.stderr).toBe(0);
    expect((JSON.parse(r.stdout) as { root: string }).root).toBe(root);
  }, 160_000);

  it('later-phase commands say which phase delivers them (exit 2)', () => {
    const r = qa(['run', '--story', 'SF-DEMO-1'], root);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/qa run: not implemented yet — planned for Phase 5/);
  });

  it('--help lists the commands', () => {
    const r = qa(['--help'], root);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/doctor/);
    expect(r.stdout).toMatch(/fixture/);
  });
});
