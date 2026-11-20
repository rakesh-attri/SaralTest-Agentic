import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { matches, scalar, type SoqlQuery } from './soql.js';

/** Minimal object model for the fixture (only what the Account → Contact demo needs). */
export interface FieldDef {
  name: string;
  label: string;
  type: 'id' | 'string' | 'email' | 'phone' | 'picklist' | 'reference' | 'datetime' | 'boolean';
  required?: boolean;
  createable?: boolean;
  referenceTo?: string;
  relationshipName?: string;
  picklistValues?: string[];
  length?: number;
}
export interface ObjectDef {
  name: string;
  label: string;
  keyPrefix: string;
  fields: FieldDef[];
}

export type SObject = Record<string, unknown> & { Id: string };

export const Seed = z.object({
  organization: z.looseObject({ Id: z.string().length(18), Name: z.string() }),
  users: z.array(z.looseObject({ Id: z.string(), Username: z.string(), persona: z.string(), token: z.string() })),
  objects: z.array(
    z.object({
      name: z.string(),
      label: z.string(),
      keyPrefix: z.string().length(3),
      fields: z.array(z.looseObject({ name: z.string(), label: z.string(), type: z.string() })),
    }),
  ),
  records: z.record(z.string(), z.array(z.looseObject({ Id: z.string() }))),
});
export type Seed = z.infer<typeof Seed>;

export function loadSeed(file: string): Seed {
  return Seed.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export class FixtureError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string,
    readonly fields: string[] = [],
  ) {
    super(message);
  }
}

/** In-memory org. Everything here is FIXTURE data. */
export class FixtureStore {
  private readonly records = new Map<string, Map<string, SObject>>();
  private readonly objects = new Map<string, ObjectDef>();
  private counter = 1000; // seed ids use 1..999

  constructor(readonly seed: Seed) {
    for (const o of seed.objects) this.objects.set(o.name.toLowerCase(), o as unknown as ObjectDef);
    for (const [obj, rows] of Object.entries(seed.records)) {
      const m = new Map<string, SObject>();
      for (const r of rows) m.set(r.Id, { ...r });
      this.records.set(obj.toLowerCase(), m);
    }
    this.records.set('organization', new Map([[seed.organization.Id, { ...seed.organization }]]));
    this.records.set('user', new Map(seed.users.map((u) => [u.Id, { ...u }])));
  }

  describe(object: string): ObjectDef {
    const d = this.objects.get(object.toLowerCase());
    if (!d) throw new FixtureError(404, 'NOT_FOUND', `The requested resource does not exist: ${object}`);
    return d;
  }

  private table(object: string): Map<string, SObject> {
    const key = object.toLowerCase();
    let t = this.records.get(key);
    if (!t) {
      if (!this.objects.has(key))
        throw new FixtureError(400, 'INVALID_TYPE', `sObject type '${object}' is not supported.`);
      t = new Map();
      this.records.set(key, t);
    }
    return t;
  }

  private newId(prefix: string): string {
    this.counter++;
    return `${prefix}FX${String(this.counter).padStart(10, '0')}AAA`;
  }

  get(object: string, id: string): SObject {
    const r = this.table(object).get(id);
    if (!r) throw new FixtureError(404, 'NOT_FOUND', 'The requested resource does not exist');
    return r;
  }

  private validate(def: ObjectDef, data: Record<string, unknown>, isCreate: boolean): void {
    for (const k of Object.keys(data)) {
      const f = def.fields.find((x) => x.name.toLowerCase() === k.toLowerCase());
      if (!f || f.createable === false) {
        throw new FixtureError(400, 'INVALID_FIELD', `No such column '${k}' on sobject of type ${def.name}`, [k]);
      }
      const v = data[k];
      if (f.type === 'picklist' && v !== null && v !== undefined && !(f.picklistValues ?? []).includes(scalar(v))) {
        throw new FixtureError(
          400,
          'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST',
          `bad value for restricted picklist field: ${scalar(v)}`,
          [f.name],
        );
      }
      if (f.type === 'reference' && v) {
        const target = f.referenceTo ?? '';
        if (!this.table(target).has(scalar(v))) {
          throw new FixtureError(400, 'INVALID_CROSS_REFERENCE_KEY', `invalid cross reference id`, [f.name]);
        }
      }
      if (f.length && typeof v === 'string' && v.length > f.length) {
        throw new FixtureError(400, 'STRING_TOO_LONG', `${f.label}: data value too large`, [f.name]);
      }
    }
    const missing = def.fields.filter(
      (f) => f.required && (isCreate ? !data[f.name] : f.name in data && !data[f.name]),
    );
    if (missing.length) {
      throw new FixtureError(
        400,
        'REQUIRED_FIELD_MISSING',
        `Required fields are missing: [${missing.map((f) => f.name).join(', ')}]`,
        missing.map((f) => f.name),
      );
    }
  }

  create(object: string, data: Record<string, unknown>): SObject {
    const def = this.describe(object);
    this.validate(def, data, true);
    const id = this.newId(def.keyPrefix);
    const rec: SObject = { ...data, Id: id, CreatedDate: new Date().toISOString() };
    this.table(def.name).set(id, rec);
    return rec;
  }

  update(object: string, id: string, data: Record<string, unknown>): void {
    const def = this.describe(object);
    const rec = this.get(object, id);
    this.validate(def, data, false);
    Object.assign(rec, data);
  }

  delete(object: string, id: string): void {
    this.get(object, id);
    this.table(object).delete(id);
  }

  private resolve(object: string, rec: SObject, path: string): unknown {
    const [head, tail] = path.split('.', 2) as [string, string | undefined];
    if (!tail) {
      const key = Object.keys(rec).find((k) => k.toLowerCase() === head.toLowerCase());
      return key ? rec[key] : null;
    }
    const def = this.describe(object);
    const rel = def.fields.find((f) => f.relationshipName?.toLowerCase() === head.toLowerCase());
    if (!rel?.referenceTo) throw new FixtureError(400, 'INVALID_FIELD', `Didn't understand relationship '${head}'`);
    const parentId = rec[rel.name];
    if (!parentId) return null;
    const parent = this.table(rel.referenceTo).get(scalar(parentId));
    return parent ? this.resolve(rel.referenceTo, parent, tail) : null;
  }

  query(q: SoqlQuery): { totalSize: number; records: Record<string, unknown>[] } {
    const def =
      q.object.toLowerCase() === 'organization' || q.object.toLowerCase() === 'user'
        ? undefined
        : this.describe(q.object);
    const objectName = def?.name ?? q.object;
    let rows = [...this.table(objectName).values()].filter((r) =>
      q.where.every((c) => matches(this.resolve(objectName, r, c.field), c)),
    );
    if (q.orderBy) {
      const { field, dir } = q.orderBy;
      rows.sort((a, b) => {
        const av = scalar(this.resolve(objectName, a, field));
        const bv = scalar(this.resolve(objectName, b, field));
        return dir === 'ASC' ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    if (q.count) return { totalSize: rows.length, records: [] };
    if (q.limit !== undefined) rows = rows.slice(0, q.limit);
    return {
      totalSize: rows.length,
      records: rows.map((r) => {
        const out: Record<string, unknown> = {
          attributes: { type: objectName, url: `/services/data/v62.0/sobjects/${objectName}/${r.Id}` },
        };
        for (const f of q.fields) {
          const [head, tail] = f.split('.', 2) as [string, string | undefined];
          if (tail) {
            const v = this.resolve(objectName, r, f);
            out[head] = v === null ? null : { attributes: { type: head }, [tail]: v };
          } else {
            out[f] = this.resolve(objectName, r, f);
          }
        }
        return out;
      }),
    };
  }

  /** Records related to a parent (for the related-list render). */
  children(object: string, field: string, parentId: string): SObject[] {
    return [...this.table(object).values()].filter((r) => r[field] === parentId);
  }
}
