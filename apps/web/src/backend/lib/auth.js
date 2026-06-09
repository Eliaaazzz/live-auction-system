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

const STORAGE_KEY = 'lumen.session';
const NICK_KEY = 'lumen.nick';

let _session = null;

// ─── Minimal account system ───────────────────────────────────────
// No real auth backend yet, but every DEVICE should be a DISTINCT user
// (so two people on two phones aren't the same 'demo' account). We persist
// a per-device nickname; the backend /api/login mints a stable userId from
// it. Users can rename themselves (setNickname) to be recognizable.
export function deviceNickname() {
  try {
    let n = localStorage.getItem(NICK_KEY);
    if (!n) {
      n = '买家' + Math.floor(1000 + Math.random() * 9000);
      localStorage.setItem(NICK_KEY, n);
    }
    return n;
  } catch {
    return '买家' + Math.floor(1000 + Math.random() * 9000);
  }
}

export function setNickname(n) {
  const name = String(n || '').trim().slice(0, 16);
  if (!name) return deviceNickname();
  try {
    localStorage.setItem(NICK_KEY, name);
    localStorage.removeItem(STORAGE_KEY); // drop old-nickname token → re-login under new name
  } catch { /* ignore */ }
  _session = null;
  return name;
}

function readStorage() {
  if (_session) return _session;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) _session = JSON.parse(raw);
  } catch {}
  return _session;
}

function writeStorage(session) {
  _session = session;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(session)); } catch {}
}

export function currentToken() {
  return readStorage()?.token ?? null;
}

export function currentUser() {
  const s = readStorage();
  return s ? { userId: s.userId, nickname: s.nickname } : null;
}

export function clearSession() {
  _session = null;
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
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
export function handleAuthFailure() {
  clearSession();
}

/**
 * Mint or reuse a dev-login session for a given identity. Reuses the cached
 * session only when the nickname matches; re-logs in otherwise.
 * @param {string} [nickname] — identity; omit for the per-device guest.
 */
export async function ensureSession(nickname) {
  const want = nickname || deviceNickname();
  const s = readStorage();
  // Reuse the cached session ONLY if it's the SAME identity. Previously this
  // returned any cached token regardless of nickname, so an admin asking for
  // 'seller-demo' got a buyer's 'demo' token → cancel/own-only ops 403'd, and
  // every device shared one account. Re-login when the identity differs.
  if (s?.token && s.nickname === want) return s;
  let res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname: want }),
  });
  if (res.status === 404) {
    res = await fetch('/api/dev-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nickname: want }),
    });
  }
  if (!res.ok) throw new Error(`login ${res.status}`);
  const session = await res.json();
  // session = { userId, token, nickname }; backend may omit nickname — keep ours.
  if (!session.nickname) session.nickname = want;
  writeStorage(session);
  return session;
}
