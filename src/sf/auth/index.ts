import { join } from 'node:path';
import type { OrgEntry, Persona, PersonasConfig } from '../../config/schemas.js';
import { QAError } from '../../core/errors.js';
import { loadSeed } from '../../fixture/store.js';
import type { SecretStore } from '../../security/secretStore.js';
import type { Runner } from '../../util/exec.js';
import { FixtureSessionProvider } from './fixture.js';
import { SfCliSessionProvider } from './sfCli.js';
import type { SecretSink, SessionProvider } from './types.js';

export * from './types.js';
export { FixtureSessionProvider } from './fixture.js';
export { SfCliSessionProvider, parseSfJson } from './sfCli.js';
export { ensureStorageState, storageStatePaths, hostBelongsToOrg, myDomainOf } from './browserState.js';

export interface ProviderDeps {
  root: string;
  runner: Runner;
  secrets: SecretStore;
  personas: PersonasConfig;
  onSecret?: SecretSink;
}

/** FIXTURE orgs get fixture sessions; LIVE orgs get sf CLI sessions with JWT re-login (PLAN.md §7b). */
export function createSessionProvider(org: OrgEntry, deps: ProviderDeps): SessionProvider {
  if (org.environment === 'FIXTURE') {
    return new FixtureSessionProvider(loadSeed(join(deps.root, 'examples', 'fixture', 'seed.json')));
  }
  return new SfCliSessionProvider({
    runner: deps.runner,
    secrets: deps.secrets,
    ttlMinutes: deps.personas.sessionTtlMinutes,
    ...(deps.onSecret ? { onSecret: deps.onSecret } : {}),
  });
}

/**
 * Pick the persona (default from personas.yaml). The persona's sf alias may differ from the org alias (one alias per
 * test user); the identity check afterwards proves that the alias really belongs to this org and user.
 */
export function resolvePersona(personas: PersonasConfig, personaId?: string): Persona {
  const id = personaId ?? personas.defaultPersona;
  const persona = personas.personas.find((p) => p.id === id);
  if (!persona) {
    throw new QAError('AUTH', `persona ${id} is not in config/personas.yaml`, {
      fix: 'Add the persona (missingPersonaPolicy decides whether to ask)',
    });
  }
  return persona;
}
