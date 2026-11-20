import { createHash } from 'node:crypto';

/** JSON with object keys sorted recursively (array order is kept: it is meaningful, e.g. picklist order). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/**
 * Content hash of a component: type-prefixed so hashes of different artifact types are never equal by accident
 * (PLAN.md §7c: never compare hashes of different artifact types).
 */
export function contentHash(type: string, body: unknown): string {
  return `${type}:${createHash('sha256').update(canonicalJson(body)).digest('hex').slice(0, 32)}`;
}
