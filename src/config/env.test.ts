import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv, secretValues } from './env.js';
import { SecretStore, type KeyringBackend } from '../security/secretStore.js';

describe('loadEnv', () => {
  it('reads .env, ignores comments/empties/placeholders, process env wins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qa env '));
    await writeFile(
      join(root, '.env'),
      [
        'GOOGLE_API_KEY=file-key-123456',
        'SF_JWT_KEY_PATH=   # prefer Windows Credential Manager',
        'JIRA_BASE_URL=https://<your-site>.atlassian.net',
        'QA_BROWSER=chrome',
        'UNRELATED=1',
      ].join('\n'),
    );
    const env = await loadEnv(root, { QA_BROWSER: 'msedge' });
    expect(env.GOOGLE_API_KEY).toBe('file-key-123456');
    expect(env.SF_JWT_KEY_PATH).toBeUndefined();
    expect(env.QA_BROWSER).toBe('msedge');
    expect('UNRELATED' in env).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it('never echoes secret values in validation errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qa env '));
    await expect(loadEnv(root, { QA_BROWSER: 'super-secret-value' })).rejects.toThrow(/QA_BROWSER/);
    await expect(loadEnv(root, { QA_BROWSER: 'super-secret-value' })).rejects.not.toThrow(/super-secret-value/);
    await rm(root, { recursive: true, force: true });
  });

  it('secretValues lists only secret keys of useful length', () => {
    expect(secretValues({ GOOGLE_API_KEY: 'AIzaLongEnough', JIRA_EMAIL: 'a@b.c', JIRA_API_TOKEN: 'short' })).toEqual([
      'AIzaLongEnough',
    ]);
  });
});

describe('SecretStore', () => {
  const backend = (vals: Record<string, string>): KeyringBackend => ({
    get: (_s, account) => Promise.resolve(vals[account]),
  });

  it('prefers the OS keyring, falls back to env', async () => {
    const store = new SecretStore({ GOOGLE_API_KEY: 'from-env', JIRA_API_TOKEN: 'jira-env' }, () =>
      Promise.resolve(backend({ GOOGLE_API_KEY: 'from-keyring' })),
    );
    expect(await store.get('GOOGLE_API_KEY')).toEqual({ value: 'from-keyring', source: 'keyring' });
    expect(await store.get('JIRA_API_TOKEN')).toEqual({ value: 'jira-env', source: 'env' });
    expect(await store.get('OPENAI_API_KEY')).toEqual({ value: undefined, source: 'none' });
  });

  it('keeps working when the keyring backend cannot load', async () => {
    const store = new SecretStore({ GOOGLE_API_KEY: 'from-env' }, () => Promise.reject(new Error('no native module')));
    expect(await store.get('GOOGLE_API_KEY')).toEqual({ value: 'from-env', source: 'env' });
    expect(await store.keyringStatus()).toEqual({ available: false, error: 'no native module' });
  });

  it('real @napi-rs/keyring backend loads on this machine', async () => {
    const store = new SecretStore({});
    const status = await store.keyringStatus();
    expect(status.available).toBe(true);
  });
});

describe('loadEnv placeholders', () => {
  it('treats a value that still contains a <placeholder> as unset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qa env '));
    const env = await loadEnv(root, { JIRA_BASE_URL: 'https://<your-site>.atlassian.net', JIRA_EMAIL: 'a@b.example' });
    expect(env.JIRA_BASE_URL).toBeUndefined();
    expect(env.JIRA_EMAIL).toBe('a@b.example');
    await rm(root, { recursive: true, force: true });
  });
});
