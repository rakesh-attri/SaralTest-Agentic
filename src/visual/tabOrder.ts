// Expected keyboard order of a record form from the org's page layout metadata (Phase 6, operator 2026-11-27).
// Salesforce sets the Tab direction per layout section: `LeftToRight` (row by row) or `TopToBottom` (column by
// column). run-p6-live-1 assumed row order and failed on qa-prod, whose Contact Information section is TopToBottom.
// Source: REST `GET /sobjects/<Object>/describe/layouts` (observe). Pure functions; Zod at the API boundary.
import { z } from 'zod';

/** Salesforce-owned a11y candidate: Lightning does not apply the section's Tab-key order (operator 2026-11-27). */
export const SECTION_TAB_ORDER_RULE = 'sf-section-tab-order-not-applied';

export const SectionTabOrder = z.enum(['LeftToRight', 'TopToBottom']);
export type SectionTabOrder = z.infer<typeof SectionTabOrder>;

interface ComponentShape {
  value?: string | null | undefined;
  components?: ComponentShape[] | undefined;
}
const LayoutComponent: z.ZodType<ComponentShape> = z.lazy(() =>
  z.looseObject({
    value: z.string().nullish(),
    components: z.array(LayoutComponent).optional(),
  }),
);
const LayoutItem = z.looseObject({ layoutComponents: z.array(LayoutComponent).default([]) });
const LayoutRow = z.looseObject({ layoutItems: z.array(LayoutItem).default([]) });
const DescribeSection = z.looseObject({
  heading: z.string().nullish(),
  tabOrder: SectionTabOrder,
  layoutRows: z.array(LayoutRow).default([]),
});
const DescribeLayout = z.looseObject({
  editLayoutSections: z.array(DescribeSection).default([]),
  detailLayoutSections: z.array(DescribeSection).default([]),
});
/** One layout (single record type) or `{ layouts: [...] }` (several record types: the first is the default). */
const DescribeLayouts = z.union([
  z.looseObject({ layouts: z.array(DescribeLayout).min(1) }),
  DescribeLayout.transform((l) => ({ layouts: [l] })),
]);

export interface LayoutSection {
  heading: string;
  tabOrder: SectionTabOrder;
  /** Field API names per cell (a compound field lists its parts too: Name → FirstName, LastName, …). */
  cells: { row: number; col: number; fields: string[] }[];
}

const fieldsOf = (c: ComponentShape): string[] => [
  ...(c.value ? [c.value] : []),
  ...(c.components ?? []).flatMap(fieldsOf),
];

/** Sections of the edit (form) or detail layout, in page order. Throws a ZodError on an unexpected shape. */
export function layoutSections(describe: unknown, kind: 'edit' | 'detail'): LayoutSection[] {
  const d = DescribeLayouts.parse(describe);
  const layout = d.layouts[0];
  if (!layout) return [];
  const sections = kind === 'edit' ? layout.editLayoutSections : layout.detailLayoutSections;
  return sections.map((s) => ({
    heading: s.heading ?? '',
    tabOrder: s.tabOrder,
    cells: s.layoutRows.flatMap((r, row) =>
      r.layoutItems.map((it, col) => ({ row, col, fields: it.layoutComponents.flatMap(fieldsOf) })),
    ),
  }));
}

export interface PlacedElement {
  name: string;
  x: number;
  y: number;
  /** Field API name this element edits (e.g. FirstName, MailingStreet); none for buttons. */
  field?: string;
}

export interface ExpectedOrder {
  order: string[];
  /** Section heading + direction used per element (for the report); none = visual order. */
  basis: Record<string, string>;
}

/**
 * Expected Tab order: elements in layout sections first, section by section in page order; inside a section by the
 * section's direction (LeftToRight: row, then column · TopToBottom: column, then row); parts of one compound field
 * (Name, Address) and elements without a field (buttons) by their on-screen position, the latter after the sections.
 */
export function expectedTabOrder(
  els: readonly PlacedElement[],
  sections: readonly LayoutSection[],
  rowTolerancePx = 12,
): ExpectedOrder {
  const visual = (a: PlacedElement, b: PlacedElement): number =>
    Math.abs(a.y - b.y) <= rowTolerancePx ? a.x - b.x : a.y - b.y;
  const placed = els.map((e) => {
    for (const [si, s] of sections.entries()) {
      const cell = e.field ? s.cells.find((c) => c.fields.includes(e.field ?? '')) : undefined;
      if (cell) return { e, si, s, cell };
    }
    return { e, si: Number.POSITIVE_INFINITY, s: undefined, cell: undefined };
  });
  placed.sort((a, b) => {
    if (a.si !== b.si) return a.si - b.si;
    const sec = sections[a.si];
    if (sec && a.cell && b.cell) {
      const [p1, p2] = sec.tabOrder === 'TopToBottom' ? (['col', 'row'] as const) : (['row', 'col'] as const);
      if (a.cell[p1] !== b.cell[p1]) return a.cell[p1] - b.cell[p1];
      if (a.cell[p2] !== b.cell[p2]) return a.cell[p2] - b.cell[p2];
    }
    return visual(a.e, b.e);
  });
  const basis: Record<string, string> = {};
  for (const p of placed) basis[p.e.name] = p.s ? `${p.s.heading || 'section'} (${p.s.tabOrder})` : 'visual order';
  return { order: placed.map((p) => p.e.name), basis };
}
