// src/lib/auth.test.js
//
// Tests for the session bootstrap layer (PR #51 wired the 401 path
// + the `lumen:session-expired` global event).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { currentToken, currentUser, clearSession, handleAuthFailure, ensureSession } from './auth.js';

const STORAGE_KEY = 'lumen.session';

// auth.js holds a module-level `_session` cache. Without exposing a reset,
// the most reliable cross-test isolation is to clear storage AND force a
// re-import by reading fresh after writeStorage. Since `_session` is set
// from `writeStorage`, we wipe it with a manual writeStorage(null)
// surrogate — clearSession does exactly that.
beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
  clearSession();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('currentToken / currentUser', () => {
  it('returns null when no session is cached', () => {
    expect(currentToken()).toBeNull();
    expect(currentUser()).toBeNull();
  });

  it('reads from localStorage when no module-cached session', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: 'u1', token: 'tok-abc', nickname: 'A' }));
    expect(currentToken()).toBe('tok-abc');
    expect(currentUser()).toEqual({ userId: 'u1', nickname: 'A' });
  });

  it('handles corrupt localStorage JSON gracefully', () => {
    localStorage.setItem(STORAGE_KEY, '{not valid json');
    expect(currentToken()).toBeNull();
    expect(currentUser()).toBeNull();
  });
});

describe('clearSession + lumen:session-expired event', () => {
  it('removes the storage entry', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: 'u1', token: 't', nickname: 'A' }));
    clearSession();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(currentToken()).toBeNull();
  });

  it('dispatches a `lumen:session-expired` event', () => {
    const spy = vi.fn();
    window.addEventListener('lumen:session-expired', spy);
    clearSession();
    expect(spy).toHaveBeenCalledTimes(1);
    window.removeEventListener('lumen:session-expired', spy);
  });

  it('is idempotent (safe to call after already cleared)', () => {
    clearSession();
    clearSession();  // should NOT throw
    expect(currentToken()).toBeNull();
  });
});

describe('handleAuthFailure (PR #51 wiring)', () => {
  it('clears the session', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: 'u1', token: 't', nickname: 'A' }));
    handleAuthFailure();
    expect(currentToken()).toBeNull();
  });

  it('emits `lumen:session-expired` (route components subscribe to this)', () => {
    const spy = vi.fn();
    window.addEventListener('lumen:session-expired', spy);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: 'u1', token: 't', nickname: 'A' }));
    handleAuthFailure();
    expect(spy).toHaveBeenCalledTimes(1);
    window.removeEventListener('lumen:session-expired', spy);
  });
});

describe('ensureSession', () => {
  it('reuses an existing cached token (no network call)', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: 'u1', token: 'cached-tok', nickname: 'A' }));
    const fetchSpy = vi.spyOn(global, 'fetch');
    const result = await ensureSession('whatever');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.token).toBe('cached-tok');
  });

  it('calls POST /api/dev-login with the nickname and caches the response', async () => {
    const session = { userId: 'u-fari', token: 'fresh-tok', nickname: 'fari' };
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => session,
    });

    const got = await ensureSession('fari');
    expect(got).toEqual(session);
    expect(currentToken()).toBe('fresh-tok');
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/dev-login',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nickname: 'fari' }),
      }),
    );
  });

  it('throws when dev-login responds non-OK', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
    });
    await expect(ensureSession('boom')).rejects.toThrow(/dev-login 503/);
    expect(currentToken()).toBeNull();
  });

  it('defaults nickname to "demo"', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ userId: 'u', token: 't', nickname: 'demo' }),
    });
    await ensureSession();
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/dev-login',
      expect.objectContaining({ body: JSON.stringify({ nickname: 'demo' }) }),
    );
  });
});
