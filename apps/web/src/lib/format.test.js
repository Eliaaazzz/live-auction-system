// src/lib/format.test.js
//
// Money formatting must work on string-cents (blueprint P1). Never parseFloat.

import { describe, it, expect } from 'vitest';
import { formatCentsCNY, formatCentsCompact, addCentsStr, fmtRemaining } from './format.js';

describe('formatCentsCNY', () => {
  it('formats a small amount with leading zero fen', () => {
    expect(formatCentsCNY('5')).toBe('¥0.05');
    expect(formatCentsCNY('99')).toBe('¥0.99');
  });

  it('formats yuan with comma grouping', () => {
    expect(formatCentsCNY('100')).toBe('¥1.00');
    expect(formatCentsCNY('123456')).toBe('¥1,234.56');
    expect(formatCentsCNY('12880000')).toBe('¥128,800.00');
  });

  it('handles negative amounts', () => {
    expect(formatCentsCNY('-12880000')).toBe('-¥128,800.00');
  });

  it('handles BigInt-range values (9e15+) without precision loss', () => {
    expect(formatCentsCNY('9000000000000000')).toBe('¥90,000,000,000,000.00');
    expect(formatCentsCNY('9007199254740991')).toBe('¥90,071,992,547,409.91'); // MaxSafeInteger
  });

  it('accepts numeric input (legacy path)', () => {
    expect(formatCentsCNY(12880000)).toBe('¥128,800.00');
  });

  it('handles 0', () => {
    expect(formatCentsCNY('0')).toBe('¥0.00');
  });

  it('degrades malformed input to ¥0.00 (never renders garbage)', () => {
    expect(formatCentsCNY(undefined)).toBe('¥0.00');
    expect(formatCentsCNY(null)).toBe('¥0.00');
    expect(formatCentsCNY('')).toBe('¥0.00');
    expect(formatCentsCNY('abc')).toBe('¥0.00');
  });
});

describe('formatCentsCompact', () => {
  it('falls back to the exact format below 1万元', () => {
    expect(formatCentsCompact('0')).toBe('¥0.00');
    expect(formatCentsCompact('123456')).toBe('¥1,234.56');
    expect(formatCentsCompact('999999')).toBe('¥9,999.99'); // just under 1万元
  });

  it('uses 万 between 1万元 and 1亿元, trimming trailing zeros', () => {
    expect(formatCentsCompact('1000000')).toBe('¥1万');      // exactly 1万元
    expect(formatCentsCompact('12500000')).toBe('¥12.5万');  // 12.50万 → 12.5万
    expect(formatCentsCompact('12880000')).toBe('¥12.88万'); // the demo price
  });

  it('uses 亿 at or above 1亿元', () => {
    expect(formatCentsCompact('10000000000')).toBe('¥1亿');   // exactly 1亿元
    expect(formatCentsCompact('12900000000')).toBe('¥1.29亿');
  });

  it('preserves the sign and groups the whole part', () => {
    expect(formatCentsCompact('-12880000')).toBe('-¥12.88万');
    expect(formatCentsCompact('99990000000')).toBe('¥9.99亿');
  });

  it('survives BigInt-range cents without precision loss', () => {
    expect(formatCentsCompact('9007199254740991')).toBe('¥900,719.92亿');
  });
});

describe('addCentsStr', () => {
  it('adds two cent strings via BigInt', () => {
    expect(addCentsStr('100', '50')).toBe('150');
    expect(addCentsStr('12880000', '500000')).toBe('13380000');
  });

  it('preserves precision at large magnitudes', () => {
    expect(addCentsStr('9000000000000000', '1')).toBe('9000000000000001');
  });
});

describe('fmtRemaining', () => {
  it('formats whole minutes', () => {
    expect(fmtRemaining(60_000)).toBe('01:00');
  });

  it('formats sub-minute durations', () => {
    expect(fmtRemaining(5_000)).toBe('00:05');
  });

  it('returns 00:00 once expired', () => {
    expect(fmtRemaining(0)).toBe('00:00');
    expect(fmtRemaining(-1000)).toBe('00:00');
  });

  it('rounds up partial seconds (so 0.5s shows 00:01 not 00:00)', () => {
    expect(fmtRemaining(500)).toBe('00:01');
  });

  it('formats double-digit minutes correctly', () => {
    expect(fmtRemaining(15 * 60_000)).toBe('15:00');
  });
});
