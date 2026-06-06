// src/lib/bidrules.test.js
import { describe, it, expect } from 'vitest';
import { niceRoundCents, suggestStepCents } from './bidrules.js';

describe('niceRoundCents', () => {
  it('rounds up to the nearest 1/2/5 × 10^k', () => {
    expect(niceRoundCents(0n)).toBe(1n);
    expect(niceRoundCents(1n)).toBe(1n);
    expect(niceRoundCents(3n)).toBe(5n);
    expect(niceRoundCents(6n)).toBe(10n);
    expect(niceRoundCents(120000n)).toBe(200000n);
    expect(niceRoundCents(10000n)).toBe(10000n); // exact power stays put
  });

  it('accepts string / numeric input and is defensive on garbage', () => {
    expect(niceRoundCents('120000')).toBe(200000n);
    expect(niceRoundCents('not-a-number')).toBe(0n);
  });
});

describe('suggestStepCents', () => {
  it('scales ~1% of start, snapped to a nice increment', () => {
    expect(suggestStepCents('12000000')).toBe('200000');   // ¥120,000 → ¥2,000
    expect(suggestStepCents('1000000')).toBe('10000');      // ¥10,000  → ¥100
    expect(suggestStepCents('100000000')).toBe('1000000');  // ¥1,000,000 → ¥10,000
  });

  it('floors at ¥1 (100 cents) for tiny starts', () => {
    expect(suggestStepCents('500')).toBe('100'); // ¥5 start → ¥1 step floor
  });

  it('returns 0 for a non-positive or unparsable start', () => {
    expect(suggestStepCents('0')).toBe('0');
    expect(suggestStepCents('-100')).toBe('0');
    expect(suggestStepCents('abc')).toBe('0');
  });
});
