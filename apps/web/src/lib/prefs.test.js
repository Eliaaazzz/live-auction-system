// src/lib/prefs.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { isFollowing, setFollowing, hasJoined, setJoined } from './prefs.js';

describe('prefs · follow persistence', () => {
  beforeEach(() => window.localStorage.clear());

  it('defaults to not-following', () => {
    expect(isFollowing('lumen-house')).toBe(false);
  });

  it('persists follow on then off, keyed per seller', () => {
    setFollowing('lumen-house', true);
    expect(isFollowing('lumen-house')).toBe(true);
    expect(isFollowing('other-house')).toBe(false); // isolated per seller
    setFollowing('lumen-house', false);
    expect(isFollowing('lumen-house')).toBe(false);
  });
});

describe('prefs · participation persistence', () => {
  beforeEach(() => window.localStorage.clear());

  it('defaults to not-joined and persists per auction', () => {
    expect(hasJoined('auc_demo')).toBe(false);
    setJoined('auc_demo', true);
    expect(hasJoined('auc_demo')).toBe(true);
    expect(hasJoined('auc_other')).toBe(false);
  });
});
