import { Connection } from 'jsforce';
import { z } from 'zod';
import { QAError } from '../core/errors.js';
import type { SfSession } from './auth/types.js';

export type SfEnvironment = 'LIVE' | 'FIXTURE';

export interface QueryOptions {
  /** Tooling API (`/tooling/query`). */
  tooling?: boolean;
  /** Stop after this many records (safety cap for large orgs; default 50 000). */
  maxRecords?: number;
}

export interface ApiVersion {
  version: string;
  label?: string;
}

/**
 * The Salesforce REST surface the agent uses (observe calls + record writes). Implemented by jsforce for real orgs
 * and the fixture; unit tests may use a fake. Agents never get this object directly — they get `GuardedSalesforce`,
 * which tags calls observe/mutate and sends mutations through the org-profile guard and audit log.
 */
export interface SfApi {
  readonly environment: SfEnvironment;
  readonly instanceUrl: string;
  readonly apiVersion: string;
  query<T = Record<string, unknown>>(soql: string, opts?: QueryOptions): Promise<T[]>;
  describe(sobject: string): Promise<Record<string, unknown>>;
  describeGlobal(): Promise<Record<string, unknown>>;
  userinfo(): Promise<Record<string, unknown>>;
  apiVersions(): Promise<ApiVersion[]>;
  /** GET a REST path relative to `/services/data/vXX.X` (e.g. `/tooling/sobjects/Flow/301…`). */
  get(path: string): Promise<unknown>;
  create(sobject: string, record: Record<string, unknown>): Promise<string>;
  update(sobject: string, id: string, fields: Record<string, unknown>): Promise<void>;
  destroy(sobject: string, id: string): Promise<void>;
}

const QueryPage = z.looseObject({
  totalSize: z.number().optional(),
  done: z.boolean(),
  nextRecordsUrl: z.string().optional(),
  records: z.array(z.record(z.string(), z.unknown())),
});

const ApiVersions = z.array(z.looseObject({ version: z.string(), label: z.string().optional() }));

/** Remove jsforce/Salesforce `attributes` blocks so hashes and reports only contain field data. */
export function stripAttributes<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripAttributes(v) as unknown) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'attributes') continue;
      out[k] = stripAttributes(v);
    }
    return out as T;
  }
  return value;
}

const AUTH_CODES = new Set(['INVALID_SESSION_ID', 'INVALID_AUTH_HEADER', 'Missing_OAuth_Token']);

function isAuthError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { errorCode?: unknown; name?: unknown };
  return (
    (typeof e.errorCode === 'string' && AUTH_CODES.has(e.errorCode)) ||
    (typeof e.name === 'string' && AUTH_CODES.has(e.name))
  );
}

/** jsforce wrapper. Errors keep their Salesforce `errorCode` so classifyError maps them (AUTH, TRANSIENT, DATA…). */
export class JsforceApi implements SfApi {
  private conn: Connection;

  /**
   * @param renew returns a fresh access token (new JWT grant). Used once when a call fails with an expired or invalid
   * session, so long discoveries survive the org's session timeout.
   */
  constructor(
    readonly instanceUrl: string,
    accessToken: string,
    readonly apiVersion: string,
    readonly environment: SfEnvironment,
    private readonly renew?: () => Promise<string>,
  ) {
    this.conn = new Connection({ instanceUrl, accessToken, version: apiVersion });
  }

  static fromSession(s: SfSession, environment: SfEnvironment, renew?: () => Promise<string>): JsforceApi {
    return new JsforceApi(s.instanceUrl, s.accessToken, s.apiVersion, environment, renew);
  }

  private async request(req: Parameters<Connection['request']>[0]): Promise<unknown> {
    try {
      return await this.conn.request(req);
    } catch (err) {
      if (!this.renew || !isAuthError(err)) throw err;
      const token = await this.renew();
      this.conn = new Connection({ instanceUrl: this.instanceUrl, accessToken: token, version: this.apiVersion });
      return this.conn.request(req);
    }
  }

  private base(tooling: boolean): string {
    return `/services/data/v${this.apiVersion}${tooling ? '/tooling' : ''}`;
  }

  async query<T = Record<string, unknown>>(soql: string, opts: QueryOptions = {}): Promise<T[]> {
    const max = opts.maxRecords ?? 50_000;
    const out: Record<string, unknown>[] = [];
    let url: string | undefined = `${this.base(opts.tooling ?? false)}/query?q=${encodeURIComponent(soql)}`;
    while (url && out.length < max) {
      const page = QueryPage.parse(await this.request(url));
      out.push(...page.records);
      url = page.done ? undefined : page.nextRecordsUrl;
    }
    return stripAttributes(out.slice(0, max)) as T[];
  }

  async describe(sobject: string): Promise<Record<string, unknown>> {
    return z
      .record(z.string(), z.unknown())
      .parse(await this.request(`${this.base(false)}/sobjects/${encodeURIComponent(sobject)}/describe`));
  }

  async describeGlobal(): Promise<Record<string, unknown>> {
    return z.record(z.string(), z.unknown()).parse(await this.request(`${this.base(false)}/sobjects`));
  }

  async userinfo(): Promise<Record<string, unknown>> {
    return z.record(z.string(), z.unknown()).parse(await this.request('/services/oauth2/userinfo'));
  }

  async apiVersions(): Promise<ApiVersion[]> {
    return ApiVersions.parse(await this.request('/services/data')).map((v) => ({
      version: v.version,
      ...(v.label ? { label: v.label } : {}),
    }));
  }

  async get(path: string): Promise<unknown> {
    if (!path.startsWith('/')) throw new QAError('UNKNOWN', `REST path must start with /: ${path}`);
    return this.request(`${this.base(false)}${path}`);
  }

  async create(sobject: string, record: Record<string, unknown>): Promise<string> {
    const r = z.looseObject({ id: z.string(), success: z.boolean() }).parse(
      await this.request({
        method: 'POST',
        url: `${this.base(false)}/sobjects/${sobject}`,
        body: JSON.stringify(record),
        headers: { 'content-type': 'application/json' },
      }),
    );
    return r.id;
  }

  async update(sobject: string, id: string, fields: Record<string, unknown>): Promise<void> {
    await this.request({
      method: 'PATCH',
      url: `${this.base(false)}/sobjects/${sobject}/${id}`,
      body: JSON.stringify(fields),
      headers: { 'content-type': 'application/json' },
    });
  }

  async destroy(sobject: string, id: string): Promise<void> {
    await this.request({ method: 'DELETE', url: `${this.base(false)}/sobjects/${sobject}/${id}` });
  }
}
