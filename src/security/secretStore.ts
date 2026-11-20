import type { Env, EnvKey } from '../config/env.js';

/** Service name used for Windows Credential Manager entries (same layout keytar used). */
export const KEYRING_SERVICE = 'sf-qa-agent';

export type SecretSource = 'keyring' | 'env' | 'none';

export interface SecretLookup {
  value: string | undefined;
  source: SecretSource;
}

export interface KeyringBackend {
  /** Returns the stored password, or undefined when there is none. Throws if the backend is unavailable. */
  get(service: string, account: string): Promise<string | undefined>;
}

/** Real backend: @napi-rs/keyring (keytar-compatible Windows Credential Manager / macOS Keychain / libsecret). */
export async function napiKeyringBackend(): Promise<KeyringBackend> {
  const mod = await import('@napi-rs/keyring');
  return {
    get(service, account) {
      try {
        const entry = new mod.AsyncEntry(service, account);
        return entry.getPassword().then((v) => v ?? undefined);
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  };
}

/**
 * Secrets: Windows Credential Manager first, `.env`/process env as fallback (CLAUDE.md rule 10).
 * Values are never logged; only the *source* is reported.
 */
export class SecretStore {
  private backend: KeyringBackend | undefined;
  private backendError: string | undefined;

  constructor(
    private readonly env: Env,
    private readonly backendFactory: () => Promise<KeyringBackend> = napiKeyringBackend,
  ) {}

  private async getBackend(): Promise<KeyringBackend | undefined> {
    if (this.backend || this.backendError) return this.backend;
    try {
      this.backend = await this.backendFactory();
    } catch (err) {
      this.backendError = err instanceof Error ? err.message : String(err);
    }
    return this.backend;
  }

  /** Availability of the OS credential store (for `qa doctor`). */
  async keyringStatus(): Promise<{ available: boolean; error?: string }> {
    await this.getBackend();
    return this.backend ? { available: true } : { available: false, error: this.backendError ?? 'unknown' };
  }

  async get(key: EnvKey): Promise<SecretLookup> {
    const backend = await this.getBackend();
    if (backend) {
      try {
        const v = await backend.get(KEYRING_SERVICE, key);
        if (v) return { value: v, source: 'keyring' };
      } catch {
        // fall through to env — keyring lookups must never break a run
      }
    }
    const fromEnv = this.env[key];
    if (fromEnv) return { value: fromEnv, source: 'env' };
    return { value: undefined, source: 'none' };
  }
}
