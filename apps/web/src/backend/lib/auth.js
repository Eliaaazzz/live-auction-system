// src/lib/auth.js
//
// Session bootstrap. The Lumen backend ships a dev-login endpoint
// (POST /api/dev-login) that mints a JWT signed with JWT_SECRET when
// ENABLE_DEV_LOGIN=true. Production OTP / Doubao auth is post-MVP (P1).
//
// Usage:
//   import { ensureSession, currentToken, currentUser } from '@/lib/auth';
//   await ensureSession('demo');     // one-time at app boot
//   fetch(..., { headers: { Authorization: `Bearer ${currentToken()}` } });

// Same-origin '/api' in production (Lumen serves the built web app + API together);
// overridable via VITE_API_BASE for split dev/hosting. Mirrors lib/api.js — kept
// independent here to avoid an auth.js ⇄ api.js import cycle.
const API_BASE = (import.meta.env && import.meta.env.VITE_API_BASE) || '/api';
const STORAGE_KEY = 'lumen.session';
const NICK_KEY = 'lumen.nick';

// ─── Per-SEAT sessions ────────────────────────────────────────────
// A "seat" is one independent buyer/seller identity living in ONE browser
// context. The default seat ('') is the real device user — the only seat
// the full-screen /m buyer and the /admin seller ever use, so its storage
// keys + behavior are byte-for-byte unchanged (zero risk to those routes).
//
// The desktop Showcase, however, renders THREE apps in one tab (buyer A +
// the console + buyer B). Without seats they'd all share one token + one userId, so
// "buyer A" and "buyer B" would be the SAME backend account and their bids
// indistinguishable. Named seats ('A','B',...) give each its own nickname,
// token, userId and storage slot — genuinely separate accounts.
const sessionKey = (seat) => (seat ? `${STORAGE_KEY}.${seat}` : STORAGE_KEY);
const nickKey = (seat) => (seat ? `${NICK_KEY}.${seat}` : NICK_KEY);
const _sessions = new Map(); // seat('' = default) -> cached session object

// No real auth backend yet, but every DEVICE/seat should be a DISTINCT user
// (so two people on two phones - or buyer A vs buyer B in the Showcase - aren't the
// same account). We persist a per-seat nickname; the backend /api/login mints a
// stable userId from it. Users can rename themselves (setNickname).
export function deviceNickname(seat = '') {
  const fallback = () => (seat ? `Buyer ${seat}` : 'Buyer ' + Math.floor(1000 + Math.random() * 9000));
  try {
    let n = localStorage.getItem(nickKey(seat));
    if (!n) {
      n = fallback();
      localStorage.setItem(nickKey(seat), n);
    }
    return n;
  } catch {
    return fallback();
  }
}

export function setNickname(n, seat = '') {
  const name = String(n || '').trim().slice(0, 16);
  if (!name) return deviceNickname(seat);
  try {
    localStorage.setItem(nickKey(seat), name);
    localStorage.removeItem(sessionKey(seat)); // drop old-nickname token → re-login under new name
  } catch { /* ignore */ }
  _sessions.delete(seat);
  return name;
}

function readStorage(seat = '') {
  if (_sessions.has(seat)) return _sessions.get(seat);
  try {
    const raw = localStorage.getItem(sessionKey(seat));
    if (raw) { const s = JSON.parse(raw); _sessions.set(seat, s); return s; }
  } catch {}
  return _sessions.get(seat) ?? null;
}

function writeStorage(session, seat = '') {
  _sessions.set(seat, session);
  try { localStorage.setItem(sessionKey(seat), JSON.stringify(session)); } catch {}
}

export function currentToken(seat = '') {
  return readStorage(seat)?.token ?? null;
}

export function currentUser(seat = '') {
  const s = readStorage(seat);
  return s ? { userId: s.userId, nickname: s.nickname } : null;
}

/** Role of the stored session: 'seller' only via sellerLogin; else 'user'. */
export function currentRole(seat = '') {
  return readStorage(seat)?.role === 'seller' ? 'seller' : 'user';
}

/**
 * #260-4 seller login for the /admin gate. POST /api/login {nickname, sellerKey}
 * mints a `seller_*`-namespace session the backend's creation endpoints trust.
 * Stored in the DEFAULT seat so every admin page's ensureSession('seller-demo')
 * finds a matching cached session and does NOT plain-re-login over it.
 * Throws an error on a 403 (the server has LUMEN_SELLER_KEY set and the
 * key mismatched); with no key configured server-side any non-empty key passes.
 */
export async function sellerLogin(sellerKey, nickname = 'seller-demo') {
  const res = await fetch(`${API_BASE}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname, sellerKey: String(sellerKey || '').trim() }),
  });
  if (res.status === 403) throw new Error('Incorrect seller key');
  if (!res.ok) throw new Error(`login ${res.status}`);
  const session = await res.json();
  if (!session.nickname) session.nickname = nickname;
  writeStorage(session, '');
  return session;
}

export function clearSession(seat = '') {
  _sessions.delete(seat);
  try { localStorage.removeItem(sessionKey(seat)); } catch {}
  // Fire a one-shot custom event so route components can react (e.g. force a
  // re-login flow). Components listen via window.addEventListener; this is
  // intentionally global rather than a Zustand action because auth crosses
  // every route. See lib/api.js handleAuthFailure for the call-site.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('lumen:session-expired'));
  }
}

/**
 * Called by lib/api.js on a 401 response (token expired / revoked /
 * JWT_SECRET rotated on the server). Clears the cached session and
 * emits the global 'lumen:session-expired' event. Idempotent; safe to
 * call multiple times during a burst of 401s from concurrent requests.
 *
 * The actual re-login UX (modal? full reload? auto-retry?) is the
 * consumer's call — auth.js stays UX-agnostic. For T6 the simplest
 * working behavior is to re-run ensureSession() and let the in-flight
 * request retry succeed; ApiError surfaces the original 401 if the
 * retry path isn't wired.
 */
export function handleAuthFailure(seat = '') {
  clearSession(seat);
}

/**
 * Mint or reuse a dev-login session for a given identity. Reuses the cached
 * session only when the nickname matches; re-logs in otherwise.
 * @param {string} [nickname] — identity; omit for the per-seat guest.
 * @param {string} [seat]     — '' (default device user) or a named Showcase seat ('A'/'B').
 */
export async function ensureSession(nickname, seat = '') {
  const want = nickname || deviceNickname(seat);
  const s = readStorage(seat);
  // Reuse the cached session ONLY if it's the SAME identity. Previously this
  // returned any cached token regardless of nickname, so an admin asking for
  // 'seller-demo' got a buyer's 'demo' token → cancel/own-only ops 403'd, and
  // every device shared one account. Re-login when the identity differs.
  if (s?.token && s.nickname === want) return s;
  let res = await fetch(`${API_BASE}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname: want }),
  });
  if (res.status === 404) {
    res = await fetch(`${API_BASE}/dev-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nickname: want }),
    });
  }
  if (!res.ok) throw new Error(`login ${res.status}`);
  const session = await res.json();
  // session = { userId, token, nickname }; backend may omit nickname — keep ours.
  if (!session.nickname) session.nickname = want;
  writeStorage(session, seat);
  return session;
}
