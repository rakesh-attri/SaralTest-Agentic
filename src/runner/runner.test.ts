import { describe, expect, it } from 'vitest';
import { QAError } from '../core/errors.js';
import { resolveBrowser, type BrowserProbe } from './browser.js';
import type { GateItem } from './gate.js';
import { PlaywrightJson, toTestResults } from './results.js';

const RUN_DIR = 'C:\\Projects\\qa agent\\runs\\run-t';
const spec = (caseNo: string, tests: unknown[]) => ({
  id: `id-${caseNo}`,
  title: `TC-SF-219-${caseNo} title`,
  file: `SF-219/TC-SF-219-${caseNo}-something.spec.ts`,
  tags: [],
  tests,
});
const result = (status: string, extra: Record<string, unknown> = {}) => ({
  status,
  duration: 1000,
  retry: 0,
  errors: [],
  attachments: [],
  ...extra,
});
const test = (status: string, results: unknown[], extra: Record<string, unknown> = {}) => ({
  projectName: 'system-admin',
  status,
  annotations: [{ type: 'data-cleanup', description: 'CLEAN (0 adopted)' }],
  results,
  ...extra,
});
const gate = (caseNo: string, decision: GateItem['decision'], reason = 'r'): GateItem => ({
  caseId: `TC-SF-219-${caseNo}`,
  path: `tests/generated/SF-219/TC-SF-219-${caseNo}-something.spec.ts`,
  decision,
  reason,
});

function results(specs: unknown[], gateItems: GateItem[] = [], authFail?: string) {
  const suites = [
    {
      title: '',
      specs: [],
      suites: [
        { title: 'SF-219', file: 'SF-219', specs },
        ...(authFail
          ? [
              {
                title: 'auth',
                file: 'auth.setup.ts',
                specs: [
                  {
                    id: 'auth',
                    title: 'authenticate persona',
                    file: 'auth.setup.ts',
                    tests: [
                      {
                        projectName: 'auth-system-admin',
                        status: 'unexpected',
                        results: [result('failed', { errors: [{ message: authFail }] })],
                      },
                    ],
                  },
                ],
              },
            ]
          : []),
      ],
    },
  ];
  return toTestResults(PlaywrightJson.parse({ suites }), {
    runId: 'run-t',
    environment: 'FIXTURE',
    snapshotId: 'snap-1',
    browser: 'chromium',
    runDir: RUN_DIR,
    testDirRel: 'tests/generated',
    gate: gateItems,
    redact: (s) => s.replace(/secret-\w+/g, '«secret»'),
  });
}

describe('Playwright JSON → TestResult (runner contract)', () => {
  it('maps pass, fail, timeout, flaky and interrupted; every row keeps its environment label', () => {
    const r = results([
      spec('007', [test('expected', [result('passed')])]),
      spec('008', [test('unexpected', [result('failed', { errors: [{ message: 'Expected "x"\n  got "y"' }] })])]),
      spec('009', [test('unexpected', [result('timedOut', { errors: [{ message: 'Test timeout of 120000ms' }] })])]),
      spec('010', [
        test('flaky', [result('failed', { errors: [{ message: 'locator timeout' }] }), result('passed', { retry: 1 })]),
      ]),
      spec('015', [test('unexpected', [result('interrupted')])]),
    ]);
    expect(r.map((x) => `${x.caseId}:${x.state}`)).toEqual([
      'TC-SF-219-007:PASS',
      'TC-SF-219-008:FAIL',
      'TC-SF-219-009:FAIL',
      'TC-SF-219-010:UNCERTAIN',
      'TC-SF-219-015:UNCERTAIN',
    ]);
    expect(r.every((x) => x.environment === 'FIXTURE')).toBe(true);
    expect(r[1]?.reason).toMatch(/^failed: Expected "x"/);
    expect(r[2]?.reason).toMatch(/^timed out/);
    expect(r[3]).toMatchObject({ flaky: true, attempts: 2 });
    expect(r[3]?.reason).toMatch(/passed only on retry 1 \(flaky\).*locator timeout/);
    expect(r[0]).toMatchObject({
      specPath: 'tests/generated/SF-219/TC-SF-219-007-something.spec.ts',
      persona: 'system-admin',
      browser: 'chromium',
      dataCleanup: 'CLEAN',
    });
  });

  it('auth-setup failure → dependent tests BLOCKED; fixme → SKIPPED', () => {
    const r = results(
      [
        spec('026', [test('skipped', [], { annotations: [] })]),
        spec('036', [
          {
            ...test('skipped', []),
            projectName: 'sales-rep',
            annotations: [{ type: 'fixme', description: 'skeleton' }],
          },
        ]),
      ],
      [],
      'login page shown instead of Lightning (AUTH)',
    );
    expect(r.find((x) => x.caseId === 'TC-SF-219-026')).toMatchObject({ state: 'BLOCKED' });
    expect(r.find((x) => x.caseId === 'TC-SF-219-026')?.reason).toMatch(/persona session not available: login page/);
    expect(r.find((x) => x.caseId === 'TC-SF-219-036')).toMatchObject({ state: 'SKIPPED', reason: 'skeleton' });
  });

  it('data teardown problems are UNCERTAIN, never PASS or a product FAIL', () => {
    const r = results([
      spec('007', [
        {
          ...test('expected', [result('passed')]),
          annotations: [{ type: 'data-cleanup', description: 'INCOMPLETE (0 adopted)' }],
        },
      ]),
      spec('008', [
        test('unexpected', [
          result('failed', { errors: [{ message: 'QAError: cleanup INCOMPLETE: 1 record(s) remain' }] }),
        ]),
      ]),
    ]);
    expect(r.map((x) => x.state)).toEqual(['UNCERTAIN', 'UNCERTAIN']);
    expect(r[0]?.dataCleanup).toBe('INCOMPLETE');
    expect(r[1]?.reason).toMatch(/test steps passed but/);
  });

  it('gate rows that did not run are listed with their reason; a selected spec without a result is UNCERTAIN', () => {
    const r = results(
      [spec('007', [test('expected', [result('passed')])])],
      [
        gate('007', 'EXECUTE'),
        gate('008', 'EXECUTE'),
        gate('012', 'NOT_APPROVED', 'review status REVIEW_REQUIRED'),
        gate('020', 'BLOCKED', 'stale: ValidationRule:Contact.X changed in snap-2'),
        { caseId: 'TC-SF-219-051', decision: 'MANUAL', reason: 'human check' },
        gate('036', 'NOT_SELECTED', 'not selected for this run (--cases)'),
      ],
    );
    const by = (id: string) => r.find((x) => x.caseId === `TC-SF-219-${id}`);
    expect(by('007')?.state).toBe('PASS');
    expect(by('008')).toMatchObject({ state: 'UNCERTAIN' });
    expect(by('008')?.reason).toMatch(/no result in the Playwright report/);
    expect(by('012')).toMatchObject({ state: 'SKIPPED', reason: 'not executed — review status REVIEW_REQUIRED' });
    expect(by('020')).toMatchObject({ state: 'BLOCKED' });
    expect(by('051')).toMatchObject({ state: 'SKIPPED', reason: 'manual-only: human check' });
    expect(by('036')?.state).toBe('SKIPPED');
  });

  it('errors are redacted and attachment paths are made relative to the run folder', () => {
    const r = results([
      spec('009', [
        test('unexpected', [
          result('failed', {
            errors: [{ message: '\u001b[31mError\u001b[39m: token secret-abc123 rejected' }],
            attachments: [
              { name: 'trace', path: `${RUN_DIR}\\test-results\\tc-009\\trace.zip`, contentType: 'application/zip' },
            ],
          }),
        ]),
      ]),
    ]);
    expect(r[0]?.errorSummary).toBe('Error: token «secret» rejected');
    expect(r[0]?.reason).not.toContain('secret-abc123');
    expect(r[0]?.attachments).toEqual([{ name: 'trace', path: 'test-results/tc-009/trace.zip' }]);
  });
});

describe('browser channel switch', () => {
  const probe =
    (installed: string[]): BrowserProbe =>
    (b) =>
      Promise.resolve(
        installed.includes(b) ? { ok: true } : { ok: false, error: `Chromium distribution '${b}' is not found` },
      );

  it('--browser beats QA_BROWSER beats execution.yaml', async () => {
    const all = probe(['chromium', 'chrome', 'msedge']);
    expect(await resolveBrowser({ option: 'chrome', env: 'msedge', configured: 'chromium', probe: all })).toEqual({
      browser: 'chrome',
      requested: 'chrome',
      source: 'option',
    });
    expect((await resolveBrowser({ env: 'msedge', configured: 'chromium', probe: all })).browser).toBe('msedge');
    expect((await resolveBrowser({ configured: 'chromium', probe: all })).source).toBe('config');
  });

  it('a missing channel falls back to fallbackBrowser and says so; an unknown name is refused', async () => {
    const c = await resolveBrowser({
      option: 'chrome',
      configured: 'chromium',
      fallback: 'msedge',
      probe: probe(['chromium', 'msedge']),
    });
    expect(c).toMatchObject({ browser: 'msedge', requested: 'chrome' });
    expect(c.fallbackReason).toMatch(/chrome could not be launched .*not found.*ran on msedge/);
    await expect(
      resolveBrowser({ option: 'firefox', configured: 'chromium', probe: probe([]) }),
    ).rejects.toBeInstanceOf(QAError);
    await expect(resolveBrowser({ option: 'chromium', configured: 'chromium', probe: probe([]) })).rejects.toThrow(
      /could not be launched/,
    );
  });
});
