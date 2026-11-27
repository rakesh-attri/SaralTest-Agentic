// Fixture page layout (FIXTURE only): the order of the Contact fields on the record page Details panel and in the
// Contact form (New Contact / Edit dialogs), like a Salesforce page layout. A layout file lets the offline demo seed
// a visual change the same way an admin moves a field in Setup (Phase 6). Templates mark each field block with
// `<!--field:Name-->…<!--/field-->` inside `<!--fields:section-->…<!--/fields-->`.
import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const FixtureLayout = z.object({
  description: z.string().optional(),
  contact: z
    .object({
      /** Field blocks of the Contact Details panel, in order. */
      details: z.array(z.string().min(1)).optional(),
      /** Field blocks of the Contact form (New Contact / Edit dialogs), in order. */
      form: z.array(z.string().min(1)).optional(),
    })
    .default({}),
});
export type FixtureLayout = z.infer<typeof FixtureLayout>;

export function loadFixtureLayout(file: string): FixtureLayout {
  return FixtureLayout.parse(JSON.parse(readFileSync(file, 'utf8')));
}

const SECTION = (name: string): RegExp => new RegExp(`<!--fields:${name}-->([\\s\\S]*?)<!--/fields-->`);
const BLOCK = /<!--field:([A-Za-z]+)-->[\s\S]*?<!--\/field-->/g;

/** Field names of a section, in template order. */
export function sectionFields(html: string, section: string): string[] {
  const m = SECTION(section).exec(html);
  if (!m?.[1]) return [];
  return [...m[1].matchAll(BLOCK)].map((b) => b[1] ?? '');
}

/**
 * Reorder (and drop) the field blocks of one section. Every name in `order` must exist in the template (a typo would
 * silently hide a field otherwise); blocks not listed are removed, as when a field is taken off a page layout.
 */
export function applyLayout(html: string, section: string, order: readonly string[] | undefined): string {
  if (!order) return html;
  const re = SECTION(section);
  const m = re.exec(html);
  if (!m?.[1]) throw new Error(`fixture layout: section "${section}" not found in the page template`);
  const blocks = new Map<string, string>();
  for (const b of m[1].matchAll(BLOCK)) blocks.set(b[1] ?? '', b[0]);
  const unknown = order.filter((n) => !blocks.has(n));
  if (unknown.length) {
    throw new Error(
      `fixture layout: unknown field(s) ${unknown.join(', ')} in section "${section}" (known: ${[...blocks.keys()].join(', ')})`,
    );
  }
  const body = order.map((n) => blocks.get(n) ?? '').join('\n');
  return html.replace(re, `<!--fields:${section}-->\n${body}\n<!--/fields-->`);
}
