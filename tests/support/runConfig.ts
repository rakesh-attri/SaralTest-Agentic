// Run settings shared by playwright.config.ts and the Playwright fixtures. Synchronous on purpose: the Playwright
// config is evaluated synchronously. Values come from config/*.yaml (falling back to the *.example.yaml files, so
// `playwright test --list` works on a fresh checkout) and from env set by the Runner (QA_RUN_DIR, QA_ORG, ...).
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { ExecutionConfig, OrgsConfig, PersonasConfig } from '../../src/config/schemas.js';

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

function readYaml(name: string): unknown {
  const local = join(REPO_ROOT, 'config', `${name}.yaml`);
  const example = join(REPO_ROOT, 'config', `${name}.example.yaml`);
  const file = existsSync(local) ? local : example;
  return parse(readFileSync(file, 'utf8')) as unknown;
}

export interface RunSettings {
  root: string;
  /** Org alias from config/orgs.yaml (QA_ORG; default: the first LIVE org that is not a placeholder, else fixture). */
  orgAlias: string;
  runId: string;
  runDir: string;
  storyKey: string;
  execution: ExecutionConfig;
  personas: PersonasConfig;
  orgs: OrgsConfig;
  /** Playwright `channel` for chrome / msedge; undefined = bundled Chromium. */
  channel: string | undefined;
  baseURL: string | undefined;
}

export function storageStatePath(orgAlias: string, personaId: string): string {
  return join(REPO_ROOT, '.auth', orgAlias, `${personaId}.json`);
}

export function runSettings(env: NodeJS.ProcessEnv = process.env): RunSettings {
  const execution = ExecutionConfig.parse(readYaml('execution'));
  const personas = PersonasConfig.parse(readYaml('personas'));
  const orgs = OrgsConfig.parse(readYaml('orgs'));
  const orgAlias = env['QA_ORG'] ?? orgs.orgs.find((o) => o.alias === 'qa-prod')?.alias ?? 'fixture';
  const runId = env['QA_RUN_ID'] ?? 'local';
  const browser = env['QA_BROWSER'] ?? execution.browser;
  return {
    root: REPO_ROOT,
    orgAlias,
    runId,
    runDir: env['QA_RUN_DIR'] ?? join(REPO_ROOT, 'runs', runId),
    storyKey: env['QA_STORY_KEY'] ?? 'ad-hoc',
    execution,
    personas,
    orgs,
    channel: browser === 'chromium' ? undefined : browser,
    baseURL: env['SF_BASE_URL'],
  };
}
