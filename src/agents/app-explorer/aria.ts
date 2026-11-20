/**
 * Parser for Playwright `locator.ariaSnapshot()` YAML (`- role "name" [attr]: …`). Produces a flat list of nodes with
 * their ancestor chain, so the Explorer can build scoped, role-based locators (salesforce-lightning-locators skill).
 */
export interface AriaNode {
  role: string;
  name?: string;
  attrs: string[];
  depth: number;
  /** Ancestors from the root down to the direct parent. */
  ancestors: { role: string; name?: string }[];
}

const LINE = /^(\s*)- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)(?::.*)?$/;

export function parseAriaSnapshot(yaml: string): AriaNode[] {
  const out: AriaNode[] = [];
  const stack: { indent: number; role: string; name?: string }[] = [];
  for (const raw of yaml.split(/\r?\n/)) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const indent = (m[1] ?? '').length;
    const role = m[2] ?? '';
    const name = m[3] !== undefined ? m[3].replace(/\\(.)/g, '$1') : undefined;
    const attrs = [...(m[4] ?? '').matchAll(/\[([^\]]*)\]/g)].map((a) => a[1] ?? '');
    while (stack.length && (stack.at(-1)?.indent ?? -1) >= indent) stack.pop();
    out.push({
      role,
      ...(name !== undefined ? { name } : {}),
      attrs,
      depth: stack.length,
      ancestors: stack.map((s) => ({ role: s.role, ...(s.name !== undefined ? { name: s.name } : {}) })),
    });
    stack.push({ indent, role, ...(name !== undefined ? { name } : {}) });
  }
  return out;
}

/** Roles worth registering (interactive or structural landmarks a test acts on). Links/headings carry record data. */
export const ACTIONABLE_ROLES = new Set([
  'button',
  'tab',
  'textbox',
  'combobox',
  'checkbox',
  'radio',
  'spinbutton',
  'searchbox',
  'switch',
  'menuitem',
]);

/** Ancestor roles usable as a locator scope (named regions). */
export const SCOPE_ROLES = new Set([
  'dialog',
  'article',
  'tabpanel',
  'region',
  'form',
  'group',
  'tablist',
  'navigation',
  'banner',
]);
