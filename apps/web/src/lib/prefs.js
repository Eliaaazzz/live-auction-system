// src/lib/prefs.js
//
// Tiny localStorage-backed UI preferences that must survive a refresh but are
// NOT backend state: whether the buyer follows the seller (cosmetic social
// toggle — the relationship graph is out of V9 scope) and whether they have
// accepted the auction terms ("我要参与"). Both are device-local only.
//
// All access is wrapped: SSR, private-mode quota errors, and disabled storage
// degrade to no-op / false instead of throwing (a thrown localStorage call in
// render would blank the room).

const NS = 'lumen';

function safeGet(key) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key, value) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(key, value);
  } catch {
    /* quota / disabled / denied — non-fatal, the toggle just won't persist */
  }
}

// ── follow (per seller) ──────────────────────────────────────────
export function isFollowing(sellerId) {
  return safeGet(`${NS}.follow.${sellerId || 'default'}`) === '1';
}
export function setFollowing(sellerId, on) {
  safeSet(`${NS}.follow.${sellerId || 'default'}`, on ? '1' : '0');
}

// ── participation / accepted-terms (per auction) ─────────────────
export function hasJoined(auctionId) {
  return safeGet(`${NS}.joined.${auctionId || 'default'}`) === '1';
}
export function setJoined(auctionId, on) {
  safeSet(`${NS}.joined.${auctionId || 'default'}`, on ? '1' : '0');
}
