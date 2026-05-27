// src/lib/format.test.js
//
// Money formatting must work on string-cents (blueprint P1). Never parseFloat.

import { describe, it, expect } from 'vitest';
import { formatCentsCNY, addCentsStr, fmtRemaining } from './format.js';

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
