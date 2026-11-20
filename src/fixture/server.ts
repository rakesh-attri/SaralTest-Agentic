import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { parseSoql, scalar, SoqlError } from './soql.js';
import { FixtureError, FixtureStore, loadSeed, type SObject } from './store.js';

/**
 * Offline Salesforce fixture (PLAN.md §11 Phase 0, CLAUDE.md rule 13). Mock REST/SOQL + static Lightning-like pages.
 * Every response carries `X-QA-Environment: FIXTURE`; results obtained here are never real Salesforce evidence.
 */
export const FIXTURE_API_VERSION = 'v62.0';
export const ENV_HEADER = 'x-qa-environment';

export interface FixtureServerOptions {
  /** examples/fixture folder. */
  fixtureDir: string;
  port?: number;
  host?: string;
}

export interface FixtureServer {
  url: string;
  store: FixtureStore;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

const esc = (s: unknown): string =>
  scalar(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const isText = typeof body === 'string';
  res.writeHead(status, {
    [ENV_HEADER]: 'FIXTURE',
    'content-type': isText
      ? (headers['content-type'] ?? 'text/plain; charset=utf-8')
      : 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(isText ? body : JSON.stringify(body));
}

function sfError(res: ServerResponse, err: FixtureError | SoqlError): void {
  if (err instanceof SoqlError) {
    send(res, 400, [{ errorCode: err.errorCode, message: err.message }]);
    return;
  }
  send(res, err.status, [{ errorCode: err.errorCode, message: err.message, fields: err.fields }]);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FixtureError(400, 'JSON_PARSER_ERROR', 'body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export async function startFixtureServer(opts: FixtureServerOptions): Promise<FixtureServer> {
  const fixtureDir = resolve(opts.fixtureDir);
  const seed = loadSeed(join(fixtureDir, 'seed.json'));
  const store = new FixtureStore(seed);
  const template = await readFile(join(fixtureDir, 'pages', 'account-record.html'), 'utf8');
  const staticDir = join(fixtureDir, 'static');

  const userFor = (req: IncomingMessage): (typeof seed.users)[number] | undefined => {
    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : cookie(req, 'sid');
    return seed.users.find((u) => u.token === token);
  };

  const renderAccount = (account: SObject, user: (typeof seed.users)[number]): string => {
    const contacts = store.children('Contact', 'AccountId', account.Id);
    const rows = contacts
      .map(
        (c) =>
          `<tr><th scope="row"><a href="/lightning/r/Contact/${esc(c.Id)}/view">${esc(
            [c['FirstName'], c['LastName']].filter(Boolean).join(' '),
          )}</a></th><td>${esc(c['Email'])}</td></tr>`,
      )
      .join('\n');
    const canWrite = user['canWrite'] === true;
    const values: Record<string, string> = {
      'Account.Id': esc(account.Id),
      'Account.Name': esc(account['Name']),
      'Account.Industry': esc(account['Industry']),
      'Account.BillingCountry': esc(account['BillingCountry']),
      'User.Name': esc(user['Name']),
      ContactCount: String(contacts.length),
      ContactRows: rows,
      // Lightning-like generated ids change on every render: locators must never depend on them.
      rand: randomBytes(3).toString('hex'),
      writeDisabled: canWrite ? '' : 'disabled',
      newContactButton: canWrite ? '<button type="button" name="NewContact">New</button>' : '',
    };
    return template.replace(/\{\{([A-Za-z.]+)\}\}/g, (_m, k: string) => values[k] ?? '');
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://fixture.local');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/health') {
      send(res, 200, { ok: true, environment: 'FIXTURE' });
      return;
    }

    // Static assets (no auth), traversal-safe.
    if (path.startsWith('/fixture/static/')) {
      const file = resolve(staticDir, path.slice('/fixture/static/'.length));
      if (!file.startsWith(staticDir + sep)) {
        send(res, 404, 'not found');
        return;
      }
      try {
        send(res, 200, await readFile(file, 'utf8'), { 'content-type': MIME[extname(file)] ?? 'text/plain' });
        return;
      } catch {
        send(res, 404, 'not found');
        return;
      }
    }

    // frontdoor.jsp?sid=<token> → session cookie, like Salesforce frontdoor (salesforce-auth-personas skill).
    if (path === '/secur/frontdoor.jsp') {
      const sid = url.searchParams.get('sid') ?? '';
      const user = seed.users.find((u) => u.token === sid);
      if (!user) {
        send(res, 401, 'invalid session');
        return;
      }
      const target = url.searchParams.get('retURL') ?? '/lightning/page/home';
      res.writeHead(302, {
        [ENV_HEADER]: 'FIXTURE',
        'set-cookie': `sid=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax`,
        location: target.startsWith('/') ? target : '/lightning/page/home',
      });
      res.end();
      return;
    }

    const user = userFor(req);
    if (!user) {
      if (path.startsWith('/lightning/')) {
        send(res, 401, 'Login required (fixture): use /secur/frontdoor.jsp?sid=…');
        return;
      }
      send(res, 401, [{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired or invalid' }]);
      return;
    }

    if (path === '/services/oauth2/userinfo') {
      send(res, 200, {
        user_id: user.Id,
        organization_id: seed.organization.Id,
        preferred_username: user.Username,
        name: user['Name'],
        environment: 'FIXTURE',
      });
      return;
    }
    if (path === '/services/data' || path === '/services/data/') {
      send(res, 200, [{ version: FIXTURE_API_VERSION.slice(1), url: `/services/data/${FIXTURE_API_VERSION}` }]);
      return;
    }

    const page = /^\/lightning\/r\/Account\/([A-Za-z0-9]{15,18})\/view$/.exec(path);
    if (page?.[1] && method === 'GET') {
      send(res, 200, renderAccount(store.get('Account', page[1]), user), {
        'content-type': 'text/html; charset=utf-8',
      });
      return;
    }
    if (path === '/lightning/page/home') {
      send(res, 200, '<!doctype html><title>Home | Salesforce (OFFLINE FIXTURE)</title><h1>Home</h1>', {
        'content-type': 'text/html; charset=utf-8',
      });
      return;
    }

    const api = new RegExp(`^/services/data/${FIXTURE_API_VERSION.replace('.', '\\.')}(/.*)$`).exec(path)?.[1];
    if (!api) {
      send(res, 404, [{ errorCode: 'NOT_FOUND', message: 'The requested resource does not exist' }]);
      return;
    }

    if (api === '/query' || api === '/query/') {
      const q = url.searchParams.get('q');
      if (!q) throw new SoqlError('missing q');
      const r = store.query(parseSoql(q));
      send(res, 200, { totalSize: r.totalSize, done: true, records: r.records });
      return;
    }

    const m = /^\/sobjects\/([A-Za-z_]+)(?:\/([A-Za-z0-9]{15,18}|describe))?\/?$/.exec(api);
    if (!m?.[1]) {
      send(res, 404, [{ errorCode: 'NOT_FOUND', message: 'The requested resource does not exist' }]);
      return;
    }
    const [, object, idOrDescribe] = m;
    const writes = method !== 'GET';
    if (writes && user['canWrite'] !== true) {
      throw new FixtureError(403, 'INSUFFICIENT_ACCESS_OR_READONLY', 'insufficient access rights on object id');
    }
    if (idOrDescribe === 'describe') {
      send(res, 200, store.describe(object));
      return;
    }
    if (!idOrDescribe) {
      if (method !== 'POST') {
        send(res, 405, [{ errorCode: 'METHOD_NOT_ALLOWED', message: method }]);
        return;
      }
      const rec = store.create(object, await readJson(req));
      send(res, 201, { id: rec.Id, success: true, errors: [] });
      return;
    }
    switch (method) {
      case 'GET': {
        send(res, 200, {
          attributes: { type: store.describe(object).name },
          ...store.get(object, idOrDescribe),
        });
        return;
      }
      case 'PATCH':
        store.update(object, idOrDescribe, await readJson(req));
        res.writeHead(204, { [ENV_HEADER]: 'FIXTURE' });
        res.end();
        return;
      case 'DELETE':
        store.delete(object, idOrDescribe);
        res.writeHead(204, { [ENV_HEADER]: 'FIXTURE' });
        res.end();
        return;
      default: {
        send(res, 405, [{ errorCode: 'METHOD_NOT_ALLOWED', message: method }]);
        return;
      }
    }
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (err instanceof FixtureError || err instanceof SoqlError) {
        sfError(res, err);
        return;
      }
      if (err instanceof SyntaxError) {
        send(res, 400, [{ errorCode: 'JSON_PARSER_ERROR', message: err.message }]);
        return;
      }
      send(res, 500, [{ errorCode: 'UNKNOWN_EXCEPTION', message: err instanceof Error ? err.message : String(err) }]);
    });
  });

  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port ?? 4545, opts.host ?? '127.0.0.1', () => {
      ok();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${opts.host ?? '127.0.0.1'}:${port}`,
    store,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => {
          ok();
        });
      }),
  };
}
