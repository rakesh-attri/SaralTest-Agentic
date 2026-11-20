import { describe, expect, it } from 'vitest';
import { findRefs, normalizeText, sectionize, sha256 } from './sections.js';

describe('sectionize', () => {
  it('splits a markdown story into description, numbered ACs with Given/When/Then, and labelled blocks', () => {
    const md = [
      '# Story',
      '**Summary:** Agents can log calls',
      '',
      'As an Agent I want to log a call so that history is kept.',
      '',
      '**Acceptance criteria**',
      '',
      'AC1 – Log from record',
      'Given I view a Case',
      'When I click Log a Call',
      '',
      'Then a Task is created',
      '',
      'AC 2: Subject required',
      'Given I log a call without Subject',
      'Then an error is shown',
      '',
      '**Out of scope:** Email logging.',
    ].join('\r\n');
    const s = sectionize(md);
    const refs = s.map((x) => `${x.ref}:${x.kind}`);
    expect(refs).toEqual(['S1:summary', 'S2:text', 'AC1:ac', 'AC2:ac', 'S3:out-of-scope']);
    expect(s[2]?.text).toContain('Then a Task is created'); // continues across the blank line
    expect(s[4]?.text).toBe('Email logging.');
  });

  it('keeps wrapped table rows whole and maps id prefixes to kinds', () => {
    const pdfText = [
      'Order Rules',
      'Document ID: DOC-1 · Version 2',
      '3. Business rules',
      'ID Rule',
      'OR-01 Every Order needs a Customer.',
      'OR-02 Quantity must be between 1 and',
      '999.',
      '4. Non-functional requirements',
      'NFR-01: Page loads in 2 seconds.',
      '5. Assumptions',
      'A-01: Users are internal. A-02: Catalog is synced nightly.',
    ].join('\n');
    const s = sectionize(pdfText);
    const byRef = Object.fromEntries(s.map((x) => [x.ref, x]));
    expect(byRef['OR-02']?.text).toBe('OR-02 Quantity must be between 1 and\n999.');
    expect(byRef['OR-01']?.kind).toBe('rule');
    expect(byRef['OR-01']?.heading).toBe('Business rules');
    expect(byRef['NFR-01']?.kind).toBe('nfr');
    expect(byRef['A-01']?.kind).toBe('assumption');
    expect(byRef['A-02']?.text).toBe('A-02: Catalog is synced nightly.');
  });

  it('does not treat numbered steps as headings and de-duplicates repeated refs', () => {
    const s = sectionize('## Steps\n1. Open the Account named \'X\'\n2. Leave the field empty\n\nAC1 a\nAC1 b');
    expect(s.map((x) => x.ref)).toEqual(['S1', 'AC1', 'AC1#2']);
    expect(s[0]?.text).toContain('2. Leave the field empty');
  });

  it('finds refs and hashes normalized text deterministically', () => {
    expect(findRefs('Covers AC 3, BR-04 and NFR-01; see AC-7').sort()).toEqual(['AC3', 'AC7', 'BR-04', 'NFR-01']);
    expect(sha256(normalizeText('a\r\nb  \n\n\n\nc'))).toBe(sha256('a\nb\n\nc'));
  });
});
