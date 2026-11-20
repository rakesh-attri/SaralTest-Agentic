import type { Env } from '../config/env.js';
import type {
  ChangedComponent,
  DefectRecord,
  ExploratoryObjective,
  ManualTestCase,
  SourceDocument,
} from '../core/schemas/index.js';
import type { Logger } from '../core/logger.js';
import type { CallContext, McpHub } from '../mcp/client.js';
import type { Runner } from '../util/exec.js';

/** Everything an adapter may use. Adapters are deterministic: they never call a language model. */
export interface AdapterContext {
  /** Project root; relative file paths resolve against `cwd` first, then this. */
  root: string;
  cwd?: string;
  env: Env;
  logger?: Logger;
  /** MCP hub (allow-listed tools only). Absent → adapters go straight to their REST / local fallback. */
  mcp?: Pick<McpHub, 'callTool'>;
  /** Who is acting, for MCP audit entries. */
  callCtx?: CallContext;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Injected for tests; defaults to util/exec `run`. */
  exec?: Runner;
  now?: () => Date;
}

/** What one input produced. Several inputs are merged by the intake node. */
export interface AdapterOutput {
  documents: SourceDocument[];
  tests: ManualTestCase[];
  defects: DefectRecord[];
  changes: ChangedComponent[];
  objectives: ExploratoryObjective[];
  /** Which path produced it, e.g. `jira:mcp`, `jira:rest`, `pdf`. Shown in the report. */
  via: string;
  /** Human-readable notes (fallbacks taken, rows skipped …). */
  notes: string[];
}

export const emptyOutput = (via: string): AdapterOutput => ({
  documents: [],
  tests: [],
  defects: [],
  changes: [],
  objectives: [],
  via,
  notes: [],
});
