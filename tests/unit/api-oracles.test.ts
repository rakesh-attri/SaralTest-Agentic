import { describe, expect, it } from 'vitest';
import { soqlValue } from '../support/api.js';

// qa-prod run-p5-live-8, TC-050: soqlValue refused 'Account.Name' (the generator compares parents by name).
describe('soqlValue', () => {
  const sf = (rows: Record<string, unknown>[]) => {
    const seen: string[] = [];
    return {
      seen,
      query: <T>(soql: string): Promise<T[]> => {
        seen.push(soql);
        return Promise.resolve(rows as T[]);
      },
    };
  };

  it('reads a field and a parent field through its relationship', async () => {
    const a = sf([{ Email: 'x@example.invalid', Account: { Name: 'QA-acme' } }]);
    expect(await soqlValue(a, 'Contact', '003000000000001AAA', 'Email')).toBe('x@example.invalid');
    expect(await soqlValue(a, 'Contact', '003000000000001AAA', 'Account.Name')).toBe('QA-acme');
    expect(a.seen[1]).toBe("SELECT Account.Name FROM Contact WHERE Id = '003000000000001AAA'");
    expect(await soqlValue(sf([{ Account: null }]), 'Contact', '003000000000001AAA', 'Account.Name')).toBeNull();
    expect(await soqlValue(sf([]), 'Contact', '003000000000001AAA', 'Email')).toBeUndefined();
  });

  it('refuses anything but API names (no SOQL injection through the field)', async () => {
    const a = sf([]);
    await expect(soqlValue(a, 'Contact', 'x', 'Account.Owner.Name')).rejects.toThrow(/not a field or parent field/);
    await expect(soqlValue(a, 'Contact', 'x', 'Name FROM User--')).rejects.toThrow(/not an API name/);
    expect(a.seen).toEqual([]);
  });
});
