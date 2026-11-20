import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * PII + secret redaction (CLAUDE.md rules 10/14, safety skill §Redaction).
 *
 * - Secrets (known values and recognisable key/token formats) → `[REDACTED]` — never recoverable.
 * - PII (emails, phones, Salesforce record IDs, values of known personal fields) → stable tokens like `<EMAIL_1>`;
 *   the token → value mapping stays on this machine (`runs/<runId>/redaction-map.json`, git-ignored) so the operator
 *   report can show real values locally.
 *
 * Free-text personal names cannot be detected reliably; they are masked only when they appear in a known field
 * (Name, FirstName, LastName, …). This limitation is recorded in docs/capability-matrix.md.
 */

export type PiiCategory = 'EMAIL' | 'PHONE' | 'SFID' | 'NAME' | 'ADDRESS';

const SECRET_PATTERNS: RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
  /\b[Bb]earer\s+[A-Za-z0-9._~+/=!-]{12,}/g, // bearer tokens
  /\bAIza[0-9A-Za-z_-]{30,}\b/g, // Google API key
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, // Anthropic
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, // OpenAI
  /\b[sp]k-lf-[A-Za-z0-9-]{8,}\b/g, // Langfuse
  /\bATATT[A-Za-z0-9_=-]{20,}\b/g, // Atlassian API token
  /\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._]{20,}/g, // Salesforce session id / access token
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// Phone: optional country code / area code, then two or three digit groups; ≥7 digits checked separately.
const PHONE =
  /(?<![\w.-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,4}[\s.-]\d{3,4}(?:[\s.-]\d{2,4})?(?![\w.-])/g;
// Salesforce IDs: 15 or 18 chars, key prefix starts with 0 or letter+digit, must contain ≥3 digits.
const SFID = /\b(?:0[0-9A-Za-z]{2}|[A-Za-z][0-9][0-9A-Za-z])[0-9A-Za-z]{12}(?:[0-9A-Za-z]{3})?\b/g;

/** Keys whose values are secrets regardless of content. */
const SECRET_KEYS = new Set([
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'sessionid',
  'authorization',
  'clientsecret',
  'privatekey',
  'xapikey',
  'xgoogapikey',
  'cookie',
]);
const isSecretKey = (key: string): boolean => SECRET_KEYS.has(key.toLowerCase().replace(/[-_]/g, ''));

/** Known personal fields (Salesforce standard names + common variants). */
const PII_FIELDS: Record<string, PiiCategory> = {
  name: 'NAME',
  firstname: 'NAME',
  lastname: 'NAME',
  middlename: 'NAME',
  fullname: 'NAME',
  username: 'NAME',
  email: 'EMAIL',
  personemail: 'EMAIL',
  phone: 'PHONE',
  mobilephone: 'PHONE',
  homephone: 'PHONE',
  otherphone: 'PHONE',
  fax: 'PHONE',
  street: 'ADDRESS',
  mailingstreet: 'ADDRESS',
  billingstreet: 'ADDRESS',
  shippingstreet: 'ADDRESS',
  otherstreet: 'ADDRESS',
  mailingpostalcode: 'ADDRESS',
  billingpostalcode: 'ADDRESS',
  postalcode: 'ADDRESS',
  birthdate: 'NAME',
};

export interface RedactorOptions {
  /** Exact secret values (from env / secret store). */
  secrets?: readonly string[];
  /** Mask Salesforce record IDs (default true — Full Copy IDs are customer data). */
  maskRecordIds?: boolean;
  /** Extra field names (case-insensitive) to mask. */
  extraPiiFields?: Record<string, PiiCategory>;
  /** Disable PII masking (policy `security.redactPii: false`); secrets are always masked. */
  piiEnabled?: boolean;
}

export const REDACTED = '[REDACTED]';

export class Redactor {
  private secrets: string[];
  private readonly tokens = new Map<string, string>(); // original → token
  private readonly reverse = new Map<string, string>(); // token → original
  private readonly counters = new Map<PiiCategory, number>();
  private readonly piiFields: Record<string, PiiCategory>;

  constructor(private readonly opts: RedactorOptions = {}) {
    // Longest first so overlapping secrets are fully removed.
    this.secrets = [...new Set(opts.secrets ?? [])].filter((s) => s.length >= 6).sort((a, b) => b.length - a.length);
    this.piiFields = {
      ...PII_FIELDS,
      ...Object.fromEntries(Object.entries(opts.extraPiiFields ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    };
  }

  /**
   * Register a secret discovered at runtime (e.g. a Salesforce access token obtained in memory). From now on it is
   * masked everywhere this redactor is used.
   */
  addSecret(value: string): void {
    if (value.length < 6 || this.secrets.includes(value)) return;
    this.secrets = [...this.secrets, value].sort((a, b) => b.length - a.length);
  }

  private token(category: PiiCategory, original: string): string {
    const existing = this.tokens.get(original);
    if (existing) return existing;
    const n = (this.counters.get(category) ?? 0) + 1;
    this.counters.set(category, n);
    const t = `<${category}_${n}>`;
    this.tokens.set(original, t);
    this.reverse.set(t, original);
    return t;
  }

  /** Secrets only — used where PII masking is off but secrets must still never leak. */
  redactSecrets(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join(REDACTED);
    for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED);
    return out;
  }

  redactText(text: string): string {
    let out = this.redactSecrets(text);
    if (this.opts.piiEnabled === false) return out;
    out = out.replace(EMAIL, (m) => this.token('EMAIL', m));
    out = out.replace(PHONE, (m) => (m.replace(/\D/g, '').length >= 7 ? this.token('PHONE', m) : m));
    if (this.opts.maskRecordIds !== false) {
      out = out.replace(SFID, (m) => ((m.match(/\d/g)?.length ?? 0) >= 3 ? this.token('SFID', m) : m));
    }
    return out;
  }

  /** Deep-redact any JSON-like value. Keys are kept; values are masked by key name and by content. */
  redactValue<T>(value: T): T {
    return this.walk(value, undefined, new WeakSet()) as T;
  }

  private walk(value: unknown, key: string | undefined, seen: WeakSet<object>): unknown {
    if (key !== undefined && isSecretKey(key)) return value === undefined || value === null ? value : REDACTED;
    if (typeof value === 'string') {
      const cat = key !== undefined && this.opts.piiEnabled !== false ? this.piiFields[key.toLowerCase()] : undefined;
      if (cat && value.length > 0) return this.token(cat, value);
      return this.redactText(value);
    }
    if (Array.isArray(value)) return value.map((v) => this.walk(v, undefined, seen));
    if (value instanceof Error) return { name: value.name, message: this.redactText(value.message) };
    if (value !== null && typeof value === 'object') {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.walk(v, k, seen);
      return out;
    }
    return value;
  }

  /** Local-only mapping token → original value (for the operator's report on this machine). */
  mapping(): Record<string, string> {
    return Object.fromEntries(this.reverse);
  }

  /** Restore tokens in text (operator view only; never call before sending anything off-machine). */
  reveal(text: string): string {
    return text.replace(/<(?:EMAIL|PHONE|SFID|NAME|ADDRESS)_\d+>/g, (t) => this.reverse.get(t) ?? t);
  }

  saveMapping(file: string): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(this.mapping(), null, 2), 'utf8');
  }
}
