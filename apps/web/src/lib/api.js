// src/lib/api.js
//
// REST client — pairs with the Lumen backend's `/api/*` handlers
// (apps/lumen/internal/server/api.go).
//
// Authoritative endpoint list: project-blueprint.md §4.1.
// Auth: JWT bearer minted by POST /api/dev-login. See lib/auth.js.
//
// IMPORTANT: backend uses `/api/...` (NOT `/api/v1/...`). The Vite proxy
// in vite.config.js forwards `/api/*` to VITE_API_BASE.

import { currentToken, handleAuthFailure } from './auth.js';

const API_BASE = '/api';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || `${status} ${code || ''}`.trim());
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = 'GET', body, signal, auth = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth) {
    const tok = currentToken();
    if (tok) headers.Authorization = `Bearer ${tok}`;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!res.ok) {
    // 401 = JWT expired / revoked / JWT_SECRET rotated on the server.
    // Clear the cached session + emit 'lumen:session-expired' so routes
    // can react (re-login modal / page reload / etc.). The current REST
    // call still throws an ApiError so the caller sees the failure;
    // recovery is the route component's call (see lib/auth.js).
    //
    // Why not auto-retry inline: an auto-retry path needs to either
    // (a) mint a new token via ensureSession and resubmit — but that
    // doubles the server load on storm 401s, or (b) wait for a fresh
    // session via the event — which couples this layer to UI flow.
    // Keeping the path observable + caller-driven is simpler.
    if (res.status === 401 && auth) {
      handleAuthFailure();
    }
    // Backend convention: { code: "ERR_...", message?: "..." } on error.
    let code, message;
    try {
      const j = await res.json();
      code = j.code; message = j.message;
    } catch {
      message = await res.text().catch(() => res.statusText);
    }
    throw new ApiError(res.status, code, message);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ─── Auctions ────────────────────────────────────────────────────
export const api = {
  // ---------- Discovery / read ----------
  /**
   * NOTE: backend does not yet ship list/filter (P1). The admin Orders page
   * uses this; gate behind the mock flag (VITE_USE_MOCK_DATA=true) until
   * the backend lands `GET /api/auctions?status=...`.
   */
  listAuctions: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request(`/auctions${q ? `?${q}` : ''}`);
  },

  /** Snapshot fallback used by LiveRoomRoute before the WS opens. */
  getAuction: (id) => request(`/auctions/${id}`),

  /** Top-N accepted bids (Redis ZSET). */
  getLeaderboard: (id, n = 10) => request(`/auctions/${id}/leaderboard?n=${n}`),

  /** Stub today (PR #34 fills the timeline + hash chain). */
  getEvidence: (id) => request(`/auctions/${id}/evidence`),

  /** Cheap counter — sometimes useful in admin. */
  getEventsCount: (id) => request(`/auctions/${id}/events-count`),

  // ---------- Admin lifecycle ----------
  /** Seller: create product (used by Publish form step 1). */
  createProduct: (payload) => request('/products', { method: 'POST', body: payload }),

  /**
   * Seller: publish auction.
   *   payload = { productId, rules: { startCents, stepCents, durationMs,
   *               maxExtensions, antiSnipeWindowMs, capCents?, reserveCents? } }
   */
  createDraft: (payload) => request('/auctions', { method: 'POST', body: payload }),

  /**
   * Seller: DRAFT → SCHEDULED.
   * Backend requires `factsConfirmed=true` (set by VLM flow).
   * Returns `{ code: 'OK_FROZEN' | 'ERR_FACTS_NOT_CONFIRMED' | 'ERR_BAD_STATE' }`.
   */
  freeze: (id) => request(`/auctions/${id}/freeze`, { method: 'POST' }),

  /**
   * Seller: SCHEDULED → LIVE.
   * Returns `{ code: 'OK_LIVE', endAtMs }`.
   *
   * The design's old `api.schedule(id, when)` had no backend equivalent —
   * we don't support a future-dated start today. Seller publishes, freezes,
   * then starts manually. Wire the Publish form's "scheduled at" picker
   * to a client-side timer that calls startLive() at the chosen instant.
   */
  startLive: (id, { durationMs } = {}) =>
    request(`/auctions/${id}/start`, { method: 'POST', body: durationMs ? { durationMs } : undefined }),

  /**
   * Seller / admin: any non-terminal → CANCELLED.
   * Returns `{ code: 'OK_CANCELLED' | 'ERR_ALREADY_TERMINAL' | 'ERR_NOT_ALLOWED' }`.
   * UI MUST 2-step confirm (see AdminCancelModal — type current price).
   */
  cancel: (id, payload) => request(`/auctions/${id}/cancel`, { method: 'POST', body: payload }),

  // ---------- VLM facts (ai-events.md) ----------
  /**
   * One-shot VLM facts draft. Returns:
   *   { facts: [{ field, value, confidence, highRisk }],
   *     highRiskFieldsDisclaimer, modelName }
   *
   * T1 ships a mock (`modelName: 'mock-vlm-T1'`); T7 swaps in real Doubao.
   *
   * The previous design assumed `GET /vlm-facts` + per-fact PATCH for
   * seller edits. Our backend doesn't have those — seller edits are kept
   * client-side and persisted on `freeze`, which atomically snapshots the
   * confirmed facts as part of the DRAFT→SCHEDULED transition.
   */
  draftFacts: ({ productId, imageUrls, title, description }) =>
    request('/facts/draft', {
      method: 'POST',
      body: { productId, imageUrls, title, description },
    }),

  // ---------- Evidence ----------
  /**
   * The design's `verifyChain()` POST does not exist on the backend.
   * `getEvidence()` already includes `chainVerified` (server recomputes
   * the HMAC chain on read) + `hashBreakAtSeq` when broken. Just read
   * those fields.
   */
};

export default api;
