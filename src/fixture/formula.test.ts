import { describe, expect, it } from 'vitest';
import { errorConditionHolds, FormulaError } from './formula.js';

// The three qa-prod rules, verbatim from snapshot …adbb (copied into the fixture metadata as FIXTURE).
const PHONE_10 = 'AND( NOT( ISBLANK( Phone ) ), NOT( REGEX( Phone, "[0-9]{10}" ) ) )';
const PHONE_WEB = 'AND( ISPICKVAL( LeadSource, "Web" ), ISBLANK( Phone ) )';
const TITLE =
  'AND( NOT( ISBLANK( Title ) ),\r\n     CASE( Title, "Account Executive", 1, "Sales Manager", 1, "Director", 1, "VP Sales", 1, 0 ) = 0 )';

describe('fixture formula evaluator (FIXTURE only)', () => {
  it('Phone must be exactly 10 digits: REGEX matches the whole value; blank is allowed', () => {
    expect(errorConditionHolds(PHONE_10, { Phone: '123456789' })).toBe(true);
    expect(errorConditionHolds(PHONE_10, { Phone: '1234567890' })).toBe(false);
    expect(errorConditionHolds(PHONE_10, { Phone: '12345678901' })).toBe(true);
    expect(errorConditionHolds(PHONE_10, { Phone: '12345-7890' })).toBe(true);
    expect(errorConditionHolds(PHONE_10, {})).toBe(false);
  });

  it('Phone required when Lead Source is Web (ISPICKVAL + ISBLANK)', () => {
    expect(errorConditionHolds(PHONE_WEB, { LeadSource: 'Web' })).toBe(true);
    expect(errorConditionHolds(PHONE_WEB, { LeadSource: 'Web', Phone: '5551234567' })).toBe(false);
    expect(errorConditionHolds(PHONE_WEB, { LeadSource: 'Other' })).toBe(false);
    expect(errorConditionHolds(PHONE_WEB, { leadsource: 'Web', phone: null })).toBe(true); // field names are case-insensitive
  });

  it('Title must be an approved title (CASE with default, = comparison, CRLF whitespace)', () => {
    for (const t of ['Account Executive', 'Sales Manager', 'Director', 'VP Sales'])
      expect(errorConditionHolds(TITLE, { Title: t })).toBe(false);
    expect(errorConditionHolds(TITLE, { Title: 'Intern' })).toBe(true);
    expect(errorConditionHolds(TITLE, { Title: '' })).toBe(false);
  });

  it('the fixture rule literal "\\d{10}" and operators work; unsupported functions fail loudly', () => {
    expect(errorConditionHolds('NOT(REGEX(Phone, "\\d{10}"))', { Phone: '123' })).toBe(true);
    expect(errorConditionHolds('LEN(Name) > 3 && BEGINS(Name, "QA")', { Name: 'QA-1' })).toBe(true);
    expect(errorConditionHolds('IF(TEXT(Industry) <> "Tech", true, false)', { Industry: 'Tech' })).toBe(false);
    expect(() => errorConditionHolds('PRIORVALUE(Phone) = ""', {})).toThrow(FormulaError);
    expect(() => errorConditionHolds('AND(Phone', {})).toThrow(FormulaError);
  });
});
