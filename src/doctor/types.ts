import type { Logger } from '../core/logger.js';
import type { Env } from '../config/env.js';
import type { AllConfigResults, ProjectPaths } from '../config/loader.js';
import type { SecretStore } from '../security/secretStore.js';
import type { Runner } from '../util/exec.js';
import type { McpHub } from '../mcp/client.js';
import type { ServerConfig } from '../mcp/boundary/schemas.js';
import type { BrowserName, OrgEntry, Persona } from '../config/schemas.js';
import type { VerifiedIdentity } from '../sf/identity.js';

export type CheckStatus = 'green' | 'yellow' | 'red';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  summary: string;
  details?: string[];
  /** Exact next step for the operator (PowerShell-friendly). */
  fix?: string;
  durationMs?: number;
}

export interface DoctorOptions {
  /** One tiny real call per model role (costs tokens). */
  live: boolean;
  /** Skip every network / external-process probe. */
  offline: boolean;
  /** Also connect remote MCP servers that may open a browser OAuth consent. */
  includeOAuth: boolean;
  ci: boolean;
}

export interface DoctorDeps {
  run: Runner;
  fetch: typeof fetch;
  mcpHub: (servers: Record<string, ServerConfig>) => McpHub;
  /** Returns undefined when the browser launched, else the error text. */
  probeBrowser: (name: BrowserName) => Promise<string | undefined>;
  /** Live identity check for one org + persona (default: sf CLI session + Organization/userinfo). */
  verifyIdentity?: (org: OrgEntry, persona: Persona) => Promise<VerifiedIdentity>;
}

export interface DoctorContext {
  paths: ProjectPaths;
  env: Env;
  config: AllConfigResults;
  secrets: SecretStore;
  options: DoctorOptions;
  deps: DoctorDeps;
  logger: Logger;
}

export type Check = (ctx: DoctorContext) => Promise<CheckResult | CheckResult[]>;
