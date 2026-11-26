// Safe parser for locator-registry expressions (chains of Playwright locator calls relative to `page`).
// Registry expressions are data, so they are parsed into a call list and applied — never evaluated as code.
import type { Locator, Page } from 'playwright';
import { QAError } from '../../core/errors.js';

export type ArgValue = string | number | boolean | RegExp | { [k: string]: ArgValue };
export interface LocatorCall {
  method:
    'getByRole' | 'getByLabel' | 'getByText' | 'getByTestId' | 'getByPlaceholder' | 'getByTitle' | 'locator' | 'filter';
  args: ArgValue[];
  /** filter({ has: <chain> }): the inner chain, applied relative to each candidate. */
  has?: LocatorCall[];
}

const METHODS = new Set<LocatorCall['method']>([
  'getByRole',
  'getByLabel',
  'getByText',
  'getByTestId',
  'getByPlaceholder',
  'getByTitle',
  'locator',
  'filter',
]);

class Cursor {
  i = 0;
  constructor(readonly s: string) {}
  ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i] ?? '')) this.i++;
  }
  peek(): string {
    this.ws();
    return this.s[this.i] ?? '';
  }
  eat(ch: string): void {
    this.ws();
    if (this.s[this.i] !== ch) throw this.err(`expected '${ch}'`);
    this.i++;
  }
  err(msg: string): QAError {
    return new QAError('LOCATOR', `unsupported locator expression at ${this.i}: ${msg} — ${this.s}`);
  }
}

function parseString(c: Cursor): string {
  const q = c.peek();
  if (q !== "'" && q !== '"') throw c.err('expected a string');
  c.i++;
  let out = '';
  while (c.i < c.s.length) {
    const ch = c.s[c.i++] ?? '';
    if (ch === '\\') {
      out += c.s[c.i++] ?? '';
      continue;
    }
    if (ch === q) return out;
    out += ch;
  }
  throw c.err('unterminated string');
}

function parseRegex(c: Cursor): RegExp {
  c.eat('/');
  let body = '';
  while (c.i < c.s.length && c.s[c.i] !== '/') {
    if (c.s[c.i] === '\\') body += c.s[c.i++] ?? '';
    body += c.s[c.i++] ?? '';
  }
  c.eat('/');
  let flags = '';
  while (/[gimsuy]/.test(c.s[c.i] ?? '')) flags += c.s[c.i++] ?? '';
  return new RegExp(body, flags);
}

function parseValue(c: Cursor): ArgValue {
  const ch = c.peek();
  if (ch === "'" || ch === '"') return parseString(c);
  if (ch === '/') return parseRegex(c);
  if (ch === '{') return parseObject(c);
  const m = /^(true|false|-?\d+(?:\.\d+)?)/.exec(c.s.slice(c.i));
  if (!m?.[1]) throw c.err('expected a value');
  c.i += m[1].length;
  return m[1] === 'true' ? true : m[1] === 'false' ? false : Number(m[1]);
}

function parseObject(c: Cursor): { [k: string]: ArgValue } {
  c.eat('{');
  const out: { [k: string]: ArgValue } = {};
  while (c.peek() !== '}') {
    c.ws();
    const key = /^[A-Za-z_][A-Za-z0-9_]*/.exec(c.s.slice(c.i))?.[0];
    if (!key) throw c.err('expected a key');
    c.i += key.length;
    c.eat(':');
    out[key] = parseValue(c);
    if (c.peek() === ',') c.eat(',');
  }
  c.eat('}');
  return out;
}

/** Parse `getByRole('main').getByRole('button', { name: 'New', exact: true })` (optionally prefixed by `page.`). */
export function parseLocatorExpression(expr: string): LocatorCall[] {
  const c = new Cursor(expr.trim().replace(/^page\./, ''));
  const calls = parseChain(c);
  if (c.peek() !== '') throw c.err('unexpected text after the expression');
  return calls;
}

function parseChain(c: Cursor): LocatorCall[] {
  const calls: LocatorCall[] = [];
  for (;;) {
    c.ws();
    const name = /^[A-Za-z]+/.exec(c.s.slice(c.i))?.[0];
    if (!name || !METHODS.has(name as LocatorCall['method'])) throw c.err(`method ${name ?? '?'} is not allowed`);
    c.i += name.length;
    c.eat('(');
    if (name === 'filter') {
      // only filter({ has: page.<chain> }) — the inner chain is relative to each candidate
      c.eat('{');
      c.ws();
      if (!c.s.startsWith('has', c.i)) throw c.err('filter takes only { has: ... }');
      c.i += 3;
      c.eat(':');
      c.ws();
      if (c.s.startsWith('page.', c.i)) c.i += 5;
      const has = parseChain(c);
      if (c.peek() === ',') c.eat(',');
      c.eat('}');
      c.eat(')');
      calls.push({ method: 'filter', args: [], has });
    } else {
      const args: ArgValue[] = [];
      while (c.peek() !== ')') {
        args.push(parseValue(c));
        if (c.peek() === ',') c.eat(',');
      }
      c.eat(')');
      calls.push({ method: name as LocatorCall['method'], args });
    }
    if (c.peek() !== '.') break;
    c.eat('.');
  }
  if (!calls.length) throw c.err('empty expression');
  return calls;
}

type Root = Page | Locator;

function textArg(a: ArgValue | undefined): string | RegExp {
  if (typeof a === 'string' || a instanceof RegExp) return a;
  if (typeof a === 'number' || typeof a === 'boolean') return String(a);
  throw new QAError('LOCATOR', 'locator text argument must be a string or a regex');
}

/** Apply parsed calls to a page (or locator). Only whitelisted getBy... / locator methods exist in the grammar. */
export function applyLocator(root: Root, calls: LocatorCall[]): Locator {
  let cur: Root = root;
  for (const call of calls) {
    if (call.method === 'filter') {
      if (!call.has || !('filter' in cur)) throw new QAError('LOCATOR', 'filter needs a locator and { has }');
      const page = 'page' in cur ? cur.page() : cur;
      cur = cur.filter({ has: applyLocator(page, call.has) });
      continue;
    }
    const [a, b] = call.args;
    const opts = b && typeof b === 'object' && !(b instanceof RegExp) ? b : undefined;
    const t = textArg(a);
    switch (call.method) {
      case 'getByRole':
        cur = cur.getByRole(String(t) as Parameters<Page['getByRole']>[0], opts);
        break;
      case 'getByLabel':
        cur = cur.getByLabel(t, opts);
        break;
      case 'getByText':
        cur = cur.getByText(t, opts);
        break;
      case 'getByPlaceholder':
        cur = cur.getByPlaceholder(t, opts);
        break;
      case 'getByTitle':
        cur = cur.getByTitle(t, opts);
        break;
      case 'getByTestId':
        cur = cur.getByTestId(t);
        break;
      case 'locator':
        if (typeof t !== 'string') throw new QAError('LOCATOR', 'locator() takes a CSS string');
        cur = cur.locator(t);
        break;
    }
  }
  return cur as Locator;
}
