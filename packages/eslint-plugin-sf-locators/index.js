// ESLint rule `sf-locators/no-fragile-locators` (CLAUDE.md rule 6, .claude/skills/salesforce-lightning-locators).
// Plain JS so eslint.config.js can load it without a build step. Unit tests: tests/unit/eslint-sf-locators.test.ts.

/** @type {ReadonlyArray<readonly [RegExp, string]>} */
export const BANNED_SELECTOR_PATTERNS = [
  [/^\s*\(?\s*(?:xpath=|\/\/|\.\.\/)/i, 'XPath is banned'],
  [/#[A-Za-z_-]*\d{2,}/, 'generated element ids are banned (#input-123)'],
  [/\[\s*id\s*[\^$*|~]?=/, 'id attribute selectors are banned (generated ids)'],
  [/\[\s*aria-labelledby\s*[\^$*|~]?=\s*["']?[^\]"']*\d/, 'aria-labelledby with generated ids is banned'],
  [/data-aura-/, 'data-aura-* attributes are banned'],
  [/:nth-child|:nth-of-type|:nth-last-child/, 'positional CSS (nth-child / nth-of-type) is banned'],
  [/\.slds-[\w-]+/, '.slds-* class selectors are banned'],
  [
    /\b(?:force|lightning|records|one)-[\w-]+\s*>?\s+(?:force|lightning|records|one)-[\w-]+/,
    'force-*/lightning-* tag chains deeper than 1 are banned',
  ],
  [
    /\/lightning\/r\/\w+\/[A-Za-z0-9]{15,18}(?:\/|$)/,
    'hard-coded record ids in URLs are banned: take the id from the data ledger',
  ],
  [
    /\b(?:001|003|005|006|00Q|500|701|00D)[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?\b/,
    'hard-coded Salesforce record ids are banned',
  ],
];

/** Patterns that also apply to navigation URLs (page.goto). */
const URL_PATTERNS = BANNED_SELECTOR_PATTERNS.slice(-2);

/** @param {string} text @param {boolean} [isUrl] */
export function fragileReason(text, isUrl = false) {
  for (const [re, reason] of isUrl ? URL_PATTERNS : BANNED_SELECTOR_PATTERNS) if (re.test(text)) return reason;
  return undefined;
}

const SELECTOR_METHODS = new Set(['locator', '$', '$$', '$eval', '$$eval', 'waitForSelector', 'goto', 'frameLocator']);

/** @param {import('estree').Node | null | undefined} node @returns {string | undefined} */
function staticText(node) {
  if (!node) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') return node.quasis.map((q) => q.value.cooked ?? q.value.raw).join('${}');
  return undefined;
}

/** @param {import('estree').CallExpression} node */
function methodName(node) {
  const c = node.callee;
  if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier') return c.property.name;
  return undefined;
}

/** @type {import('eslint').Rule.RuleModule} */
export const noFragileLocators = {
  meta: {
    type: 'problem',
    docs: { description: 'Ban fragile Salesforce Lightning locators (salesforce-lightning-locators skill)' },
    schema: [],
    messages: {
      fragile: '{{reason}} (sf-locators/no-fragile-locators). Use a scoped getByRole/getByLabel from a page object.',
      nth: '.nth({{arg}}) needs a `// order: <why the order is semantic>` comment on this or the previous line.',
      firstLast:
        '.{{name}}() hides non-unique matches. Allowed only with a `// unique-test-data: <why>` comment on this or the previous line.',
      sleep: 'waitForTimeout / fixed sleeps are banned: use web-first assertions or the Lightning helpers.',
    },
  },
  create(context) {
    const source = context.sourceCode;
    /** @param {import('estree').Node} node @param {RegExp} marker */
    const hasMarker = (node, marker) => {
      const line = node.loc?.start.line ?? 0;
      return source.getAllComments().some((c) => {
        const l = c.loc?.end.line ?? -1;
        return (l === line || l === line - 1 || c.loc?.start.line === line) && marker.test(c.value);
      });
    };
    return {
      CallExpression(node) {
        const name = methodName(node);
        if (!name) return;
        if (name === 'waitForTimeout') {
          context.report({ node, messageId: 'sleep' });
          return;
        }
        if (SELECTOR_METHODS.has(name)) {
          const text = staticText(/** @type {import('estree').Node} */ (node.arguments[0]));
          const reason = text === undefined ? undefined : fragileReason(text, name === 'goto');
          if (reason) context.report({ node, messageId: 'fragile', data: { reason } });
          return;
        }
        if (name === 'nth' && !hasMarker(node, /\border:/)) {
          const arg =
            staticText(/** @type {import('estree').Node} */ (node.arguments[0])) ??
            source.getText(/** @type {any} */ (node.arguments[0]) ?? node);
          context.report({ node, messageId: 'nth', data: { arg } });
          return;
        }
        if (
          (name === 'first' || name === 'last') &&
          node.arguments.length === 0 &&
          !hasMarker(node, /\bunique-test-data:/)
        ) {
          context.report({ node, messageId: 'firstLast', data: { name } });
        }
      },
    };
  },
};

/** @type {import('eslint').ESLint.Plugin & { rules: Record<string, import('eslint').Rule.RuleModule> }} */
const plugin = {
  meta: { name: 'eslint-plugin-sf-locators', version: '0.1.0' },
  rules: { 'no-fragile-locators': noFragileLocators },
};
export default plugin;
