import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgEntry, Persona } from '../../config/schemas.js';
import { HardStopError, QAError } from '../../core/errors.js';
import { startFixtureServer, type FixtureServer } from '../../fixture/server.js';
import { loadSeed } from '../../fixture/store.js';
import { SecretStore } from '../../security/secretStore.js';
import type { ExecResult, Runner } from '../../util/exec.js';
import { REPO_ROOT } from '../../../tests/helpers/tempProject.js';
import { ensureStorageState, hostBelongsToOrg, myDomainOf } from './browserState.js';
import { FixtureSessionProvider } from './fixture.js';
import { jwtAudience, parseSfJson, SfCliSessionProvider } from './sfCli.js';
import type { SessionProvider } from './types.js';

const TOKEN = '00DdN00000uQ5dK!AQEAQFakeTokenValueForTests1234567890';
const persona: Persona = {
  id: 'system-admin',
  username: 'admin@qa.example',
  sfAlias: 'qa-prod',
  profile: 'System Administrator',
  permissionSets: [],
  use: ['default-execution'],
};
const liveOrg: OrgEntry = {
  orgId: '00DdN00000uQ5dKUAS',
  alias: 'qa-prod',
  profile: 'dedicated-qa-prod',
  instanceUrl: 'https://acme.my.salesforce.com',
  release: "Winter '27",
  runTagField: null,
  environment: 'LIVE',
};

const noKeyring = (env: Record<string, string> = {}): SecretStore =>
  new SecretStore(env, () => Promise.reject(new Error('no keyring in tests')));

const json = (status: number, result?: unknown, message?: string): ExecResult => ({
  code: status,
  stdout: JSON.stringify({ status, result, message }),
  stderr: '',
});

function fakeRunner(script: (args: readonly string[]) => ExecResult): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  const r = ((_cmd: string, args: readonly string[]) => {
    calls.push([...args]);
    return Promise.resolve(script(args));
  }) as Runner & { calls: string[][] };
  r.calls = calls;
  return r;
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyDir = mkdtempSync(join(tmpdir(), 'jwt key '));
const keyFile = join(keyDir, 'server.key');
writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
const jwtEnv = { SF_ECA_CLIENT_ID: '3MVGclientid', SF_JWT_KEY_PATH: keyFile };

type FakeFetch = typeof fetch & { assertions: Record<string, unknown>[] };

/** Fake Salesforce OAuth endpoint: verifies the RS256 assertion like Salesforce does. */
function fakeOAuth(opts: { status?: number; body?: unknown } = {}): FakeFetch {
  const assertions: Record<string, unknown>[] = [];
  const f = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/services/data')) {
      return Promise.resolve(new Response(JSON.stringify([{ version: '67.0' }, { version: '68.0' }])));
    }
    const params = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h = '', c = '', sig = ''] = (params.get('assertion') ?? '').split('.');
    const v = createVerify('RSA-SHA256');
    v.update(`${h}.${c}`);
    expect(v.verify(publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
    assertions.push(JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as Record<string, unknown>);
    const body = opts.body ?? {
      access_token: TOKEN,
      instance_url: 'https://acme.my.salesforce.com',
      id: `https://login.salesforce.com/id/${liveOrg.orgId}/005dN000001AbCdQAK`,
    };
    return Promise.resolve(new Response(JSON.stringify(body), { status: opts.status ?? 200 }));
  }) as FakeFetch;
  f.assertions = assertions;
  return f;
}

describe('parseSfJson / helpers', () => {
  it('skips update notices printed before the JSON', () => {
    expect(parseSfJson('Warning: update available\n{"status":0,"result":{"a":1}}')?.result).toEqual({ a: 1 });
    expect(parseSfJson('no json')).toBeUndefined();
  });
  it('JWT audience: sandbox → test.salesforce.com, production → login.salesforce.com', () => {
    expect(jwtAudience('https://acme.my.salesforce.com')).toBe('https://login.salesforce.com');
    expect(jwtAudience('https://acme--fullcopy.sandbox.my.salesforce.com')).toBe('https://test.salesforce.com');
  });
});

describe('SfCliSessionProvider — API session via JWT Bearer grant', () => {
  it('signs a valid assertion, registers token + key as secrets and caches within the TTL', async () => {
    const oauth = fakeOAuth();
    const secrets: string[] = [];
    let now = 1_700_000_000_000;
    const p = new SfCliSessionProvider({
      runner: fakeRunner(() => json(0)),
      secrets: noKeyring(jwtEnv),
      ttlMinutes: 60,
      fetch: oauth,
      onSecret: (v) => secrets.push(v),
      now: () => now,
    });
    const s = await p.session({ persona, org: liveOrg });
    expect(s).toMatchObject({ orgId: liveOrg.orgId, apiVersion: '68.0', source: 'jwt', username: persona.username });
    expect(oauth.assertions[0]).toEqual({
      iss: '3MVGclientid',
      sub: persona.username,
      aud: 'https://login.salesforce.com',
      exp: Math.floor(now / 1000) + 180,
    });
    expect(secrets).toContain(TOKEN);
    expect(secrets.some((x) => x.includes('PRIVATE KEY'))).toBe(true);
    await p.session({ persona, org: liveOrg });
    expect(oauth.assertions).toHaveLength(1);
    now += 61 * 60_000;
    await p.session({ persona, org: liveOrg });
    expect(oauth.assertions).toHaveLength(2);
  });

  it('without ECA config → AUTH issue with the setup fix', async () => {
    const p = new SfCliSessionProvider({ runner: fakeRunner(() => json(0)), secrets: noKeyring(), ttlMinutes: 60 });
    const err = await p.session({ persona, org: liveOrg }).catch((e: unknown) => e);
    expect((err as QAError).kind).toBe('AUTH');
    expect(JSON.stringify((err as QAError).detail)).toMatch(/salesforce-auth/);
  });

  it('a JWT key path that does not exist is reported, not silently ignored', async () => {
    const p = new SfCliSessionProvider({
      runner: fakeRunner(() => json(0)),
      secrets: noKeyring({ SF_ECA_CLIENT_ID: '3MVGclientid', SF_JWT_KEY_PATH: 'C:\\nope\\server.key' }),
      ttlMinutes: 60,
    });
    await expect(p.session({ persona, org: liveOrg })).rejects.toThrow(/does not exist/);
  });

  it('invalid_grant (user not pre-approved) → AUTH', async () => {
    const p = new SfCliSessionProvider({
      runner: fakeRunner(() => json(0)),
      secrets: noKeyring(jwtEnv),
      ttlMinutes: 60,
      fetch: fakeOAuth({ status: 400, body: { error: 'invalid_grant', error_description: 'user not approved' } }),
    });
    const err = await p.session({ persona, org: liveOrg }).catch((e: unknown) => e);
    expect((err as QAError).kind).toBe('AUTH');
    expect((err as QAError).message).toMatch(/invalid_grant/);
  });
});

describe('SfCliSessionProvider — sf CLI alias (frontdoor, MCP)', () => {
  it('sf org login jwt passes a key path with spaces as one argument (no shell)', async () => {
    const runner = fakeRunner(() => json(0, { orgId: liveOrg.orgId }));
    const p = new SfCliSessionProvider({ runner, secrets: noKeyring(jwtEnv), ttlMinutes: 60 });
    await p.jwtLogin({ persona, org: liveOrg });
    expect(runner.calls[0]).toEqual([
      'org',
      'login',
      'jwt',
      '--client-id',
      '3MVGclientid',
      '--jwt-key-file',
      keyFile,
      '--username',
      persona.username,
      '--alias',
      'qa-prod',
      '--instance-url',
      liveOrg.instanceUrl,
      '--json',
    ]);
  });

  it('frontdoor: expired alias → JWT re-login → URL, registered as a secret', async () => {
    const url = 'https://acme.my.salesforce.com/secur/frontdoor.jsp?otp=abc123456789&startURL=%2Flightning';
    let loggedIn = false;
    const runner = fakeRunner((args) => {
      if (args[1] === 'login') {
        loggedIn = true;
        return json(0, {});
      }
      return loggedIn ? json(0, { url, orgId: liveOrg.orgId }) : json(1, undefined, `expired sid=${TOKEN}`);
    });
    const secrets: string[] = [];
    const p = new SfCliSessionProvider({
      runner,
      secrets: noKeyring(jwtEnv),
      ttlMinutes: 60,
      onSecret: (v) => secrets.push(v),
    });
    expect(await p.frontdoorUrl({ persona, org: liveOrg }, '/lightning/o/Account/home')).toBe(url);
    expect(secrets).toContain(url);
    expect(runner.calls.map((c) => c[1])).toEqual(['open', 'login', 'open']);
  });

  it('sf missing → TOOL_UNAVAILABLE', async () => {
    const runner: Runner = () => Promise.resolve({ code: null, stdout: '', stderr: '', error: 'spawn sf ENOENT' });
    const p = new SfCliSessionProvider({ runner, secrets: noKeyring(), ttlMinutes: 60 });
    const err = await p.frontdoorUrl({ persona, org: liveOrg }).catch((e: unknown) => e);
    expect((err as QAError).kind).toBe('TOOL_UNAVAILABLE');
  });
});

describe('My Domain host check', () => {
  it('accepts Lightning hosts of the same My Domain only', () => {
    expect(myDomainOf('https://acme.my.salesforce.com')).toBe('acme');
    expect(hostBelongsToOrg('acme.lightning.force.com', 'https://acme.my.salesforce.com')).toBe(true);
    expect(hostBelongsToOrg('acme.my.salesforce.com', 'https://acme.my.salesforce.com')).toBe(true);
    expect(hostBelongsToOrg('evil.lightning.force.com', 'https://acme.my.salesforce.com')).toBe(false);
    expect(
      hostBelongsToOrg(
        'acme--fullcopy.sandbox.lightning.force.com',
        'https://acme--fullcopy.sandbox.my.salesforce.com',
      ),
    ).toBe(true);
    expect(hostBelongsToOrg('127.0.0.1', 'http://127.0.0.1:4545')).toBe(true);
  });
});

describe('browser storageState via frontdoor (offline fixture, real Chromium)', () => {
  let server: FixtureServer;
  let fixtureOrg: OrgEntry;
  const seed = loadSeed(join(REPO_ROOT, 'examples', 'fixture', 'seed.json'));

  beforeAll(async () => {
    server = await startFixtureServer({ fixtureDir: join(REPO_ROOT, 'examples', 'fixture'), port: 0 });
    fixtureOrg = {
      ...liveOrg,
      orgId: seed.organization.Id,
      alias: 'fixture',
      profile: 'offline-fixture',
      instanceUrl: server.url,
      environment: 'FIXTURE',
    };
  });
  afterAll(async () => {
    await server.close();
  });

  it('creates .auth/<org>/<persona>.json, then reuses it inside the TTL', async () => {
    const authDir = mkdtempSync(join(tmpdir(), 'auth dir '));
    const provider = new FixtureSessionProvider(seed);
    const opts = {
      provider,
      request: { persona, org: fixtureOrg },
      authDir,
      ttlMinutes: 60,
      browser: 'chromium' as const,
    };
    const first = await ensureStorageState(opts);
    expect(first.reused).toBe(false);
    expect(first.path).toBe(join(authDir, 'fixture', 'system-admin.json'));
    const state = JSON.parse(readFileSync(first.path, 'utf8')) as { cookies: { name: string }[] };
    expect(state.cookies.map((c) => c.name)).toContain('sid');
    const second = await ensureStorageState(opts);
    expect(second.reused).toBe(true);
  }, 60_000);

  it('a refused session is an AUTH issue (persona BLOCKED), never a password prompt', async () => {
    const authDir = mkdtempSync(join(tmpdir(), 'auth dir '));
    const provider = new FixtureSessionProvider({
      organization: seed.organization,
      users: [{ ...seed.users[0]!, token: 'wrong-token' }],
    });
    const err = await ensureStorageState({
      provider,
      request: { persona, org: fixtureOrg },
      authDir,
      ttlMinutes: 60,
      browser: 'chromium',
    }).catch((e: unknown) => e);
    expect((err as QAError).kind).toBe('AUTH');
  }, 60_000);

  it('landing on a foreign host is an IDENTITY_MISMATCH hard stop', async () => {
    const authDir = mkdtempSync(join(tmpdir(), 'auth dir '));
    const provider = new FixtureSessionProvider(seed);
    // localhost vs 127.0.0.1: same server, different host → must not be accepted as this org
    const foreign = { ...fixtureOrg, instanceUrl: server.url.replace('127.0.0.1', 'localhost') };
    const p: SessionProvider = {
      kind: provider.kind,
      session: (req) => provider.session(req),
      frontdoorUrl: () => provider.frontdoorUrl({ persona, org: fixtureOrg }),
    };
    const err = await ensureStorageState({
      provider: p,
      request: { persona, org: foreign },
      authDir,
      ttlMinutes: 60,
      browser: 'chromium',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HardStopError);
  }, 60_000);
});
