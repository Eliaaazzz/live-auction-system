import { describe, it, expect } from 'vitest';
import { resolveAuctionMode } from './auctionMode.js';

describe('resolveAuctionMode', () => {
  it('normalizes raw strings with spaces and case', () => {
    expect(resolveAuctionMode('  Second_Price  ')).toBe('second_price');
    expect(resolveAuctionMode(' VICKREY ')).toBe('second_price');
    expect(resolveAuctionMode(' second-price ')).toBe('second_price');
    expect(resolveAuctionMode('first price')).toBe('first_price');
  });

  it('prefers auctionMode over mode when both exist', () => {
    expect(resolveAuctionMode({ auctionMode: 'vickrey', mode: 'second' })).toBe('second_price');
    expect(resolveAuctionMode({ auctionMode: 'ENGLISH', mode: 'vickrey' })).toBe('first_price');
  });

  it('normalizes legacy aliases', () => {
    expect(resolveAuctionMode('ENGLISH')).toBe('first_price');
    expect(resolveAuctionMode({ mode: 'second' })).toBe('second_price');
    expect(resolveAuctionMode({ mode: 'secondprice' })).toBe('second_price');
    expect(resolveAuctionMode({ mode: 'first' })).toBe('first_price');
    expect(resolveAuctionMode({ mode: 'firstprice' })).toBe('first_price');
  });

  it('normalizes vickrey to second_price', () => {
    expect(resolveAuctionMode({ mode: 'vickrey' })).toBe('second_price');
  });

  it('returns null for nullish/empty inputs', () => {
    expect(resolveAuctionMode(undefined)).toBeNull();
    expect(resolveAuctionMode({ mode: '' })).toBeNull();
    expect(resolveAuctionMode({})).toBeNull();
  });
});
