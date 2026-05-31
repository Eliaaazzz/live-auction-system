// src/lib/api.test.js
//
// Tests for the REST client error handling — especially the 401 →
// handleAuthFailure path added in PR #51.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError, api } from './api.js';
import { clearSession } from './auth.js';

const STORAGE_KEY = 'lumen.session';

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
  clearSession();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: 'u1', token: 'test-token', nickname: 'tester' }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ApiError', () => {
  it('captures status + code + message', () => {
    const err = new ApiError(409, 'ERR_BAD_STATE', 'already frozen');
    expect(err.status).toBe(409);
    expect(err.code).toBe('ERR_BAD_STATE');
    expect(err.message).toBe('already frozen');
  });

  it('falls back to "status code" message when none provided', () => {
    const err = new ApiError(500, 'ERR_INTERNAL');
    expect(err.message).toBe('500 ERR_INTERNAL');
  });

  it('handles missing code', () => {
    const err = new ApiError(404);
    expect(err.message).toBe('404');
  });
});

describe('api.getAuction · happy path', () => {
  it('GETs /api/auctions/:id with bearer header', async () => {
    const snap = { status: 'LIVE', currentPriceCents: '12000000' };
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => snap,
    });

    const got = await api.getAuction('auc_demo');
    expect(got).toEqual(snap);
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/auctions/auc_demo',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          Authorization: 'Bearer test-token',
        }),
      }),
    );
  });
});

describe('api.getAuctionStream', () => {
  it('GETs the seller-only stream endpoint with bearer auth', async () => {
    const stream = {
      auctionId: 'auc_demo',
      streamKey: 'stream_demo',
      pushUrl: 'rtmp://ecs.example:1935/live/stream_demo',
      livePlayUrl: 'http://ecs.example:8081/live/stream_demo.m3u8',
    };
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => stream,
    });

    const got = await api.getAuctionStream('auc_demo');
    expect(got).toEqual(stream);
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/auctions/auc_demo/stream',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );
  });
});

describe('401 path triggers handleAuthFailure (PR #51-H4)', () => {
  it('clears cached session AND fires lumen:session-expired event', async () => {
    const sessionExpired = vi.fn();
    window.addEventListener('lumen:session-expired', sessionExpired);

    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ code: 'ERR_AUTH', message: 'expired' }),
    });

    await expect(api.getAuction('auc_demo')).rejects.toBeInstanceOf(ApiError);

    // Session must be wiped
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    // And the global event must have fired
    expect(sessionExpired).toHaveBeenCalledTimes(1);

    window.removeEventListener('lumen:session-expired', sessionExpired);
  });

  it('throws ApiError with the parsed code + message', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ code: 'ERR_AUTH', message: 'token expired' }),
    });

    try {
      await api.getAuction('auc_demo');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect(e.status).toBe(401);
      expect(e.code).toBe('ERR_AUTH');
      expect(e.message).toBe('token expired');
    }
  });

  it('handles 401 with non-JSON body without crashing', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => { throw new Error('not json'); },
      text: async () => 'Unauthorized',
      statusText: 'Unauthorized',
    });

    await expect(api.getAuction('auc_demo')).rejects.toBeInstanceOf(ApiError);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull(); // still cleared
  });
});

describe('Non-401 errors do NOT clear the session', () => {
  it('500 throws ApiError but keeps cached token', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ code: 'ERR_INTERNAL' }),
    });

    await expect(api.getAuction('auc_demo')).rejects.toBeInstanceOf(ApiError);
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it('409 ERR_BAD_STATE keeps session (used by handleFreezeAndStart)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ code: 'ERR_BAD_STATE', message: 'already frozen' }),
    });

    try {
      await api.freeze('auc_demo');
    } catch (e) {
      expect(e.code).toBe('ERR_BAD_STATE');
    }
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });
});

describe('204 No Content returns null', () => {
  it('does not try to JSON-parse a 204 response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => { throw new Error('should not be called'); },
    });

    const got = await api.cancel('auc_demo', {});
    expect(got).toBeNull();
  });
});

describe('draftFacts · AI sidecar health events (T7-3 / issue #70 §4.3)', () => {
  it('dispatches `lumen:ai-sidecar-ok` on success', async () => {
    const okSpy = vi.fn();
    const offlineSpy = vi.fn();
    window.addEventListener('lumen:ai-sidecar-ok', okSpy);
    window.addEventListener('lumen:ai-sidecar-offline', offlineSpy);

    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ facts: [], modelName: 'mock-vlm-T1' }),
    });

    const result = await api.draftFacts({ productId: 'p1', imageUrls: [], title: 't', description: 'd' });
    expect(result.modelName).toBe('mock-vlm-T1');
    expect(okSpy).toHaveBeenCalledTimes(1);
    expect(offlineSpy).not.toHaveBeenCalled();

    window.removeEventListener('lumen:ai-sidecar-ok', okSpy);
    window.removeEventListener('lumen:ai-sidecar-offline', offlineSpy);
  });

  it('dispatches `lumen:ai-sidecar-offline` on 502 + re-throws the ApiError', async () => {
    const okSpy = vi.fn();
    const offlineSpy = vi.fn();
    window.addEventListener('lumen:ai-sidecar-ok', okSpy);
    window.addEventListener('lumen:ai-sidecar-offline', offlineSpy);

    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ code: 'ERR_AI_UNAVAILABLE', message: 'sidecar down' }),
    });

    await expect(api.draftFacts({ productId: 'p1', imageUrls: [], title: 't', description: 'd' }))
      .rejects.toBeInstanceOf(ApiError);

    expect(offlineSpy).toHaveBeenCalledTimes(1);
    expect(offlineSpy.mock.calls[0][0].detail).toEqual({ status: 502, code: 'ERR_AI_UNAVAILABLE' });
    expect(okSpy).not.toHaveBeenCalled();

    window.removeEventListener('lumen:ai-sidecar-ok', okSpy);
    window.removeEventListener('lumen:ai-sidecar-offline', offlineSpy);
  });

  it('dispatches `lumen:ai-sidecar-offline` on network failure too', async () => {
    const offlineSpy = vi.fn();
    window.addEventListener('lumen:ai-sidecar-offline', offlineSpy);

    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));

    await expect(api.draftFacts({ productId: 'p1', imageUrls: [], title: 't', description: 'd' }))
      .rejects.toThrow();

    expect(offlineSpy).toHaveBeenCalledTimes(1);

    window.removeEventListener('lumen:ai-sidecar-offline', offlineSpy);
  });

  it('does NOT dispatch offline event on AbortError (route unmount mid-request)', async () => {
    // Self-review catch: if a user navigates away from AdminVLMFacts
    // while draftFacts is in-flight, fetch throws AbortError. The
    // wrapper must NOT flip the badge to offline — the sidecar is
    // fine, the request was cancelled by us.
    const offlineSpy = vi.fn();
    window.addEventListener('lumen:ai-sidecar-offline', offlineSpy);

    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    vi.spyOn(global, 'fetch').mockRejectedValue(abortErr);

    await expect(api.draftFacts({ productId: 'p1', imageUrls: [], title: 't', description: 'd' }))
      .rejects.toThrow('aborted');

    expect(offlineSpy).not.toHaveBeenCalled();

    window.removeEventListener('lumen:ai-sidecar-offline', offlineSpy);
  });
});
