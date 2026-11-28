// Approved action catalog of the Contact-creation charter (exploratory-testing SKILL heuristics: boundaries & formats,
// interruptions, CRUD). Only these actions exist; only `save-attempt` mutates (guarded, audited, capped by
// policy.exploration.maxSavesPerCharter; anything created is adopted, run-tagged and cleaned up).
// Values are synthetic value classes, never real person data; text values carry the run prefix so a created record is
// recognisable as run-owned.
import type { ExplorationAction } from '../../core/schemas/index.js';

/** Dialog fields the charter touches: label (accessible name) → Contact API field. */
export const CONTACT_FIELDS = {
  'Last Name': 'LastName',
  Email: 'Email',
  Phone: 'Phone',
  Title: 'Title',
  'Lead Source': 'LeadSource',
} as const;
export type ContactLabel = keyof typeof CONTACT_FIELDS;

export interface ActionDef extends ExplorationAction {
  /** Concrete value for fill / select (resolved with the run prefix at run time). */
  value?: (runPrefix: string) => string;
}

const a = (x: ActionDef): ActionDef => x;

export function contactCreateCatalog(): ActionDef[] {
  return [
    a({ id: 'open', kind: 'open-dialog', target: 'New Contact', mutate: false, heuristic: 'CRUD: create' }),
    a({
      id: 'ln-valid',
      kind: 'fill',
      target: 'Last Name',
      valueClass: 'valid-unique',
      mutate: false,
      heuristic: 'CRUD: create',
      value: (p) => `${p}-x${Math.random().toString(36).slice(2, 6)}`,
    }),
    a({
      id: 'ln-81',
      kind: 'fill',
      target: 'Last Name',
      valueClass: 'max+1 (81 chars)',
      mutate: false,
      heuristic: 'boundaries',
      value: (p) => `${p}-`.padEnd(81, 'x'),
    }),
    a({
      id: 'ln-special',
      kind: 'fill',
      target: 'Last Name',
      valueClass: 'special-chars',
      mutate: false,
      heuristic: 'boundaries & formats',
      value: (p) => `${p}-Ä'ß<&>`,
    }),
    a({
      id: 'ln-clear',
      kind: 'clear',
      target: 'Last Name',
      valueClass: 'empty',
      mutate: false,
      heuristic: 'boundaries: required',
    }),
    a({
      id: 'email-invalid',
      kind: 'fill',
      target: 'Email',
      valueClass: 'invalid-email',
      mutate: false,
      heuristic: 'formats',
      value: () => 'not-an-email',
    }),
    a({
      id: 'email-valid',
      kind: 'fill',
      target: 'Email',
      valueClass: 'valid-email',
      mutate: false,
      heuristic: 'formats',
      value: (p) => `qa+${p.toLowerCase()}@example.invalid`,
    }),
    a({
      id: 'phone-9',
      kind: 'fill',
      target: 'Phone',
      valueClass: '9 digits',
      mutate: false,
      heuristic: 'boundaries',
      value: () => '555123456',
    }),
    a({
      id: 'phone-10',
      kind: 'fill',
      target: 'Phone',
      valueClass: '10 digits',
      mutate: false,
      heuristic: 'boundaries',
      value: () => '5551234567',
    }),
    a({
      id: 'phone-letters',
      kind: 'fill',
      target: 'Phone',
      valueClass: 'letters',
      mutate: false,
      heuristic: 'formats',
      value: () => 'abcdefghij',
    }),
    a({
      id: 'title-unapproved',
      kind: 'fill',
      target: 'Title',
      valueClass: 'value outside the approved list',
      mutate: false,
      heuristic: 'boundaries: lists',
      value: () => 'QA Explorer',
    }),
    a({
      id: 'lead-web',
      kind: 'select',
      target: 'Lead Source',
      valueClass: 'Web',
      mutate: false,
      heuristic: 'automation side effects: Web needs Phone',
      value: () => 'Web',
    }),
    a({ id: 'tab', kind: 'tab-key', mutate: false, heuristic: 'interruptions: keyboard' }),
    a({ id: 'save', kind: 'save-attempt', target: 'Save', mutate: true, heuristic: 'CRUD: create (rules enforced?)' }),
    a({ id: 'cancel', kind: 'cancel', target: 'Cancel', mutate: false, heuristic: 'interruptions: cancel mid-edit' }),
    a({ id: 'escape', kind: 'escape', mutate: false, heuristic: 'interruptions: Escape' }),
  ];
}

/** Heuristic weight per action kind (evidence gain prior). */
export const KIND_WEIGHT: Record<ExplorationAction['kind'], number> = {
  'open-page': 1,
  'open-dialog': 2,
  'open-tab': 1,
  fill: 3,
  select: 3,
  clear: 3,
  'tab-key': 1,
  cancel: 1,
  escape: 1,
  'save-attempt': 4,
};
