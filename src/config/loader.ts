import { readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import {
  ExecutionConfig,
  McpToolsConfig,
  ModelsConfig,
  ObservabilityConfig,
  OrgsConfig,
  PersonasConfig,
  PolicyConfig,
} from './schemas.js';

export const CONFIG_SCHEMAS = {
  models: ModelsConfig,
  policy: PolicyConfig,
  personas: PersonasConfig,
  orgs: OrgsConfig,
  execution: ExecutionConfig,
  'mcp-tools': McpToolsConfig,
  observability: ObservabilityConfig,
} as const;
export type ConfigName = keyof typeof CONFIG_SCHEMAS;
export type ConfigOf<K extends ConfigName> = z.infer<(typeof CONFIG_SCHEMAS)[K]>;
export const CONFIG_NAMES = Object.keys(CONFIG_SCHEMAS) as ConfigName[];

/** Files tracked in git (no *.example.yaml copy step needed). */
const TRACKED = new Set<ConfigName>(['policy', 'mcp-tools']);

export interface ProjectPaths {
  root: string;
  configDir: string;
}

export function projectPaths(root: string = process.cwd()): ProjectPaths {
  const abs = resolve(root);
  return { root: abs, configDir: join(abs, 'config') };
}

export type LoadResult<T> =
  | { ok: true; value: T; file: string; unconfigured: string[] }
  | { ok: false; file: string; reason: 'missing' | 'parse' | 'invalid'; errors: string[]; fix: string };

const PLACEHOLDER = /<[^<>]+>/;

/** Paths (dot notation) whose string value still contains a `<placeholder>`. */
export function findPlaceholders(value: unknown, path = ''): string[] {
  if (typeof value === 'string') return PLACEHOLDER.test(value) ? [path || '(root)'] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => findPlaceholders(v, `${path}[${i}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => findPlaceholders(v, path ? `${path}.${k}` : k));
  }
  return [];
}

function formatZodIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.map((i) => `${i.path.length ? i.path.map(String).join('.') : '(root)'}: ${i.message}`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function loadConfigFile<K extends ConfigName>(
  name: K,
  paths: ProjectPaths = projectPaths(),
): Promise<LoadResult<ConfigOf<K>>> {
  const file = join(paths.configDir, `${name}.yaml`);
  if (!(await exists(file))) {
    const example = join(paths.configDir, `${name}.example.yaml`);
    const fix = TRACKED.has(name)
      ? `restore ${name}.yaml from git (git checkout -- config/${name}.yaml)`
      : (await exists(example))
        ? `Copy-Item "${example}" "${file}"  then fill it in`
        : `create ${file}`;
    return { ok: false, file, reason: 'missing', errors: [`${file} not found`], fix };
  }
  let raw: unknown;
  try {
    raw = parseYaml(await readFile(file, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      file,
      reason: 'parse',
      errors: [err instanceof Error ? err.message : String(err)],
      fix: `fix the YAML syntax in ${file}`,
    };
  }
  const schema = CONFIG_SCHEMAS[name];
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      file,
      reason: 'invalid',
      errors: formatZodIssues(parsed.error.issues),
      fix: `correct the listed fields in ${file}`,
    };
  }
  return { ok: true, value: parsed.data as ConfigOf<K>, file, unconfigured: findPlaceholders(raw) };
}

export type AllConfigResults = { [K in ConfigName]: LoadResult<ConfigOf<K>> };

export async function loadAllConfig(paths: ProjectPaths = projectPaths()): Promise<AllConfigResults> {
  const entries = await Promise.all(CONFIG_NAMES.map(async (n) => [n, await loadConfigFile(n, paths)] as const));
  return Object.fromEntries(entries) as AllConfigResults;
}

export class ConfigError extends Error {
  constructor(
    readonly file: string,
    readonly errors: string[],
    readonly fix: string,
  ) {
    super(`Invalid config ${file}: ${errors.join('; ')} — fix: ${fix}`);
    this.name = 'ConfigError';
  }
}

/** Load a config file for runtime use; throws ConfigError with a readable message. */
export async function requireConfig<K extends ConfigName>(name: K, paths?: ProjectPaths): Promise<ConfigOf<K>> {
  const r = await loadConfigFile(name, paths);
  if (!r.ok) throw new ConfigError(r.file, r.errors, r.fix);
  return r.value;
}
