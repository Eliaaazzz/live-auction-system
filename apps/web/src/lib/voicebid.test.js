// src/lib/voicebid.test.js
import { describe, it, expect } from 'vitest';
import { parseBidUtterance, parseChineseNumber, parseAmountYuan } from './voicebid.js';

describe('parseChineseNumber', () => {
  const cases = [
    ['五千', 5000],
    ['十三万', 130000],
    ['十三万八千', 138000],
    ['两千五', 2500],
    ['一万二', 12000],
    ['十', 10],
    ['十五', 15],
    ['一百二十', 120],
    ['三万', 30000],
    ['一亿', 100000000],
  ];
  for (const [s, n] of cases) {
    it(`${s} → ${n}`, () => expect(parseChineseNumber(s)).toBe(n));
  }
  it('returns null for non-CN', () => {
    expect(parseChineseNumber('abc')).toBeNull();
    expect(parseChineseNumber('')).toBeNull();
  });
});

describe('parseAmountYuan', () => {
  it('arabic', () => expect(parseAmountYuan('5000')).toBe(5000));
  it('arabic + 万', () => expect(parseAmountYuan('13万')).toBe(130000));
  it('decimal + 万', () => expect(parseAmountYuan('1.5万')).toBe(15000));
  it('arabic + 千', () => expect(parseAmountYuan('5千')).toBe(5000));
  it('embedded in phrase', () => expect(parseAmountYuan('加价五千块')).toBe(5000));
  it('none', () => expect(parseAmountYuan('加价')).toBeNull());
});

describe('parseBidUtterance', () => {
  const ctx = { currentCents: '12880000', stepCents: '500000' }; // ¥128,800 / step ¥5,000

  it('加价五千 → current + 500000', () => {
    const r = parseBidUtterance('加价五千', ctx);
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('relative');
    expect(r.amountCents).toBe('13380000'); // 12880000 + 5000*100
  });

  it('出价十三万八 → absolute 13800000', () => {
    const r = parseBidUtterance('出价十三万八', ctx);
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('absolute');
    expect(r.amountCents).toBe('13800000'); // 138000 yuan * 100
  });

  it('加三档 → current + 3*step', () => {
    const r = parseBidUtterance('加三档', ctx);
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('step');
    expect(r.amountCents).toBe('14380000'); // 12880000 + 3*500000
  });

  it('加档 (no number) → current + 1 step', () => {
    const r = parseBidUtterance('加一档', ctx);
    expect(r.amountCents).toBe('13380000');
  });

  it('加价 (no number) → current + 1 step', () => {
    const r = parseBidUtterance('加价', ctx);
    expect(r.ok).toBe(true);
    expect(r.amountCents).toBe('13380000');
  });

  it('bare 出价 → +1 step', () => {
    const r = parseBidUtterance('出价', ctx);
    expect(r.ok).toBe(true);
    expect(r.amountCents).toBe('13380000');
  });

  it('arabic relative: 加 8000 → +800000', () => {
    const r = parseBidUtterance('加8000', ctx);
    expect(r.amountCents).toBe('13680000');
  });

  it('bare big number → absolute', () => {
    const r = parseBidUtterance('十五万', ctx);
    expect(r.kind).toBe('absolute');
    expect(r.amountCents).toBe('15000000');
  });

  it('bare small number below current → relative raise', () => {
    const r = parseBidUtterance('五千', ctx);
    expect(r.kind).toBe('relative');
    expect(r.amountCents).toBe('13380000');
  });

  it('rejects a too-low absolute (≤ current)', () => {
    const r = parseBidUtterance('出价十万', ctx); // 100000 yuan = 10000000 < current
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/不高于当前价/);
  });

  it('rejects gibberish with a helpful hint', () => {
    const r = parseBidUtterance('今天天气不错', ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/没听懂/);
  });

  it('empty transcript', () => {
    expect(parseBidUtterance('', ctx).ok).toBe(false);
    expect(parseBidUtterance('  ', ctx).reason).toMatch(/没听清/);
  });

  it('step form with no step configured is rejected', () => {
    const r = parseBidUtterance('加三档', { currentCents: '100', stepCents: '0' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/未设加价阶梯/);
  });

  it('ignores whitespace in the transcript', () => {
    const r = parseBidUtterance('  加价  五千  ', ctx);
    expect(r.ok).toBe(true);
    expect(r.amountCents).toBe('13380000');
  });
});
