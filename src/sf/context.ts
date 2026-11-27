import { join } from 'node:path';
import { loadEnv, secretValues, type Env } from '../config/env.js';
import { loadConfigFile, projectPaths, requireConfig } from '../config/loader.js';
import { ExecutionConfig } from '../config/schemas.js';
import type { McpToolsConfig, OrgEntry, OrgsConfig, Persona, PersonasConfig, PolicyConfig } from '../config/schemas.js';
import { QAError } from '../core/errors.js';
import { createLogger, type Logger } from '../core/logger.js';
import { ensureRunFolder, type RunPaths } from '../core/runFolder.js';
import { AuditLog } from '../security/audit.js';
import { Redactor } from '../security/redact.js';
import { SecretStore } from '../security/secretStore.js';
import { run as defaultRunner, type Runner } from '../util/exec.js';
import { createSessionProvider, resolvePersona } from './auth/index.js';
import type { SessionProvider } from './auth/types.js';
import { connectSalesforce, IdentityRegistry, type GuardedSalesforce } from './client.js';
import { verifiedOrgFacts } from './identity.js';

export interface SfContextOptions {
  root: string;
  runId: string;
  /** orgs.yaml alias; default QA_DEFAULT_ORG. */
  orgAlias?: string;
  personaId?: string;
  runner?: Runner;
  logLevel?: 'error' | 'warn' | 'info' | 'debug';
}

/** Everything a Salesforce-facing command needs, loaded once (config, secrets, redaction, audit, session provider). */
export interface SfContext {
  root: string;
  env: Env;
  orgs: OrgsConfig;
  org: OrgEntry;
  personas: PersonasConfig;
  persona: Persona;
  policy: PolicyConfig;
  execution: ExecutionConfig;
  mcpTools: McpToolsConfig;
  secrets: SecretStore;
  redactor: Redactor;
  logger: Logger;
  run: RunPaths;
  audit: AuditLog;
  registry: IdentityRegistry;
  provider: SessionProvider;
  authDir: string;
  /** session → identity check (HARD_STOP on mismatch) → guarded client. */
  connect(): Promise<GuardedSalesforce>;
}

export async function createSfContext(o: SfContextOptions): Promise<SfContext> {
  const paths = projectPaths(o.root);
  const env = await loadEnv(o.root);
  const orgs = await requireConfig('orgs', paths);
  const personas = await requireConfig('personas', paths);
  const policy = await requireConfig('policy', paths);
  const executionFile = await loadConfigFile('execution', paths);
  const execution: ExecutionConfig = executionFile.ok
    ? executionFile.value
    : ExecutionConfig.parse({
        browser: 'chromium',
        headless: true,
        viewports: [{ name: 'desktop', width: 1440, height: 900 }],
        visual: { maxDiffPixelRatio: 0.01, mask: [], allowExternalUpload: false },
      });
  const mcpToolsFile = await loadConfigFile('mcp-tools', paths);
  const mcpTools: McpToolsConfig = mcpToolsFile.ok ? mcpToolsFile.value : {};

  const alias = o.orgAlias ?? env.QA_DEFAULT_ORG;
  if (!alias) throw new QAError('ENVIRONMENT', 'no org given: pass --org <alias> or set QA_DEFAULT_ORG');
  const org = orgs.orgs.find((x) => x.alias === alias);
  if (!org) {
    throw new QAError('ENVIRONMENT', `org alias "${alias}" is not in config/orgs.yaml`, {
      known: orgs.orgs.map((x) => x.alias),
    });
  }
  if (/<[^<>]+>/.test(org.instanceUrl) || /^00D0{12}/.test(org.orgId)) {
    throw new QAError('ENVIRONMENT', `org "${alias}" still has placeholder values in config/orgs.yaml`, {
      fix: 'Set the real 18-char Org ID and My Domain URL for this org (docs/setup/salesforce-auth.md)',
    });
  }
  const persona = resolvePersona(personas, o.personaId);
  const secrets = new SecretStore(env);
  const redactor = new Redactor({ secrets: secretValues(env), piiEnabled: policy.security.redactPii });
  const logger = createLogger({ level: o.logLevel ?? 'warn', redact: (obj) => redactor.redactValue(obj) });
  const run = await ensureRunFolder(o.root, o.runId);
  const audit = new AuditLog(run.auditLog, redactor);
  const registry = new IdentityRegistry();
  const provider = createSessionProvider(org, {
    root: o.root,
    runner: o.runner ?? defaultRunner,
    secrets,
    personas,
    onSecret: (v) => {
      redactor.addSecret(v);
    },
  });
  return {
    root: o.root,
    env,
    orgs,
    org,
    personas,
    persona,
    policy,
    execution,
    mcpTools,
    secrets,
    redactor,
    logger,
    run,
    audit,
    registry,
    provider,
    authDir: join(o.root, '.auth'),
    connect: async () => {
      // A persona that cannot read Organization needs the org facts of a full check in this process: verify the
      // default persona first when none exists yet (operator decision 2026-11-26).
      if (persona.id !== personas.defaultPersona && !verifiedOrgFacts(org.orgId) && org.environment === 'LIVE') {
        const admin = resolvePersona(personas, personas.defaultPersona);
        await connectSalesforce({ provider, org, orgs, persona: admin, runId: o.runId, registry, audit });
      }
      return connectSalesforce({ provider, org, orgs, persona, runId: o.runId, registry, audit });
    },
  };
}
