// Model router + skills for agent commands outside the main graph (qa investigate / heal / defects / explore).
// Same construction as createRuntime (src/cli/analyze.ts): secrets from Credential Manager or .env, redacted logger.
import { loadEnv, secretValues } from '../config/env.js';
import { loadConfigFile, projectPaths } from '../config/loader.js';
import { createLogger, type Logger } from '../core/logger.js';
import { ModelRouter } from '../models/router.js';
import { Redactor } from '../security/redact.js';
import { SecretStore } from '../security/secretStore.js';
import { SkillLoader } from '../skills/skillLoader.js';

export interface ModelDeps {
  router?: ModelRouter;
  skills: SkillLoader;
  redactor: Redactor;
  logger: Logger;
}

export async function createModelDeps(o: {
  root: string;
  say: (m: string) => void;
  noModel?: boolean;
  logFile?: string;
  roles?: readonly ('reasoning' | 'coder' | 'fast' | 'judge')[];
}): Promise<ModelDeps> {
  const env = await loadEnv(o.root);
  const store = new SecretStore(env);
  const secrets = secretValues(env);
  const redactor = new Redactor({ secrets });
  const logger = createLogger({
    level: 'warn',
    redact: (obj) => redactor.redactValue(obj),
    ...(o.logFile ? { file: o.logFile } : {}),
  });
  const skills = SkillLoader.forProject(o.root);
  if (o.noModel) return { skills, redactor, logger };
  const models = await loadConfigFile('models', projectPaths(o.root));
  if (!models.ok) {
    o.say(
      `config/models.yaml unusable (${models.errors.join('; ')}) — continuing without a model (deterministic only).`,
    );
    return { skills, redactor, logger };
  }
  const router = await ModelRouter.create({
    config: models.value,
    secrets: { get: async (k) => (await store.get(k)).value, setting: (k) => env[k] },
    secretValues: () => secrets,
    logger,
  });
  for (const role of o.roles ?? []) {
    const r = router.status().find((s) => s.role === role);
    o.say(
      `Models: ${role} = ${r?.provider ?? '?'}/${r?.model ?? '?'}${r?.ok ? '' : ` — NOT USABLE: ${r?.error ?? ''}`}`,
    );
  }
  return { router, skills, redactor, logger };
}
