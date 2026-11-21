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

/** Value of `field` on record `id` (undefined when the record does not exist). */
export async function soqlValue(sf: Sf, object: string, id: string, field: string): Promise<unknown> {
  const rows = await sf.query(`SELECT ${name(field)} FROM ${name(object)} WHERE Id = ${soqlString(id)}`);
  return rows[0]?.[field];
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
