/**
 * Field references in a Salesforce formula (validation rules, formula fields). Deterministic and conservative:
 * string literals and comments are skipped, function names (`NAME(`) and operators/keywords are ignored, `$` globals
 * are reported separately. Single names resolve to `<Object>.<Field>`; `Rel.Field` paths resolve through the
 * relationship map (`Account` → Contact.AccountId → Account.Field).
 */
const KEYWORDS = new Set(['TRUE', 'FALSE', 'NULL', 'AND', 'OR', 'NOT']);

export interface FormulaRefs {
  /** `<Object>.<Field>` names, deduplicated and sorted. */
  fields: string[];
  /** `$User.Id`, `$Profile.Name`, `$Setup.X__c.Y__c` … */
  globals: string[];
}

/** relationshipName (lower-case) → { field: lookup field API name, target: referenced object }. */
export type RelationshipMap = Map<string, { field: string; target: string }>;

function stripLiteralsAndComments(formula: string): string {
  let out = '';
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i] ?? '';
    if (ch === '"' || ch === "'") {
      const q = ch;
      i++;
      while (i < formula.length && formula[i] !== q) i += formula[i] === '\\' ? 2 : 1;
      i++;
      out += ' "" ';
      continue;
    }
    if (ch === '/' && formula[i + 1] === '*') {
      const end = formula.indexOf('*/', i + 2);
      i = end < 0 ? formula.length : end + 2;
      out += ' ';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export function formulaFieldRefs(
  formula: string,
  object: string,
  relationships: RelationshipMap = new Map(),
  /** Optional resolver for paths whose first hop is on another object (multi-hop). */
  relationshipsOf?: (object: string) => RelationshipMap,
): FormulaRefs {
  const text = stripLiteralsAndComments(formula);
  const fields = new Set<string>();
  const globals = new Set<string>();
  const re = /(\$?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_$][A-Za-z0-9_]*)*)(\s*\()?/g;
  for (const m of text.matchAll(re)) {
    const token = m[1] ?? '';
    if (m[2]) continue; // function call
    if (token.startsWith('$')) {
      globals.add(token);
      continue;
    }
    if (KEYWORDS.has(token.toUpperCase())) continue;
    if (/^\d/.test(token)) continue;
    const parts = token.split('.');
    if (parts.length === 1) {
      fields.add(`${object}.${token}`);
      continue;
    }
    // Rel.Rel2.Field → walk relationships
    let current = object;
    let rels = relationships;
    let ok = true;
    for (const rel of parts.slice(0, -1)) {
      const hop = rels.get(rel.toLowerCase());
      if (!hop) {
        ok = false;
        break;
      }
      fields.add(`${current}.${hop.field}`);
      current = hop.target;
      rels = relationshipsOf?.(current) ?? (new Map() as RelationshipMap);
    }
    if (ok) fields.add(`${current}.${parts.at(-1) ?? ''}`);
    else fields.add(`${object}.${token}`); // unresolved path: keep it visible rather than dropping it
  }
  return { fields: [...fields].sort(), globals: [...globals].sort() };
}
