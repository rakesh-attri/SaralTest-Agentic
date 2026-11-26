// Independent API oracles for generated tests (salesforce-api-testing skill): SOQL through the identity-checked
// GuardedSalesforce (`sf` fixture). Values are bound with soqlString (never string-concatenated raw input).
import type { GuardedSalesforce } from '../../src/sf/client.js';
import { soqlString } from '../../src/sf/data/engine.js';

type Sf = Pick<GuardedSalesforce, 'query'>;
const API_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

function name(n: string): string {
  if (!API_NAME.test(n)) throw new Error(`not an API name: ${n}`);
  return n;
}

/** A field, or one parent field through a relationship (`Account.Name`): each part an API name. */
function fieldPath(f: string): string[] {
  const parts = f.split('.');
  if (parts.length > 2) throw new Error(`not a field or parent field: ${f}`);
  return parts.map(name);
}

/**
 * Value of `field` on record `id` (undefined when the record does not exist). `field` may be a parent field
 * (`Account.Name`): the generator compares parents by name, never by id (qa-prod run-p5-live-8, TC-050).
 */
export async function soqlValue(sf: Sf, object: string, id: string, field: string): Promise<unknown> {
  const path = fieldPath(field);
  const rows = await sf.query(`SELECT ${path.join('.')} FROM ${name(object)} WHERE Id = ${soqlString(id)}`);
  const row = rows[0];
  if (!row) return undefined;
  const [head, sub] = path;
  if (!head) return undefined;
  if (!sub) return row[head];
  const parent = row[head];
  return parent && typeof parent === 'object' ? (parent as Record<string, unknown>)[sub] : null;
}

/** Number of `object` records with `field = value`. */
export async function soqlCount(sf: Sf, object: string, field: string, value: string): Promise<number> {
  return (await sf.query(`SELECT Id FROM ${name(object)} WHERE ${name(field)} = ${soqlString(value)}`)).length;
}

/** Fields with field-history rows for a record (standard objects: `<Object>History.<Object>Id`). */
export async function historyFields(sf: Sf, object: string, id: string): Promise<string[]> {
  const rows = await sf.query<{ Field: string }>(
    `SELECT Field FROM ${name(object)}History WHERE ${name(object)}Id = ${soqlString(id)}`,
  );
  return [...new Set(rows.map((r) => r.Field))];
}
