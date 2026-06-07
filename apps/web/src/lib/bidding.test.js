// src/lib/bidding.test.js
import { describe, it, expect } from 'vitest';
import { suggestStepCents } from './bidding.js';

describe('suggestStepCents (起拍价 → 建议最低加价梯度)', () => {
  it('scales the suggested step with the starting price (~1-5%)', () => {
    expect(suggestStepCents('5000')).toBe('500');           // ¥50 → ¥5
    expect(suggestStepCents('20000')).toBe('1000');         // ¥200 → ¥10
    expect(suggestStepCents('80000')).toBe('2000');         // ¥800 → ¥20
    expect(suggestStepCents('300000')).toBe('5000');        // ¥3,000 → ¥50
    expect(suggestStepCents('800000')).toBe('10000');       // ¥8,000 → ¥100
    expect(suggestStepCents('3000000')).toBe('50000');      // ¥30,000 → ¥500
    expect(suggestStepCents('8000000')).toBe('100000');     // ¥80,000 → ¥1,000
    expect(suggestStepCents('12000000')).toBe('200000');    // ¥120,000 → ¥2,000
    expect(suggestStepCents('80000000')).toBe('500000');    // ¥800,000 → ¥5,000
    expect(suggestStepCents('200000000')).toBe('1000000');  // ¥2,000,000 → ¥10,000
  });

  it('treats ladder boundaries as upper-exclusive', () => {
    expect(suggestStepCents('9999')).toBe('500');     // ¥99.99 → ¥5
    expect(suggestStepCents('10000')).toBe('1000');   // ¥100 exactly → ¥10
    expect(suggestStepCents('100000000')).toBe('1000000'); // ¥1,000,000 exactly → top tier
  });

  it('returns null on zero / negative / malformed input', () => {
    expect(suggestStepCents('0')).toBeNull();
    expect(suggestStepCents('-100')).toBeNull();
    expect(suggestStepCents('abc')).toBeNull();
    expect(suggestStepCents('')).toBeNull();
  });
});
