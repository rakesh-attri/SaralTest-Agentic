import { describe, expect, it } from 'vitest';

describe('tooling smoke', () => {
  it('runs vitest under strict TS', () => {
    const n: number = 1;
    expect(n).toBe(1);
  });
});
