// src/lib/types.test.js
//
// Contract test for WS error-code exposure.

import { describe, it, expect } from 'vitest'
import { BidErrorCode, bidRejectCopy } from './types.js'

describe('bidRejectCopy', () => {
  it('maps all error codes to non-empty user-facing copy', () => {
    const codes = Object.values(BidErrorCode);
    expect(Object.keys(bidRejectCopy).length).toBe(codes.length);
    codes.forEach((code) => {
      expect(bidRejectCopy[code]).toEqual(expect.any(String));
      expect(bidRejectCopy[code].length).toBeGreaterThan(0);
    });
  });

  it('has exactly the same keys as BidErrorCode values', () => {
    const codeSet = new Set(Object.values(BidErrorCode));
    const copyKeys = Object.keys(bidRejectCopy);
    expect(copyKeys.every((k) => codeSet.has(k))).toBe(true);
  });

  it('maps ERR_RATE_LIMITED to user-facing copy', () => {
    expect(bidRejectCopy[BidErrorCode.ERR_RATE_LIMITED]).toBe('操作过快，请稍后再试')
  })

  it('contains the new rate-limit constant in the exported enum', () => {
    expect(BidErrorCode.ERR_RATE_LIMITED).toBe('ERR_RATE_LIMITED')
  })

  it('preserves contract-facing copy for known rejection codes', () => {
    expect(bidRejectCopy[BidErrorCode.ERR_NOT_LIVE]).toBe('本场已结束 · 无法继续出价')
    expect(bidRejectCopy[BidErrorCode.ERR_AFTER_END]).toBe('已过截止时间')
    expect(bidRejectCopy[BidErrorCode.ERR_TOO_LOW]).toBe('出价低于最低加价或超过上限')
    expect(bidRejectCopy[BidErrorCode.ERR_NOT_ALLOWED]).toBe('当前账号不能出价此场')
  })
})
