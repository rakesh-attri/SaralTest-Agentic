import { describe, expect, it } from 'vitest';
import { PlaywrightJson, toTestResults } from '../../runner/results.js';
import type { TestResult } from '../../core/schemas/index.js';
import { extractSignals, signalsOfMessage } from './signals.js';

const kinds = (m: string) => signalsOfMessage(m, { source: 't' }).map((s) => s.kind);

// Real qa-prod message shape (run-p5-live-4, TC-007), record id replaced.
const URL_MSG = `Error: expect(page).toHaveURL(expected) failed

Expected pattern: /\\/lightning\\/r\\/Contact\\/([a-zA-Z0-9]{15,18})\\/view/
Received string:  "https://example.lightning.force.com/lightning/r/Account/<SFID_1>/view"
Timeout: 60000ms`;

const NOT_FOUND = `Error: expect(locator).toBeVisible() failed

Locator: getByRole('dialog', { name: 'New Contact' }).getByRole('button', { name: 'Save' })
Expected: visible
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 15000ms
  - waiting for getByRole('dialog', { name: 'New Contact' }).getByRole('button', { name: 'Save' })`;

const CLICK_TIMEOUT = `Error: locator.click: Timeout 30000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'New' })`;

describe('signalsOfMessage', () => {
  it('reads a URL mismatch with expected and received', () => {
    const [s] = signalsOfMessage(URL_MSG, { source: 'error', step: '2. Save' });
    expect(s).toMatchObject({ kind: 'URL_MISMATCH', step: '2. Save' });
    expect(s?.expected).toContain('Contact');
    expect(s?.received).toContain('/Account/');
  });

  it('an assertion on an element that was never found is a locator signal, not a value mismatch', () => {
    const s = signalsOfMessage(NOT_FOUND, { source: 'e' });
    expect(s.map((x) => x.kind)).toEqual(['LOCATOR_NOT_FOUND']);
    expect(s[0]?.locator).toBe("getByRole('dialog', { name: 'New Contact' }).getByRole('button', { name: 'Save' })");
  });

  it('action timeouts, strict mode and value mismatches', () => {
    expect(kinds(CLICK_TIMEOUT)).toEqual(['LOCATOR_NOT_FOUND']);
    expect(
      kinds(
        "Error: locator.click: Error: strict mode violation: getByRole('button', { name: 'Save' }) resolved to 2 elements",
      ),
    ).toContain('LOCATOR_NOT_UNIQUE');
    expect(
      kinds(
        'Error: expect(locator).toHaveText(expected) failed\n\nLocator: getByText(\'x\')\nExpected string: "A"\nReceived string: "B"',
      ),
    ).toEqual(['ASSERTION_MISMATCH']);
  });

  it('data, environment and permission signals', () => {
    expect(kinds('QAError: create Account (account) failed: FIELD_CUSTOM_VALIDATION_EXCEPTION')).toEqual([
      'DATA_SETUP_FAILED',
      'VALIDATION_ERROR',
    ]);
    expect(kinds('Error: page.goto: 503 Service Unavailable')).toEqual(
      expect.arrayContaining(['HTTP_5XX', 'MAINTENANCE']),
    );
    expect(kinds('TypeError: fetch failed')).toEqual(['NETWORK_ERROR']);
    expect(kinds("Error: sObject type 'Contact' is not supported")).toEqual(['INSUFFICIENT_ACCESS']);
    expect(kinds('Error: Test timeout of 60000ms exceeded while waitForSpinners')).toContain('WAIT_TIMEOUT');
  });
});

describe('failure detail from Playwright JSON + extractSignals', () => {
  const runDir = 'C:\\Projects\\qa agent\\runs\\run-t';
  const repoRoot = 'C:\\Projects\\qa agent';
  const attempt = (retry: number, message: string) => ({
    status: 'failed',
    duration: 10,
    retry,
    errors: [
      {
        message,
        stack: `${message}\n    at expectRecordPage (C:\\Projects\\qa agent\\tests\\support\\lightning.ts:137:22)\n    at C:\\Projects\\qa agent\\tests\\generated\\SF-219\\TC-SF-219-007-x.spec.ts:41:7`,
        location: { file: 'C:\\Projects\\qa agent\\tests\\support\\lightning.ts', line: 137, column: 22 },
      },
    ],
    steps: [
      { title: '1. Open', steps: [] },
      { title: '2. Save', error: { message }, steps: [{ title: 'inner click', error: { message } }] },
    ],
    attachments: [
      { name: 'screenshot', contentType: 'image/png', path: `${runDir}\\test-results\\x\\test-failed-1.png` },
      { name: 'trace', contentType: 'application/zip', path: `${runDir}\\test-results\\x\\trace.zip` },
      { name: 'error-context', contentType: 'text/markdown', path: `${runDir}\\test-results\\x\\error-context.md` },
    ],
  });
  const json = PlaywrightJson.parse({
    suites: [
      {
        title: 'SF-219',
        specs: [
          {
            id: 's1',
            title: 'TC-SF-219-007 x',
            file: 'SF-219/TC-SF-219-007-x.spec.ts',
            tests: [
              {
                projectName: 'system-admin',
                status: 'unexpected',
                annotations: [{ type: 'data-cleanup', description: 'CLEAN (0 adopted)' }],
                results: [attempt(0, URL_MSG), attempt(1, URL_MSG)],
              },
            ],
          },
        ],
      },
    ],
  });
  const [r] = toTestResults(json, {
    runId: 'run-t',
    environment: 'FIXTURE',
    snapshotId: 's',
    browser: 'chromium',
    runDir,
    repoRoot,
    testDirRel: 'tests/generated',
    gate: [],
  }) as [TestResult];

  it('keeps per-attempt errors, spec line (path with spaces), innermost failed step and artifacts', () => {
    expect(r.state).toBe('FAIL');
    expect(r.failure?.attempts).toHaveLength(2);
    expect(r.failure?.attempts[0]).toMatchObject({
      location: 'tests/support/lightning.ts:137',
      specLine: 'tests/generated/SF-219/TC-SF-219-007-x.spec.ts:41',
      failedStep: 'inner click',
    });
    expect(r.failure?.steps).toEqual([
      { title: '1. Open', ok: true },
      { title: '2. Save', ok: false },
    ]);
    expect(r.failure?.errorContext).toBe('test-results/x/error-context.md');
    expect(r.failure?.trace).toBe('test-results/x/trace.zip');
    expect(r.failure?.screenshot).toBe('test-results/x/test-failed-1.png');
  });

  it('extracts de-duplicated signals across attempts', () => {
    const s = extractSignals(r);
    expect(s.map((x) => x.kind)).toEqual(['URL_MISMATCH']);
  });

  it('falls back to the error summary for Phase 5 results', () => {
    const old = { ...r, failure: undefined, errorSummary: CLICK_TIMEOUT };
    expect(extractSignals(old).map((x) => x.kind)).toEqual(['LOCATOR_NOT_FOUND']);
  });
});
