import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { parseSoql, scalar, SoqlError } from './soql.js';
import {
  describeGlobalSf,
  describeSf,
  hasEntity,
  loadFixtureMetadata,
  queryMetadata,
  type FixtureMetadata,
  enforcedRules,
} from './metadata.js';
import { applyLayout, fixtureContactLayouts, loadFixtureLayout } from './layout.js';
import { FixtureError, FixtureStore, loadSeed, type SObject } from './store.js';
import {
  applyLabelRenames,
  applyRuleFaults,
  isReadOnly,
  isUnavailable,
  MAINTENANCE_PAGE,
  NO_FAULTS,
  pageFaultScript,
  type FixtureFaults,
} from './faults.js';

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
  /** Setup metadata for discovery (default `<fixtureDir>/metadata.json`). */
  metadataFile?: string;
  /** Page layout of the Contact Details panel / Contact form (Phase 6 seeded visual change); default: template order. */
  layoutFile?: string;
  /** Phase 7 fault injection (labels, delays, rules, 503, read-only objects) + product behaviour toggles. */
  faults?: FixtureFaults;
}

export interface FixtureServer {
  url: string;
  store: FixtureStore;
  /** Current setup metadata (discovery tests replace it to simulate an org change between snapshots). */
  metadata: FixtureMetadata;
  setMetadata(meta: FixtureMetadata): void;
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

/** `11/27/2026, 10:05 AM` (en_US, UTC) — how Lightning shows a datetime; changes per record, so visual tests mask it. */
export function salesforceDateTime(v: unknown): string {
  const d = typeof v === 'string' ? new Date(v) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const h = d.getUTCHours();
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${String(d.getUTCMonth() + 1)}/${String(d.getUTCDate())}/${String(d.getUTCFullYear())}, ${String(h % 12 || 12)}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
}

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
  send(res, err.status, [{ errorCode: err.errorCode, message: err.message, fields: err.fields }, ...err.more]);
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
  let metadata = loadFixtureMetadata(opts.metadataFile ?? join(fixtureDir, 'metadata.json'));
  const faults = opts.faults ?? NO_FAULTS;
  store.setValidationRules(applyRuleFaults(enforcedRules(metadata), faults));
  store.setBehaviour(faults.behaviour);
  const PAGE_SCRIPT = '<script src="/fixture/static/record-page.js"></script>';
  const withFaults = (html: string): string =>
    applyLabelRenames(html, faults.labelRenames).replace(PAGE_SCRIPT, `${pageFaultScript(faults)}\n    ${PAGE_SCRIPT}`);
  const template = withFaults(await readFile(join(fixtureDir, 'pages', 'account-record.html'), 'utf8'));
  const layout = opts.layoutFile ? loadFixtureLayout(opts.layoutFile) : undefined;
  const contactTemplate = withFaults(
    applyLayout(
      await readFile(join(fixtureDir, 'pages', 'contact-record.html'), 'utf8'),
      'details',
      layout?.contact.details,
    ),
  );
  // One Contact form for both dialogs (New Contact on the Account page, Edit on the Contact page), as in Lightning.
  const contactForm = applyLabelRenames(
    applyLayout(
      await readFile(join(fixtureDir, 'partials', 'contact-form.html'), 'utf8'),
      'form',
      layout?.contact.form,
    ),
    faults.labelRenames,
  );
  const leadSourceOptions = (
    store.describe('Contact').fields.find((f) => f.name === 'LeadSource')?.picklistValues ?? []
  )
    .map((v) => `<div role="option" data-value="${esc(v)}" aria-selected="false">${esc(v)}</div>`)
    .join('\n            ');
  const fill = (tpl: string, values: Record<string, string>): string =>
    tpl
      .replace('{{contactFormFields}}', contactForm)
      .replace(/\{\{([A-Za-z.]+)\}\}/g, (_m, k: string) => values[k] ?? '');
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
      'Account.BillingStreet': esc(account['BillingStreet']),
      'Account.BillingCity': esc(account['BillingCity']),
      'Account.BillingPostalCode': esc(account['BillingPostalCode']),
      'Account.BillingCountry': esc(account['BillingCountry']),
      'User.Name': esc(user['Name']),
      leadSourceOptions,
      ContactCount: String(contacts.length),
      ContactRows: rows,
      // Lightning-like generated ids change on every render: locators must never depend on them.
      rand: randomBytes(3).toString('hex'),
      writeDisabled: canWrite ? '' : 'disabled',
      newContactButton: canWrite ? '<button type="button" name="NewContact">New</button>' : '',
    };
    return fill(template, values);
  };

  const caseValues = (contact: SObject): Record<string, string> => {
    const cases = seed.objects.some((o) => o.name === 'Case') ? store.children('Case', 'ContactId', contact.Id) : [];
    return {
      CaseCount: String(cases.length),
      CaseRows: cases
        .map((c) => `<tr><th scope="row">${esc(c['Subject'])}</th><td>${esc(c['Status'])}</td></tr>`)
        .join('\n'),
    };
  };

  const renderContact = (contact: SObject, user: (typeof seed.users)[number]): string => {
    const accountId = typeof contact['AccountId'] === 'string' ? contact['AccountId'] : undefined;
    const account = accountId ? store.get('Account', accountId) : undefined;
    const values: Record<string, string> = {
      'Contact.Name': esc([contact['FirstName'], contact['LastName']].filter(Boolean).join(' ')),
      'Contact.Email': esc(contact['Email']),
      'Contact.Phone': esc(contact['Phone']),
      'Contact.Id': esc(contact.Id),
      'Contact.Title': esc(contact['Title']),
      'Contact.LeadSource': esc(contact['LeadSource']),
      'Contact.MailingAddress': esc(
        ['MailingStreet', 'MailingCity', 'MailingPostalCode', 'MailingCountry']
          .map((f) => contact[f])
          .filter((v) => typeof v === 'string' && v)
          .join(', '),
      ),
      leadSourceOptions,
      'Account.Id': esc(account?.Id),
      'Account.Name': esc(account?.['Name']),
      'User.Name': esc(user['Name']),
      'User.Id': esc(user['Id']),
      'Contact.CreatedDate': esc(salesforceDateTime(contact['CreatedDate'])),
      ...caseValues(contact),
      rand: randomBytes(3).toString('hex'),
      writeDisabled: user['canWrite'] === true ? '' : 'disabled',
    };
    return fill(contactTemplate, values);
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

    if (isUnavailable(path, faults)) {
      if (path.startsWith('/lightning/'))
        send(res, 503, MAINTENANCE_PAGE, { 'content-type': 'text/html; charset=utf-8' });
      else send(res, 503, [{ errorCode: 'SERVER_UNAVAILABLE', message: '503 Service Unavailable (maintenance)' }]);
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
    const contactPage = /^\/lightning\/r\/Contact\/([A-Za-z0-9]{15,18})\/view$/.exec(path);
    if (contactPage?.[1] && method === 'GET') {
      send(res, 200, renderContact(store.get('Contact', contactPage[1]), user), {
        'content-type': 'text/html; charset=utf-8',
      });
      return;
    }
    if (path === '/lightning/page/home' || /^\/lightning\/o\/(Contact|Account)\/(home|list)$/.test(path)) {
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

    if (api === '/tooling/query' || api === '/tooling/query/') {
      const q = url.searchParams.get('q');
      if (!q) throw new SoqlError('missing q');
      const parsed = parseSoql(q);
      if (!hasEntity(metadata, parsed.object)) {
        throw new FixtureError(400, 'INVALID_TYPE', `sObject type '${parsed.object}' is not supported.`);
      }
      const r = queryMetadata(metadata, parsed);
      send(res, 200, { totalSize: r.totalSize, done: true, records: r.records });
      return;
    }
    if (api === '/sobjects' || api === '/sobjects/') {
      send(res, 200, describeGlobalSf(store, metadata));
      return;
    }

    if (api === '/query' || api === '/query/') {
      const q = url.searchParams.get('q');
      if (!q) throw new SoqlError('missing q');
      const parsed = parseSoql(q);
      const r = hasEntity(metadata, parsed.object) ? queryMetadata(metadata, parsed) : store.query(parsed);
      send(res, 200, { totalSize: r.totalSize, done: true, records: r.records });
      return;
    }

    if (api === '/sobjects/Contact/describe/layouts' && method === 'GET') {
      send(res, 200, fixtureContactLayouts(contactForm, layout?.contact.formTabOrder));
      return;
    }
    const m = /^\/sobjects\/([A-Za-z_]+)(?:\/([A-Za-z0-9]{15,18}|describe))?\/?$/.exec(api);
    if (!m?.[1]) {
      send(res, 404, [{ errorCode: 'NOT_FOUND', message: 'The requested resource does not exist' }]);
      return;
    }
    const [, object, idOrDescribe] = m;
    const writes = method !== 'GET';
    if (writes && (user['canWrite'] !== true || isReadOnly(object, faults))) {
      throw new FixtureError(403, 'INSUFFICIENT_ACCESS_OR_READONLY', 'insufficient access rights on object id');
    }
    if (idOrDescribe === 'describe') {
      const d = describeSf(store, metadata, store.describe(object));
      send(
        res,
        200,
        isReadOnly(object, faults) ? { ...d, createable: false, updateable: false, deletable: false } : d,
      );
      return;
    }
    if (!idOrDescribe) {
      if (method !== 'POST') {
        send(res, 405, [{ errorCode: 'METHOD_NOT_ALLOWED', message: method }]);
        return;
      }
      const rec = store.create(object, await readJson(req), user.Id);
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
    get metadata() {
      return metadata;
    },
    setMetadata(meta: FixtureMetadata) {
      metadata = meta;
      store.setValidationRules(applyRuleFaults(enforcedRules(meta), faults));
    },
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => {
          ok();
        });
      }),
  };
}
