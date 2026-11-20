import { BudgetExceededError, HardStopError, QAError } from './errors.js';
import type { IssueKind } from './schemas/issue.js';

export interface Classification {
  kind: IssueKind;
  message: string;
  /** Small, structured, secret-free facts about the error (codes, status) — never raw payloads. */
  detail: Record<string, unknown>;
}

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ESOCKETTIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const TOOL_UNAVAILABLE_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'EACCES', 'ERR_MODULE_NOT_FOUND']);
const ENVIRONMENT_CODES = new Set(['ENOTFOUND', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);

/** Salesforce REST `errorCode` values → IssueKind. */
const SF_ERROR_CODES: Record<string, IssueKind> = {
  INVALID_SESSION_ID: 'AUTH',
  INVALID_AUTH_HEADER: 'AUTH',
  UNABLE_TO_LOCK_ROW: 'TRANSIENT',
  SERVER_UNAVAILABLE: 'TRANSIENT',
  REQUEST_LIMIT_EXCEEDED: 'ENVIRONMENT',
  REQUIRED_FIELD_MISSING: 'DATA',
  FIELD_CUSTOM_VALIDATION_EXCEPTION: 'DATA',
  DUPLICATE_VALUE: 'DATA',
  DUPLICATES_DETECTED: 'DATA',
  INVALID_FIELD_FOR_INSERT_UPDATE: 'DATA',
  STRING_TOO_LONG: 'DATA',
  INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: 'DATA',
  ENTITY_IS_DELETED: 'DATA',
};

type Bag = Record<string, unknown>;
const isBag = (v: unknown): v is Bag => typeof v === 'object' && v !== null;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function httpStatus(e: Bag): number | undefined {
  const response = isBag(e['response']) ? e['response'] : undefined;
  return num(e['status']) ?? num(e['statusCode']) ?? (response ? num(response['status']) : undefined);
}

function sfErrorCode(e: Bag): string | undefined {
  const direct = str(e['errorCode']);
  if (direct) return direct;
  const body = isBag(e['body']) || Array.isArray(e['body']) ? e['body'] : undefined;
  const first: unknown = Array.isArray(body) ? body[0] : body;
  return isBag(first) ? str(first['errorCode']) : undefined;
}

function fromHttp(status: number): IssueKind {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 408 || status === 429 || status >= 500) return 'TRANSIENT';
  return 'UNKNOWN';
}

/** JSON-RPC / MCP error codes (McpError has a numeric `code` in the reserved range). */
function fromJsonRpc(code: number): IssueKind | undefined {
  if (code === -32001) return 'TRANSIENT'; // request timeout
  if (code === -32000) return 'TOOL_UNAVAILABLE'; // connection closed
  if (code === -32601) return 'TOOL_UNAVAILABLE'; // method / tool not found
  if (code === -32602 || code === -32600 || code === -32700) return 'UNKNOWN'; // bad request — our bug
  if (code <= -32000 && code >= -32099) return 'TOOL_UNAVAILABLE'; // server-defined errors
  return undefined;
}

/**
 * Map any thrown value to an IssueKind (PLAN.md §4 resilientNode). Order matters: explicit types first, then
 * structural signals (Zod, MCP, HTTP, Node codes), then message heuristics, then UNKNOWN.
 */
export function classifyError(err: unknown): Classification {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : 'non-error value thrown';

  if (err instanceof HardStopError) return { kind: 'HARD_STOP', message, detail: { reason: err.reason } };
  if (err instanceof BudgetExceededError) {
    return { kind: 'BUDGET', message, detail: { budget: err.budget, used: err.used, limit: err.limit } };
  }
  if (err instanceof QAError) return { kind: err.kind, message, detail: { ...err.detail } };
  if (!isBag(err)) return { kind: 'UNKNOWN', message, detail: {} };

  const name = str(err['name']) ?? '';
  if (name === 'ZodError' || Array.isArray(err['issues'])) {
    return { kind: 'INVALID_LLM_OUTPUT', message, detail: { name } };
  }

  // Playwright locator problems (exploration / dry-run); generated tests run in the Runner, not here.
  if (/strict mode violation|locator\.|waiting for (get|locator)/i.test(message)) {
    return { kind: 'LOCATOR', message, detail: { name } };
  }

  const sfCode = sfErrorCode(err);
  if (sfCode && sfCode in SF_ERROR_CODES) {
    return { kind: SF_ERROR_CODES[sfCode] ?? 'UNKNOWN', message, detail: { sfErrorCode: sfCode } };
  }

  const code = err['code'];
  if (typeof code === 'number') {
    const k = fromJsonRpc(code);
    if (k) return { kind: k, message, detail: { jsonRpcCode: code } };
  }
  if (typeof code === 'string') {
    if (TRANSIENT_CODES.has(code)) return { kind: 'TRANSIENT', message, detail: { code } };
    if (TOOL_UNAVAILABLE_CODES.has(code)) return { kind: 'TOOL_UNAVAILABLE', message, detail: { code } };
    if (ENVIRONMENT_CODES.has(code)) return { kind: 'ENVIRONMENT', message, detail: { code } };
  }

  const status = httpStatus(err);
  if (status !== undefined) return { kind: fromHttp(status), message, detail: { status } };

  const cause = err['cause'];
  if (cause !== undefined && cause !== err) {
    const inner = classifyError(cause);
    if (inner.kind !== 'UNKNOWN') return { ...inner, message };
  }

  if (name === 'AbortError' || name === 'TimeoutError') return { kind: 'TRANSIENT', message, detail: { name } };
  // Salesforce error codes that only appear in text (e.g. MCP tool error results).
  const textCode = Object.keys(SF_ERROR_CODES).find((k) => new RegExp(`\\b${k}\\b`).test(message));
  if (textCode) return { kind: SF_ERROR_CODES[textCode] ?? 'UNKNOWN', message, detail: { sfErrorCode: textCode } };
  if (/rate limit|quota|too many requests|overloaded/i.test(message)) {
    return { kind: 'TRANSIENT', message, detail: { heuristic: 'rate-limit' } };
  }
  return { kind: 'UNKNOWN', message, detail: name ? { name } : {} };
}
