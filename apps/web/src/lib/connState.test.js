import { describe, it, expect } from 'vitest';
import { normalizeSyncStartSeq, makeSyncGap } from './connState.js';

describe('normalizeSyncStartSeq', () => {
  it('keeps positive integers', () => {
    expect(normalizeSyncStartSeq(12)).toBe(12);
    expect(normalizeSyncStartSeq(12n)).toBe(12);
    expect(normalizeSyncStartSeq(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(normalizeSyncStartSeq(42n)).toBe(42);
    expect(normalizeSyncStartSeq('007')).toBe(7);
    expect(normalizeSyncStartSeq('18')).toBe(18);
  });

  it('normalizes invalid or non-positive values to 0', () => {
    expect(normalizeSyncStartSeq(0)).toBe(0);
    expect(normalizeSyncStartSeq(-5)).toBe(0);
    expect(normalizeSyncStartSeq(-1n)).toBe(0);
    expect(normalizeSyncStartSeq(0n)).toBe(0);
    expect(normalizeSyncStartSeq(null)).toBe(0);
    expect(normalizeSyncStartSeq('-1')).toBe(0);
    expect(normalizeSyncStartSeq(new Number(12))).toBe(0);
    expect(normalizeSyncStartSeq(Object(false))).toBe(0);
    expect(normalizeSyncStartSeq(Object(12n))).toBe(0);
    expect(normalizeSyncStartSeq(new String('12'))).toBe(0);
    expect(normalizeSyncStartSeq('')).toBe(0);
    expect(normalizeSyncStartSeq({})).toBe(0);
    expect(normalizeSyncStartSeq('abc')).toBe(0);
    expect(normalizeSyncStartSeq('12.0')).toBe(0);
    expect(normalizeSyncStartSeq('+42')).toBe(0);
    expect(normalizeSyncStartSeq('1e3')).toBe(0);
    expect(normalizeSyncStartSeq('  12')).toBe(0);
    expect(normalizeSyncStartSeq(Infinity)).toBe(0);
    expect(normalizeSyncStartSeq(-Infinity)).toBe(0);
    expect(normalizeSyncStartSeq(undefined)).toBe(0);
    expect(normalizeSyncStartSeq(true)).toBe(0);
    expect(normalizeSyncStartSeq(-0)).toBe(0);
    expect(normalizeSyncStartSeq(NaN)).toBe(0);
    expect(normalizeSyncStartSeq('NaN')).toBe(0);
    expect(normalizeSyncStartSeq(Symbol('x'))).toBe(0);
  });

  it('normalizes unsafe-large integer-like values to 0', () => {
    expect(normalizeSyncStartSeq(Number.MAX_SAFE_INTEGER + 1)).toBe(0);
    expect(normalizeSyncStartSeq((BigInt(Number.MAX_SAFE_INTEGER) + 1n))).toBe(0);
    expect(normalizeSyncStartSeq(String(Number.MAX_SAFE_INTEGER + 1))).toBe(0);
  });
});

describe('makeSyncGap', () => {
  it('returns null when no valid sync start exists', () => {
    expect(makeSyncGap(0, 100)).toBeNull();
    expect(makeSyncGap(0n, 100)).toBeNull();
    expect(makeSyncGap(50, 50)).toBeNull();
    expect(makeSyncGap(50, 40)).toBeNull();
    expect(makeSyncGap(50, 50n)).toBeNull();
    expect(makeSyncGap(50n, 40n)).toBeNull();
    expect(makeSyncGap(null, 100)).toBeNull();
    expect(makeSyncGap(10, undefined)).toBeNull();
  });

  it('builds half-open interval when current seq is ahead', () => {
    expect(makeSyncGap(14921, 14998)).toEqual({ from: 14922, to: 14998 });
    expect(makeSyncGap(1n, 2n)).toEqual({ from: 2, to: 2 });
    expect(makeSyncGap(1n, 2)).toEqual({ from: 2, to: 2 });
    expect(makeSyncGap(1, 2n)).toEqual({ from: 2, to: 2 });
  });

  it('accepts numeric-like strings and rejects invalid inputs', () => {
    expect(makeSyncGap('14921', '14922')).toEqual({ from: 14922, to: 14922 });
    expect(makeSyncGap(14921n, 14922n)).toEqual({ from: 14922, to: 14922 });
    expect(makeSyncGap('001', '005')).toEqual({ from: 2, to: 5 });
    expect(makeSyncGap('+1', '2')).toBeNull();
    expect(makeSyncGap('1e3', '1000')).toBeNull();
    expect(makeSyncGap('Infinity', '100')).toBeNull();
    expect(makeSyncGap('100', 'NaN')).toBeNull();
    expect(makeSyncGap('', 5)).toBeNull();
    expect(makeSyncGap('bad', 14922)).toBeNull();
    expect(makeSyncGap('12.0', 100)).toBeNull();
    expect(makeSyncGap(' 12', 100)).toBeNull();
    expect(makeSyncGap('12 ', 100)).toBeNull();
    expect(makeSyncGap(' 12 ', 100)).toBeNull();
    expect(makeSyncGap('001', 5)).toEqual({ from: 2, to: 5 });
    expect(makeSyncGap(12.2, 20)).toBeNull();
  });

  it('rejects boolean inputs as invalid', () => {
    expect(makeSyncGap(true, 100)).toBeNull();
    expect(makeSyncGap(100, false)).toBeNull();
  });

  it('rejects object inputs as invalid', () => {
    expect(makeSyncGap({}, 100)).toBeNull();
    expect(makeSyncGap(100, {})).toBeNull();
    expect(makeSyncGap(new Number(1), 100)).toBeNull();
    expect(makeSyncGap(Object(1), 100)).toBeNull();
    expect(makeSyncGap(new Boolean(true), 100)).toBeNull();
    expect(makeSyncGap(100, Object(false))).toBeNull();
    expect(makeSyncGap(100, new String('2'))).toBeNull();
  });

  it('rejects array inputs as invalid', () => {
    expect(makeSyncGap([], 100)).toBeNull();
    expect(makeSyncGap([42], 100)).toBeNull();
    expect(makeSyncGap(100, [2, 3])).toBeNull();
  });

  it('rejects symbol inputs as invalid', () => {
    expect(makeSyncGap(Symbol('x'), 100)).toBeNull();
    expect(makeSyncGap(100, Symbol('y'))).toBeNull();
  });

  it('rejects unsafe-large integer-like values', () => {
    expect(makeSyncGap(0, 1)).toBeNull();
    expect(makeSyncGap(-1, 2)).toBeNull();
    expect(makeSyncGap(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(makeSyncGap(Number.MAX_SAFE_INTEGER, BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toBeNull();
    expect(makeSyncGap(-1n, 2n)).toBeNull();
    expect(makeSyncGap(String(Number.MAX_SAFE_INTEGER + 1), String(Number.MAX_SAFE_INTEGER + 2))).toBeNull();
  });

  it('rejects NaN/Infinity sync range arguments', () => {
    expect(makeSyncGap(NaN, 100)).toBeNull();
    expect(makeSyncGap(10, NaN)).toBeNull();
    expect(makeSyncGap(Infinity, 1000)).toBeNull();
    expect(makeSyncGap(1000, -Infinity)).toBeNull();
  });

  it('accepts large-but-safe integer boundaries', () => {
    expect(makeSyncGap(Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER)).toEqual({
      from: Number.MAX_SAFE_INTEGER,
      to: Number.MAX_SAFE_INTEGER,
    });
  });
});
