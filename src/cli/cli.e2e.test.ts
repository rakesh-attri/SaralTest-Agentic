import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function qa(args: string[], cwd: string, input?: string): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [QA, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 150_000,
    windowsHide: true,
    ...(input !== undefined ? { input } : {}),
  });
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
    const r = qa(['learnings', 'list'], root);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/qa learnings: not implemented yet — planned for Phase 8/);
  });

  it('--help lists the commands', () => {
    const r = qa(['--help'], root);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/doctor/);
    expect(r.stdout).toMatch(/fixture/);
  });

  const STORY = [
    '**Summary:** Agents log calls',
    '',
    'AC1 – Log',
    'Given I view a Case',
    'When I click Log a Call',
    'Then a Task is created',
    '',
    'AC2 – Subject',
    'Then the Subject must be one of the approved subjects',
  ].join('\n');

  it('qa analyze --offline --no-input: file + manual tests in folders with spaces → report, flagged assumptions', () => {
    writeFileSync(join(root, 'call story.md'), STORY);
    writeFileSync(
      join(root, 'manual cases.csv'),
      'Test ID,Title,Requirement Ref,Last Run Status\nTC-1,Log a call,AC1,Failed\n',
    );
    const r = qa(
      [
        'analyze',
        '--file',
        'call story.md',
        '--manual-tests',
        'manual cases.csv',
        '--offline',
        '--no-input',
        '--run-id',
        'run-e2e-file',
      ],
      root,
    );
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\[mechanical: no model\]/);
    expect(r.stdout).toMatch(/Requirements: 2 \(0 executable, 2 review required\)/);
    expect(r.stdout).toMatch(/Q1 \[ASSUMED\]/);
    const dir = join(root, 'runs', 'run-e2e-file', 'analysis');
    expect(JSON.parse(readFileSync(join(dir, 'existing-tests.json'), 'utf8'))).toHaveLength(1);
    expect(readFileSync(join(dir, 'analysis-report.md'), 'utf8')).toMatch(/RISK_SIGNAL/);
  }, 160_000);

  it('qa analyze interactive: answers typed on stdin are recorded; qa resume on a finished run says so', () => {
    const r = qa(
      ['analyze', '--text', STORY, '--offline', '--run-id', 'run-e2e-chat'],
      root,
      'Only Inbound and Outbound\n',
    );
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/Clarification round 1/);
    expect(r.stdout).toMatch(/Q1 \[ANSWERED\]/);
    expect(r.stdout).toMatch(/answer: Only Inbound and Outbound/);
    const again = qa(['resume', '--run', 'run-e2e-chat', '--offline'], root, '');
    expect(again.stderr + again.stdout).toMatch(/already finished with status/);
  }, 160_000);

  it('qa analyze without any spec input explains what is needed (exit 2)', () => {
    const r = qa(['analyze', '--manual-tests', 'x.csv'], root);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/give at least one of --story, --file, --text or --ado/);
  });
});
