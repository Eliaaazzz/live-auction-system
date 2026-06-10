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

async function request(path, { method = 'GET', body, signal, auth = true, token, seat = '' } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth) {
    // An explicit `token` (a Showcase seat's own JWT) wins over the default-seat
    // session, so 买家A/买家B bid under their OWN identity — not whichever seat
    // logged in last. Omitted (single-room /m + /admin) → the device token.
    const tok = token ?? currentToken();
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
      handleAuthFailure(seat);
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
   * Backed by backend `GET /api/auctions`.
   * `status` can filter exact state (`LIVE`, `SCHEDULED`, `DRAFT`, `SOLD`, ...).
   */
  listAuctions: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request(`/auctions${q ? `?${q}` : ''}`);
  },

  /** Snapshot fallback used by LiveRoomRoute before the WS opens. */
  getAuction: (id) => request(`/auctions/${id}`),

  /** Seller/owner: live-stream descriptor for 开始直播. Returns { streamKey, pushUrl, livePlayUrl }. */
  getStream: (id) => request(`/auctions/${id}/stream`),

  /**
   * Seller/owner: upload a prepared clip (multipart, ≤64MB, mp4/webm) to drive
   * this auction's live feed without OBS. Points live_play_url at the file, so
   * the room hands it to every viewer and auto-loops it. Returns { livePlayUrl }.
   * Multipart: no JSON content-type header (browser sets the boundary).
   */
  uploadStreamVideo: async (id, file) => {
    const form = new FormData();
    form.append('file', file);
    const headers = {};
    const tok = currentToken();
    if (tok) headers.Authorization = `Bearer ${tok}`;
    const res = await fetch(`${API_BASE}/auctions/${id}/stream/video`, { method: 'POST', headers, body: form });
    if (!res.ok) {
      if (res.status === 401) handleAuthFailure();
      let code, message;
      try {
        const j = await res.json();
        code = j.code; message = j.error || j.message;
      } catch {
        message = res.statusText;
      }
      throw new ApiError(res.status, code, message);
    }
    return res.json();
  },

  /** Top-N accepted bids (Redis ZSET). */
  getLeaderboard: (id, n = 10) => request(`/auctions/${id}/leaderboard?n=${n}`),

  /**
   * #261-7/8/10: room social channel — comments (弹幕) / gifts / like toggles.
   * payload = { kind: 'comment'|'gift'|'like', text?, giftId?, giftName?,
   * giftEmoji?, delta? }. Auth like the bid lane; opts {token, seat} let a
   * Showcase seat speak under its OWN identity. The send is display-only —
   * the server broadcasts a ROOM_SOCIAL frame back to everyone (sender included),
   * and the UI renders from that echo so both phones stay identical.
   */
  social: (id, payload, opts = {}) =>
    request(`/auctions/${id}/social`, { method: 'POST', body: payload, ...opts }),

  /** Buyer command lane. Falls back to WS in LiveRoomRoute when unavailable.
   *  opts: { signal?, token?, seat? } — `token`/`seat` let a Showcase seat bid under
   *  its OWN identity (买家A/买家B). NB: a destructured default `({ signal, token,
   *  seat = '' } = {})` makes TS infer the param as `{ seat? }` only (binding-default
   *  gotcha) and reject the engine's `{ token, signal }` call (tsc --noEmit fails even
   *  though it runs fine). Taking `opts` ({}-typed) accepts any caller object and
   *  forwards signal/token/seat to request() unchanged. */
  placeBid: (id, payload, opts = {}) =>
    request(`/auctions/${id}/bids`, { method: 'POST', body: payload, ...opts }),

  /** Stub today (PR #34 fills the timeline + hash chain). */
  getEvidence: (id) => request(`/auctions/${id}/evidence`),

  /** Cheap counter — sometimes useful in admin. */
  getEventsCount: (id) => request(`/auctions/${id}/events-count`),

  // ---------- Admin lifecycle ----------
  /** Seller: create product (used by Publish form step 1). */
  createProduct: (payload) => request('/products', { method: 'POST', body: payload }),

  /**
   * Seller: upload a product image (multipart, ≤5MB, png/jpg/webp/gif).
   * Returns { url: "/uploads/<name>" } — same-origin, store it as imageUrl.
   * Not routed through request(): multipart must NOT carry a JSON
   * content-type header (the browser sets the boundary itself).
   */
  uploadImage: async (file) => {
    const form = new FormData();
    form.append('file', file);
    const headers = {};
    const tok = currentToken();
    if (tok) headers.Authorization = `Bearer ${tok}`;
    const res = await fetch(`${API_BASE}/upload`, { method: 'POST', headers, body: form });
    if (!res.ok) {
      if (res.status === 401) handleAuthFailure();
      let code, message;
      try {
        const j = await res.json();
        code = j.code; message = j.error || j.message;
      } catch {
        message = res.statusText;
      }
      throw new ApiError(res.status, code, message);
    }
    return res.json();
  },

  /**
   * Seller: publish auction.
   *   payload = { productId, rules: { mode?, startPriceCents, incrementCents,
   *               capPriceCents?, durationSec, extendWindowSec, extendSec,
   *               maxExtensions? } } // mode: ENGLISH default; VICKREY = second-price
   */
  createDraft: (payload) => request('/auctions', { method: 'POST', body: payload }),

  /**
   * Seller: DRAFT → SCHEDULED.
   * Seller usually submits `{ factsConfirmed: true, confirmedFacts: <json> }`
   * after VLM核对 so the backend can persist the confirmed snapshot.
   * Returns `{ code: 'OK_FROZEN' | 'ERR_FACTS_NOT_CONFIRMED' | 'ERR_BAD_STATE' }`.
   */
  freeze: (id, body) => request(`/auctions/${id}/freeze`, { method: 'POST', body }),

  /**
   * Seller: SCHEDULED → LIVE.
   * Returns `{ code: 'OK_LIVE', endAtMs }`.
   *
   * The design's old `api.schedule(id, when)` had no backend equivalent —
   * we don't support a future-dated start today. Seller publishes, freezes,
   * then starts manually. Wire the Publish form's "scheduled at" picker
   * to a client-side timer that calls startLive() at the chosen instant.
   */
  startLive: (id, { durationMs, demoCrowd } = {}) => {
    // demoCrowd (#261-12a): true/false toggles the server's 发布即人气 crowd
    // script for THIS auction; omitted → server env default (on).
    const body = {};
    if (durationMs) body.durationMs = durationMs;
    if (typeof demoCrowd === 'boolean') body.demoCrowd = demoCrowd;
    return request(`/auctions/${id}/start`, { method: 'POST', body: Object.keys(body).length ? body : undefined });
  },

  /**
   * Seller / admin: any non-terminal → CANCELLED.
   * Returns `{ code: 'OK_CANCELLED' | 'ERR_ALREADY_TERMINAL' | 'ERR_NOT_ALLOWED' }`.
   * UI MUST 2-step confirm (see AdminCancelModal — type current price).
   */
  cancel: (id, payload) => request(`/auctions/${id}/cancel`, { method: 'POST', body: payload }),

  /** Seller: modify a pre-start auction's rules (DRAFT/SCHEDULED). model.Rules shape. */
  updateRules: (id, rules) => request(`/auctions/${id}`, { method: 'PATCH', body: { rules } }),

  /** Seller: aggregate sealed warm-up result into recommended formal-auction reserve/floor. */
  prequalifyRecommendation: (id) => request(`/auctions/${id}/prequalify-recommendation`),

  /** Seller: create or reuse the formal open auction spawned from a sealed warm-up parent. */
  spawnFormal: (id, payload) => request(`/auctions/${id}/spawn-formal`, { method: 'POST', body: payload }),

  // ---------- Orders / 模拟支付 ----------
  /** Settlement order for a SOLD auction (404 if not sold yet). */
  getOrder: (id) => request(`/auctions/${id}/order`),
  /** 模拟支付流程: mark the won order paid (idempotent; winner-only). */
  pay: (id) => request(`/auctions/${id}/pay`, { method: 'POST' }),

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
  /**
   * T7-3 / issue #70 §4.3: wraps the wire call to surface AI sidecar
   * health to the offline-badge listeners.
   *   - any success → dispatch `lumen:ai-sidecar-ok`
   *   - any failure (502, 504, network, ApiError of any status) →
   *     dispatch `lumen:ai-sidecar-offline` AND re-throw the original
   *     error so the caller's catch path is unchanged
   *
   * Event-emitter pattern (vs. importing the Zustand store directly)
   * keeps lib/api.js free of UI-state coupling — same shape as the
   * existing `lumen:session-expired` event in auth.js. A small
   * bootstrap in main.jsx subscribes and wires events → store actions.
   *
   * The bid path NEVER calls draftFacts, so AI-down does not affect
   * BID_PLACE / BID_ACCEPTED. V9 P3 invariant.
   */
  draftFacts: async ({ productId, imageUrls, title, description, signal }) => {
    try {
      const result = await request('/facts/draft', {
        method: 'POST',
        body: { productId, imageUrls, title, description },
        signal,
      });
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('lumen:ai-sidecar-ok'));
      }
      return result;
    } catch (e) {
      // Self-review: skip the offline dispatch on AbortError. If a
      // route unmounts mid-request (AbortController.abort()), fetch
      // throws AbortError, which would otherwise leave the badge
      // stuck in offline state even though the sidecar is fine.
      // Same exemption applies to a deliberate caller-side cancel.
      const isAbort = e?.name === 'AbortError' || e?.code === 'ABORT_ERR';
      if (typeof window !== 'undefined' && !isAbort) {
        window.dispatchEvent(new CustomEvent('lumen:ai-sidecar-offline', {
          detail: { status: e?.status ?? null, code: e?.code ?? null },
        }));
      }
      throw e;
    }
  },

  /**
   * Seller-side AI listing copy draft. Returns:
   *   { title, sellingPoints, script, disclaimer, fallback, modelName }
   *
   * Advisory only: the seller edits before publishing. The bid path never calls
   * this endpoint. Success/failure is also surfaced to the existing AI sidecar
   * badge so demo operators can tell whether canned fallback was used.
   */
  draftListing: async ({ title, description, category, facts } = {}) => {
    try {
      const result = await request('/listing/draft', {
        method: 'POST',
        body: { title, description, category, facts },
      });
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('lumen:ai-sidecar-ok'));
      }
      return result;
    } catch (e) {
      const isAbort = e?.name === 'AbortError' || e?.code === 'ABORT_ERR';
      if (typeof window !== 'undefined' && !isAbort) {
        window.dispatchEvent(new CustomEvent('lumen:ai-sidecar-offline', {
          detail: { status: e?.status ?? null, code: e?.code ?? null },
        }));
      }
      throw e;
    }
  },

  // ---------- Evidence ----------
  /**
   * The design's `verifyChain()` POST does not exist on the backend.
   * `getEvidence()` already includes `chainVerified` (server recomputes
   * the HMAC chain on read) + `hashBreakAtSeq` when broken. Just read
   * those fields.
   */
};

export default api;
