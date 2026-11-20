import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { z } from 'zod';

/** Known environment keys. All optional: doctor reports which ones are missing for which feature. */
export const EnvSchema = z.object({
  QA_DEFAULT_ORG: z.string().optional(),
  QA_BROWSER: z.enum(['chromium', 'chrome', 'msedge']).optional(),
  QA_AUTONOMY: z.enum(['L1', 'L2', 'L3']).optional(),
  QA_INTEGRATION: z.string().optional(),
  SF_ECA_CLIENT_ID: z.string().optional(),
  SF_JWT_KEY_PATH: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  AZURE_OPENAI_API_KEY: z.string().optional(),
  AZURE_OPENAI_ENDPOINT: z.string().optional(),
  AZURE_OPENAI_API_VERSION: z.string().optional(),
  OLLAMA_BASE_URL: z.string().optional(),
  JIRA_BASE_URL: z.string().optional(),
  JIRA_EMAIL: z.string().optional(),
  JIRA_API_TOKEN: z.string().optional(),
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_BASE_URL: z.string().optional(),
  PHOENIX_COLLECTOR_ENDPOINT: z.string().optional(),
});
export type Env = z.infer<typeof EnvSchema>;
export type EnvKey = keyof Env;

/** Keys whose values are secrets: never logged, never in prompts, always masked (rule 10). */
export const SECRET_ENV_KEYS: readonly EnvKey[] = [
  'GOOGLE_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'JIRA_API_TOKEN',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_PUBLIC_KEY',
  'SF_ECA_CLIENT_ID',
];

/** Treat empty strings and values still holding a template `<...>` placeholder as unset. */
function clean(record: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    const t = v?.trim();
    if (t && !/<[^<>]+>/.test(t)) out[k] = t;
  }
  return out;
}

/**
 * Load `.env` from the project root without mutating `process.env`. Real process env vars win over the file
 * (CI sets secrets as env vars).
 */
export async function loadEnv(root: string, processEnv: NodeJS.ProcessEnv = process.env): Promise<Env> {
  let fileVars: Record<string, string> = {};
  try {
    fileVars = parseDotenv(await readFile(join(root, '.env'), 'utf8'));
  } catch {
    // no .env file is fine — values may come from the process env or the secret store
  }
  const merged = { ...clean(fileVars), ...clean(processEnv) };
  const known = Object.fromEntries(Object.entries(merged).filter(([k]) => k in EnvSchema.shape));
  const parsed = EnvSchema.safeParse(known);
  if (parsed.success) return parsed.data;
  // Never echo values; report only the key names that failed.
  const bad = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
  throw new Error(`Invalid environment values for: ${bad}`);
}

/** All secret values currently known, for masking and the prompt secret guard. */
export function secretValues(env: Env, extra: readonly string[] = []): string[] {
  const vals = SECRET_ENV_KEYS.map((k) => env[k]).filter((v): v is string => typeof v === 'string' && v.length >= 8);
  return [...new Set([...vals, ...extra.filter((v) => v.length >= 8)])];
}
