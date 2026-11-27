import { describe, expect, it } from 'vitest';
import { expectedTabOrder, layoutSections } from './tabOrder.js';

const cell = (value: string, parts: string[] = []) => ({
  layoutComponents: [{ type: 'Field', value, components: parts.map((p) => ({ type: 'Field', value: p })) }],
});
// Shape of qa-prod's Contact describe/layouts (Winter '27), trimmed.
const contactLayouts = {
  layouts: [
    {
      editLayoutSections: [
        {
          heading: 'Contact Information',
          tabOrder: 'TopToBottom',
          layoutRows: [
            { layoutItems: [cell('OwnerId'), cell('Phone')] },
            { layoutItems: [cell('Name', ['Salutation', 'FirstName', 'LastName']), cell('MobilePhone')] },
            { layoutItems: [cell('AccountId'), cell('Email')] },
            { layoutItems: [cell('Title'), cell('ReportsToId')] },
          ],
        },
        {
          heading: 'Additional Information',
          tabOrder: 'LeftToRight',
          layoutRows: [{ layoutItems: [cell('Fax'), cell('LeadSource')] }],
        },
      ],
      detailLayoutSections: [],
    },
  ],
};

describe('layoutSections', () => {
  it('reads sections, direction and compound parts from describe/layouts', () => {
    const s = layoutSections(contactLayouts, 'edit');
    expect(s.map((x) => `${x.heading}=${x.tabOrder}`)).toEqual([
      'Contact Information=TopToBottom',
      'Additional Information=LeftToRight',
    ]);
    expect(s[0]?.cells.find((c) => c.fields.includes('LastName'))).toMatchObject({ row: 1, col: 0 });
  });

  it('accepts a single layout (no record types) and rejects an unknown direction', () => {
    const one = contactLayouts.layouts[0];
    expect(layoutSections(one, 'edit')).toHaveLength(2);
    expect(() =>
      layoutSections({ editLayoutSections: [{ heading: 'x', tabOrder: 'Diagonal', layoutRows: [] }] }, 'edit'),
    ).toThrow();
  });
});

describe('expectedTabOrder', () => {
  const sections = layoutSections(contactLayouts, 'edit');
  // two-column form: left column x=0, right column x=400; rows 100 px apart
  const els = [
    { name: 'phone', x: 400, y: 0, field: 'Phone' },
    { name: 'firstName', x: 0, y: 100, field: 'FirstName' },
    { name: 'lastName', x: 0, y: 140, field: 'LastName' },
    { name: 'email', x: 400, y: 200, field: 'Email' },
    { name: 'accountId', x: 0, y: 200, field: 'AccountId' },
    { name: 'title', x: 0, y: 300, field: 'Title' },
    { name: 'leadSource', x: 400, y: 500, field: 'LeadSource' },
    { name: 'save', x: 500, y: 900 },
    { name: 'cancel', x: 300, y: 900 },
  ];

  it('TopToBottom: the left column first, then the right column; buttons last in visual order', () => {
    const r = expectedTabOrder(els, sections);
    expect(r.order).toEqual([
      'firstName',
      'lastName',
      'accountId',
      'title',
      'phone',
      'email',
      'leadSource',
      'cancel',
      'save',
    ]);
    expect(r.basis['phone']).toBe('Contact Information (TopToBottom)');
    expect(r.basis['save']).toBe('visual order');
  });

  it('LeftToRight: row by row', () => {
    const ltr = sections.map((s) => ({ ...s, tabOrder: 'LeftToRight' as const }));
    expect(expectedTabOrder(els, ltr).order.slice(0, 6)).toEqual([
      'phone',
      'firstName',
      'lastName',
      'accountId',
      'email',
      'title',
    ]);
  });

  it('without layout metadata: plain visual order', () => {
    expect(expectedTabOrder(els, []).order.slice(0, 3)).toEqual(['phone', 'firstName', 'lastName']);
  });
});
