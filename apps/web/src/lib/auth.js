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
}

/**
 * Mint or reuse a dev-login session. No-ops if a token is already cached.
 * @param {string} nickname — display name for the dev account.
 */
export async function ensureSession(nickname = 'demo') {
  if (currentToken()) return readStorage();
  const res = await fetch('/api/dev-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname }),
  });
  if (!res.ok) throw new Error(`dev-login ${res.status}`);
  const session = await res.json();
  // session = { userId, token, nickname }
  writeStorage(session);
  return session;
}
