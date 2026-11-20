import type { OrgEntry, Persona } from '../../config/schemas.js';

/** How a session was obtained. `fixture` sessions are never live evidence (CLAUDE.md rule 13). */
export type SessionSource = 'sf-cli' | 'jwt' | 'fixture';

/**
 * An API session for one persona on one org. The access token lives in memory only: it is registered with the
 * Redactor as soon as it is obtained and is never logged, written to a report or put in a prompt (rule 10).
 */
export interface SfSession {
  orgAlias: string;
  personaId: string;
  username: string;
  /** 18-char org ID as reported by the auth source (identity check verifies it against Salesforce). */
  orgId: string;
  instanceUrl: string;
  accessToken: string;
  apiVersion: string;
  source: SessionSource;
  obtainedAt: number;
}

export interface SessionRequest {
  persona: Persona;
  org: OrgEntry;
  /** Ignore a cached session and fetch a new one (e.g. after INVALID_SESSION_ID). */
  refresh?: boolean;
}

export interface SessionProvider {
  readonly kind: SessionSource | 'sf-cli+jwt';
  session(req: SessionRequest): Promise<SfSession>;
  /** One-time browser login URL that lands on `path` (relative, e.g. `/lightning/page/home`). Treat as a secret. */
  frontdoorUrl(req: SessionRequest, path?: string): Promise<string>;
}

/** Called with every secret the auth layer learns, so it can be masked (Redactor.addSecret). */
export type SecretSink = (value: string) => void;
