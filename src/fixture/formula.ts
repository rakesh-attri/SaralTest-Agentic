// Validation-rule formula evaluator for the OFFLINE FIXTURE (FIXTURE only — never evidence about a real org).
// A small subset of the Salesforce formula language: AND OR NOT ISBLANK ISPICKVAL TEXT LEN REGEX CASE BEGINS CONTAINS
// IF, string / number / boolean literals, field references, = == != <> < > <= >=, && || and parentheses. REGEX matches
// the whole value (as on Salesforce). Anything else is FIXTURE_UNSUPPORTED_FORMULA: a rule the fixture cannot evaluate
// must fail loudly, never pass silently.

export class FormulaError extends Error {
  readonly errorCode = 'FIXTURE_UNSUPPORTED_FORMULA';
}

type Value = string | number | boolean | null;
type Node =
  | { t: 'lit'; v: Value }
  | { t: 'field'; name: string }
  | { t: 'call'; fn: string; args: Node[] }
  | { t: 'bin'; op: string; l: Node; r: Node };

interface Tok {
  k: 'str' | 'num' | 'id' | 'op' | '(' | ')' | ',';
  v: string;
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] ?? '';
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let s = '';
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\' && i + 1 < src.length) {
          const n = src[i + 1] ?? '';
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          i += 2;
          continue;
        }
        s += src[i] ?? '';
        i++;
      }
      if (i >= src.length) throw new FormulaError('unterminated string literal');
      i++;
      out.push({ k: 'str', v: s });
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i));
      out.push({ k: 'num', v: m?.[0] ?? c });
      i += m?.[0].length ?? 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$.]*/.exec(src.slice(i));
      out.push({ k: 'id', v: m?.[0] ?? c });
      i += m?.[0].length ?? 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<>', '<=', '>=', '&&', '||'].includes(two)) {
      out.push({ k: 'op', v: two });
      i += 2;
      continue;
    }
    if (['=', '<', '>', '&', '+', '-'].includes(c)) {
      out.push({ k: 'op', v: c });
      i++;
      continue;
    }
    if (c === '(' || c === ')' || c === ',') {
      out.push({ k: c, v: c });
      i++;
      continue;
    }
    throw new FormulaError(`unexpected character "${c}"`);
  }
  return out;
}

const PREC: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '=': 3,
  '==': 3,
  '!=': 3,
  '<>': 3,
  '<': 4,
  '>': 4,
  '<=': 4,
  '>=': 4,
  '&': 5,
  '+': 5,
  '-': 5,
};

function parse(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = (): Tok | undefined => toks[p];
  const expect = (k: Tok['k']): Tok => {
    const t = toks[p];
    if (t?.k !== k) throw new FormulaError(`expected ${k} at token ${p}`);
    p++;
    return t;
  };
  const primary = (): Node => {
    const t = peek();
    if (!t) throw new FormulaError('unexpected end of formula');
    p++;
    if (t.k === 'str') return { t: 'lit', v: t.v };
    if (t.k === 'num') return { t: 'lit', v: Number(t.v) };
    if (t.k === '(') {
      const e = expr(0);
      expect(')');
      return e;
    }
    if (t.k === 'id') {
      const up = t.v.toUpperCase();
      if (up === 'TRUE' || up === 'FALSE') return { t: 'lit', v: up === 'TRUE' };
      if (up === 'NULL') return { t: 'lit', v: null };
      if (peek()?.k === '(') {
        p++;
        const args: Node[] = [];
        if (peek()?.k !== ')') {
          args.push(expr(0));
          while (peek()?.k === ',') {
            p++;
            args.push(expr(0));
          }
        }
        expect(')');
        return { t: 'call', fn: up, args };
      }
      return { t: 'field', name: t.v };
    }
    throw new FormulaError(`unexpected token "${t.v}"`);
  };
  const expr = (min: number): Node => {
    let left = primary();
    for (;;) {
      const t = peek();
      const prec = t?.k === 'op' ? PREC[t.v] : undefined;
      if (!t || prec === undefined || prec < min) break;
      p++;
      const right = expr(prec + 1);
      left = { t: 'bin', op: t.v, l: left, r: right };
    }
    return left;
  };
  const tree = expr(0);
  if (p !== toks.length) throw new FormulaError(`unexpected trailing token "${toks[p]?.v ?? ''}"`);
  return tree;
}

const blank = (v: Value): boolean => v === null || v === '';
const str = (v: Value): string => (v === null ? '' : String(v));
const truthy = (v: Value): boolean => v === true;

function evaluate(n: Node, rec: Record<string, unknown>): Value {
  switch (n.t) {
    case 'lit':
      return n.v;
    case 'field': {
      const key = Object.keys(rec).find((k) => k.toLowerCase() === n.name.toLowerCase());
      const v = key ? rec[key] : null;
      return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null;
    }
    case 'bin': {
      const l = evaluate(n.l, rec);
      const r = evaluate(n.r, rec);
      switch (n.op) {
        case '&&':
          return truthy(l) && truthy(r);
        case '||':
          return truthy(l) || truthy(r);
        case '=':
        case '==':
          return str(l) === str(r) || (typeof l === 'number' && l === Number(r));
        case '!=':
        case '<>':
          return !(str(l) === str(r) || (typeof l === 'number' && l === Number(r)));
        case '<':
          return Number(l) < Number(r);
        case '>':
          return Number(l) > Number(r);
        case '<=':
          return Number(l) <= Number(r);
        case '>=':
          return Number(l) >= Number(r);
        case '&':
          return str(l) + str(r);
        case '+':
          return Number(l) + Number(r);
        case '-':
          return Number(l) - Number(r);
        default:
          throw new FormulaError(`operator ${n.op} is not supported`);
      }
    }
    case 'call': {
      const a = (i: number): Value => {
        const x = n.args[i];
        if (!x) throw new FormulaError(`${n.fn}: missing argument ${i + 1}`);
        return evaluate(x, rec);
      };
      switch (n.fn) {
        case 'AND':
          return n.args.every((_, i) => truthy(a(i)));
        case 'OR':
          return n.args.some((_, i) => truthy(a(i)));
        case 'NOT':
          return !truthy(a(0));
        case 'IF':
          return truthy(a(0)) ? a(1) : a(2);
        case 'ISBLANK':
          return blank(a(0));
        case 'ISPICKVAL':
          return str(a(0)) === str(a(1));
        case 'TEXT':
          return str(a(0));
        case 'LEN':
          return str(a(0)).length;
        case 'BEGINS':
          return str(a(0)).startsWith(str(a(1)));
        case 'CONTAINS':
          return str(a(0)).includes(str(a(1)));
        case 'REGEX': {
          const v = a(0);
          // Salesforce REGEX matches the whole text; an empty field never matches.
          if (blank(v)) return false;
          return new RegExp(`^(?:${str(a(1))})$`).test(str(v));
        }
        case 'CASE': {
          const subject = str(a(0));
          const rest = n.args.length - 1;
          for (let i = 1; i + 1 < n.args.length; i += 2) if (str(a(i)) === subject) return a(i + 1);
          return rest % 2 === 1 ? a(n.args.length - 1) : null;
        }
        default:
          throw new FormulaError(`function ${n.fn} is not supported by the fixture`);
      }
    }
  }
}

const cache = new Map<string, Node>();

/** True when the error condition holds (= the record violates the rule). */
export function errorConditionHolds(formula: string, record: Record<string, unknown>): boolean {
  let tree = cache.get(formula);
  if (!tree) {
    tree = parse(formula);
    cache.set(formula, tree);
  }
  return evaluate(tree, record) === true;
}
