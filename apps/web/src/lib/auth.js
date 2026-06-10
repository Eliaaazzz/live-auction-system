// src/lib/auth.js
//
// Session bootstrap. Production services expose `POST /api/login`; legacy
// deployments may still expose `POST /api/dev-login`.
//
// Usage:
//   import { ensureSession, currentToken, currentUser } from '@/lib/auth';
//   await ensureSession('demo');     // one-time at app boot
//   fetch(..., { headers: { Authorization: `Bearer ${currentToken()}` } });

const STORAGE_KEY = 'lumen.session';

let _session = null;

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
 * Mint or reuse a session token. No-ops if a token is already cached.
 * @param {string} nickname — display name for the account.
 */
export async function ensureSession(nickname = 'demo') {
  if (currentToken()) return readStorage();
  const payload = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname }),
  };

  const loginRes = await fetch('/api/login', payload).catch(() => null);
  const fallbackRes =
    loginRes?.ok
      ? null
      : await fetch('/api/dev-login', payload).catch(() => null);

  const res = loginRes?.ok ? loginRes : fallbackRes;
  if (!res?.ok) {
    const loginStatus = loginRes ? String(loginRes.status) : 'failed';
    const fallbackStatus = fallbackRes ? String(fallbackRes.status) : 'failed';
    throw new Error(`login failed: /api/login ${loginStatus}; /api/dev-login ${fallbackStatus}`);
  }

  const session = await res.json();
  if (!session || typeof session.token !== 'string' || session.token.length === 0) {
    throw new Error('login response missing token');
  }

  // session = { userId, token, nickname }
  writeStorage(session);
  return session;
}
