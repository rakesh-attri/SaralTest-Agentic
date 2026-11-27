// Deterministic signals of a failed result (defect-investigation SKILL, "Observe"). Pure text rules over the redacted
// failure detail the Runner stored: no model, no network. Each signal names where it came from, so the investigation
// report can cite it. A signal is a fact about the failure text, not a verdict.
import type { FailureSignal, TestResult } from '../../core/schemas/index.js';

const SF_CODES = [
  'FIELD_CUSTOM_VALIDATION_EXCEPTION',
  'REQUIRED_FIELD_MISSING',
  'INVALID_EMAIL_ADDRESS',
  'STRING_TOO_LONG',
  'DUPLICATES_DETECTED',
  'DUPLICATE_VALUE',
  'INSUFFICIENT_ACCESS_OR_READONLY',
  'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY',
  'INVALID_FIELD_FOR_INSERT_UPDATE',
  'ENTITY_IS_DELETED',
  'INVALID_CROSS_REFERENCE_KEY',
  'DELETE_FAILED',
  'UNABLE_TO_LOCK_ROW',
  'REQUEST_LIMIT_EXCEEDED',
  'INVALID_SESSION_ID',
  'SERVER_UNAVAILABLE',
];

/** `getByRole('button', { name: 'Save' })` / `locator('…')` quoted in a Playwright error. */
const LOCATOR_IN_ERROR =
  /((?:getBy(?:Role|Label|Text|Placeholder|TestId|Title|AltText)|locator)\((?:[^()]|\([^()]*\))*\)(?:\.(?:getBy\w+|locator|filter)\((?:[^()]|\([^()]*\))*\))*)/;
const EXPECTED = /^\s*Expected(?: pattern| string| value)?:\s*(.+)$/m;
const RECEIVED = /^\s*Received(?: string| value)?:\s*(.+)$/m;

function sfCode(text: string): string | undefined {
  return SF_CODES.find((c) => text.includes(c));
}

/** Signals from one error message (+ step / attempt context). */
export function signalsOfMessage(message: string, ctx: { step?: string; source: string }): FailureSignal[] {
  const out: FailureSignal[] = [];
  const base = { source: ctx.source, ...(ctx.step ? { step: ctx.step } : {}) };
  const first = message.split('\n').find((l) => l.trim()) ?? '';
  const loc = LOCATOR_IN_ERROR.exec(message)?.[1];
  const code = sfCode(message);
  const exp = EXPECTED.exec(message)?.[1]?.trim();
  const rec = RECEIVED.exec(message)?.[1]?.trim();

  // Data setup (the test's own data sub-run): DataEngine / data fixture messages.
  if (
    /\bcreate \w+ \([\w-]+\) failed\b|data plan \S+ is invalid|recipe \S+ is not approved|no data step \S+ in this test/.test(
      message,
    )
  ) {
    out.push({ kind: 'DATA_SETUP_FAILED', detail: first, ...(code ? { sfErrorCode: code } : {}), ...base });
  }
  if (/cleanup (INCOMPLETE|KEPT)/.test(message)) out.push({ kind: 'DATA_NOT_CLEAN', detail: first, ...base });
  if (/strict mode violation/i.test(message)) {
    out.push({ kind: 'LOCATOR_NOT_UNIQUE', detail: first, ...(loc ? { locator: loc } : {}), ...base });
  }
  // toHaveURL before generic assertion: the expected page did not open.
  if (/toHaveURL/.test(message)) {
    out.push({
      kind: 'URL_MISMATCH',
      detail: first,
      ...(exp ? { expected: exp } : {}),
      ...(rec ? { received: rec } : {}),
      ...base,
    });
  } else if (/expect\(.*\)\.\w+/.test(first) || /^\s*Expected/m.test(message)) {
    // An assertion whose element was never found is a locator problem, not a value mismatch.
    const elementMissing = /element\(s\) not found|waiting for (?:getBy|locator)/.test(message) && !rec;
    if (elementMissing) {
      out.push({ kind: 'LOCATOR_NOT_FOUND', detail: first, ...(loc ? { locator: loc } : {}), ...base });
    } else {
      out.push({
        kind: 'ASSERTION_MISMATCH',
        detail: first,
        ...(exp ? { expected: exp } : {}),
        ...(rec ? { received: rec } : {}),
        ...(loc ? { locator: loc } : {}),
        ...base,
      });
    }
  } else if (/(?:locator\.\w+|page\.\w+): Timeout \d+ms exceeded|waiting for (?:getBy|locator)/.test(message)) {
    // An action (click / fill …) waited for an element that never became actionable.
    out.push({ kind: 'LOCATOR_NOT_FOUND', detail: first, ...(loc ? { locator: loc } : {}), ...base });
  }
  if (
    /Test timeout of \d+ms exceeded|Timeout \d+ms exceeded while waiting|waitFor(?:Spinner|Toast|LoadState|Response)|spinner/i.test(
      message,
    ) &&
    !out.some((s) => s.kind === 'LOCATOR_NOT_FOUND')
  ) {
    out.push({ kind: 'WAIT_TIMEOUT', detail: first, ...base });
  }
  if (
    /\b(?:HTTP |status |statusCode[=: ]+)?5\d\d\b(?: Service Unavailable| Internal Server Error| Bad Gateway| Gateway Timeout)|SERVER_UNAVAILABLE/.test(
      message,
    )
  ) {
    out.push({ kind: 'HTTP_5XX', detail: first, ...base });
  }
  if (/maintenance|Service Unavailable|temporarily unavailable/i.test(message)) {
    out.push({ kind: 'MAINTENANCE', detail: first, ...base });
  }
  if (
    /login\.salesforce\.com|\/secur\/login|Login \| Salesforce|INVALID_SESSION_ID|session (?:expired|not available)/i.test(
      message,
    )
  ) {
    out.push({ kind: 'LOGIN_PAGE', detail: first, ...base });
  }
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|net::ERR_/.test(message)) {
    out.push({ kind: 'NETWORK_ERROR', detail: first, ...base });
  }
  if (
    code?.startsWith('INSUFFICIENT_ACCESS') ||
    /insufficient (?:access|privileges)|sObject type '\w+' is not supported/i.test(message)
  ) {
    out.push({ kind: 'INSUFFICIENT_ACCESS', detail: first, ...(code ? { sfErrorCode: code } : {}), ...base });
  }
  if (code === 'FIELD_CUSTOM_VALIDATION_EXCEPTION' || code === 'REQUIRED_FIELD_MISSING') {
    out.push({ kind: 'VALIDATION_ERROR', detail: first, sfErrorCode: code, ...base });
  }
  if (code === 'DUPLICATES_DETECTED' || code === 'DUPLICATE_VALUE') {
    out.push({ kind: 'DUPLICATE_RULE', detail: first, sfErrorCode: code, ...base });
  }
  return out;
}

/** All signals of a failed / uncertain result, de-duplicated by (kind, detail). */
export function extractSignals(r: TestResult): FailureSignal[] {
  const out: FailureSignal[] = [];
  const f = r.failure;
  const attempts = f?.attempts ?? [];
  if (attempts.length) {
    for (const a of attempts) {
      out.push(
        ...signalsOfMessage(a.message, {
          source: `error:attempt-${a.attempt}`,
          ...(a.failedStep ? { step: a.failedStep } : {}),
        }),
      );
    }
  } else if (r.errorSummary || r.reason) {
    // Results from before Phase 7 have only the summary.
    out.push(...signalsOfMessage(r.errorSummary ?? r.reason ?? '', { source: 'error:summary' }));
  }
  if (r.flaky) out.push({ kind: 'PASSED_ON_RETRY', detail: r.reason ?? 'passed only on retry', source: 'retry' });
  const firstLines = attempts.map((a) => a.message.split('\n')[0]?.trim() ?? '');
  if (attempts.length > 1 && new Set(firstLines).size > 1 && !r.flaky) {
    out.push({ kind: 'DIFFERENT_FAILURE_ON_RETRY', detail: firstLines.join(' | '), source: 'retry' });
  }
  if (r.dataCleanup === 'INCOMPLETE' || r.dataCleanup === 'KEPT') {
    out.push({ kind: 'DATA_NOT_CLEAN', detail: `data cleanup ${r.dataCleanup}`, source: 'data' });
  }
  const seen = new Set<string>();
  return out.filter((s) => {
    const k = `${s.kind}|${s.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export const hasSignal = (signals: readonly FailureSignal[], ...kinds: FailureSignal['kind'][]): boolean =>
  signals.some((s) => kinds.includes(s.kind));
