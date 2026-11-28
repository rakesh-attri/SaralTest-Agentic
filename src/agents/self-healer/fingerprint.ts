// Assertion fingerprint (CLAUDE.md rule 7: self-healing never changes assertions, expected values or test intent).
// Every `expect(...)…matcher(...)` chain of a spec, every `expect*` helper call (expectToast, expectRecordTitle …)
// and every API oracle call (soqlValue, soqlCount …) is collected from the TypeScript AST, whitespace-normalised and
// hashed together with the test IR's assertions. A repair is applied only when the fingerprint is identical before and
// after; the page-object catalog check proves that only the repaired member's locator changed.
import { createHash } from 'node:crypto';
import ts from 'typescript';
import type { AssertionFingerprint } from '../../core/schemas/index.js';

const ORACLE_CALL = /^(expect[A-Z]\w*|soql\w*|api\w*Rejects|recordIdFromView)$/;

function rootIdentifier(e: ts.Expression): string | undefined {
  let cur: ts.Expression = e;
  for (;;) {
    if (ts.isCallExpression(cur)) cur = cur.expression;
    else if (ts.isPropertyAccessExpression(cur)) cur = cur.expression;
    else if (ts.isAwaitExpression(cur) || ts.isParenthesizedExpression(cur)) cur = cur.expression;
    else if (ts.isNonNullExpression(cur)) cur = cur.expression;
    else break;
  }
  return ts.isIdentifier(cur) ? cur.text : undefined;
}

/** The outermost call of a member chain (expect(x).not.toBe(y) → the toBe call). */
function isChainTop(n: ts.CallExpression): boolean {
  const p = n.parent;
  return !(ts.isPropertyAccessExpression(p) && p.expression === n) && !(ts.isCallExpression(p) && p.expression === n);
}

const norm = (s: string): string => s.replace(/\s+/g, '');

/** Normalised assertion / oracle lines of a spec, in source order. */
export function assertionItems(specText: string): string[] {
  const sf = ts.createSourceFile('spec.ts', specText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const items: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && isChainTop(n)) {
      const root = rootIdentifier(n.expression);
      const callee = ts.isIdentifier(n.expression) ? n.expression.text : undefined;
      if (root === 'expect' || (callee && ORACLE_CALL.test(callee))) {
        items.push(norm(n.getText(sf)));
        return; // nested oracle calls are part of this line
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return items;
}

/** Fingerprint of a spec plus (optionally) its IR assertions. */
export function assertionFingerprint(specText: string, irAssertions: readonly unknown[] = []): AssertionFingerprint {
  const items = [...assertionItems(specText), ...irAssertions.map((a) => `ir:${JSON.stringify(a)}`)];
  return {
    sha256: createHash('sha256').update(items.join('\n')).digest('hex'),
    count: items.length,
    items,
  };
}

export const sameFingerprint = (a: AssertionFingerprint, b: AssertionFingerprint): boolean =>
  a.sha256 === b.sha256 && a.count === b.count;

/** Lines in `after` that are not in `before` and vice versa (for a refusal message). */
export function fingerprintDiff(
  a: AssertionFingerprint,
  b: AssertionFingerprint,
): { removed: string[]; added: string[] } {
  const A = new Set(a.items);
  const B = new Set(b.items);
  return { removed: a.items.filter((x) => !B.has(x)), added: b.items.filter((x) => !A.has(x)) };
}
