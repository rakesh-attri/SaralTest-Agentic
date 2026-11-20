/**
 * Tiny SOQL subset for the offline fixture (FIXTURE only — never a stand-in for real Salesforce semantics):
 *   SELECT f1, f2, Parent.Field FROM Object
 *     [WHERE f = 'v' | f != 'v' | f LIKE 'v%' | f = null | f IN ('a','b')  [AND …]]
 *     [ORDER BY f [ASC|DESC]] [LIMIT n]
 *   SELECT COUNT() FROM Object [WHERE …]
 * Anything else → MALFORMED_QUERY, so tests never silently depend on unsupported behaviour.
 */
export interface Condition {
  field: string;
  op: '=' | '!=' | 'LIKE' | 'IN';
  value: string | null | string[];
}
export interface SoqlQuery {
  object: string;
  fields: string[];
  count: boolean;
  where: Condition[];
  orderBy?: { field: string; dir: 'ASC' | 'DESC' };
  limit?: number;
}

/** Stringify a field value without [object Object] surprises. */
export function scalar(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return v.toString();
  return JSON.stringify(v);
}

export class SoqlError extends Error {
  readonly errorCode = 'MALFORMED_QUERY';
}

const IDENT = '[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)?';
const STR = "'((?:[^'\\\\]|\\\\.)*)'";

function unquote(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}

function parseCondition(raw: string): Condition {
  const t = raw.trim();
  let m = new RegExp(`^(${IDENT})\\s+IN\\s*\\((.*)\\)$`, 'i').exec(t);
  if (m?.[1] && m[2] !== undefined) {
    const values = [...m[2].matchAll(new RegExp(STR, 'g'))].map((x) => unquote(x[1] ?? ''));
    if (!values.length) throw new SoqlError(`empty IN list: ${t}`);
    return { field: m[1], op: 'IN', value: values };
  }
  m = new RegExp(`^(${IDENT})\\s*(=|!=|LIKE)\\s*(?:${STR}|(null))$`, 'i').exec(t);
  if (!m?.[1] || !m[2]) throw new SoqlError(`unsupported condition: ${t}`);
  const op = m[2].toUpperCase() as Condition['op'];
  const value = m[4] !== undefined ? null : unquote(m[3] ?? '');
  if (op === 'LIKE' && value === null) throw new SoqlError('LIKE null is not valid');
  return { field: m[1], op, value };
}

export function parseSoql(q: string): SoqlQuery {
  const text = q.trim().replace(/\s+/g, ' ');
  const m = new RegExp(
    `^SELECT (.+?) FROM (${IDENT})(?: WHERE (.+?))?(?: ORDER BY (${IDENT})(?: (ASC|DESC))?)?(?: LIMIT (\\d+))?$`,
    'i',
  ).exec(text);
  if (!m?.[1] || !m[2]) throw new SoqlError(`unsupported SOQL: ${q}`);
  const select = m[1].trim();
  const count = /^COUNT\(\)$/i.test(select);
  const fields = count ? [] : select.split(',').map((f) => f.trim());
  for (const f of fields) if (!new RegExp(`^${IDENT}$`).test(f)) throw new SoqlError(`unsupported field: ${f}`);
  const where = m[3] ? splitAnd(m[3]).map(parseCondition) : [];
  return {
    object: m[2],
    fields,
    count,
    where,
    ...(m[4] ? { orderBy: { field: m[4], dir: (m[5]?.toUpperCase() ?? 'ASC') as 'ASC' | 'DESC' } } : {}),
    ...(m[6] ? { limit: Number(m[6]) } : {}),
  };
}

/** Split on AND outside quotes; OR is not supported. */
function splitAnd(where: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < where.length; i++) {
    const ch = where[i];
    if (ch === "'" && where[i - 1] !== '\\') inQ = !inQ;
    if (!inQ && /^ AND /i.test(where.slice(i, i + 5))) {
      parts.push(cur);
      cur = '';
      i += 4;
      continue;
    }
    if (!inQ && /^ OR /i.test(where.slice(i, i + 4))) throw new SoqlError('OR is not supported by the fixture');
    cur += ch ?? '';
  }
  parts.push(cur);
  return parts;
}

function likeToRegex(pattern: string): RegExp {
  const esc = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '.*')
    .replace(/_/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

export function matches(value: unknown, c: Condition): boolean {
  const v = value === undefined ? null : value;
  switch (c.op) {
    case '=':
      return c.value === null ? v === null : scalar(v) === c.value;
    case '!=':
      return c.value === null ? v !== null : scalar(v) !== c.value;
    case 'LIKE':
      return v !== null && likeToRegex(scalar(c.value)).test(scalar(v));
    case 'IN':
      return Array.isArray(c.value) && v !== null && c.value.includes(scalar(v));
  }
}
