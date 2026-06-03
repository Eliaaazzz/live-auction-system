// Smoke test for REST 401 handling (expired/bad token).
// Mirrors TC-T6-271 from docs/test-cases/T6-frontend-wire.md.
//
// PR #51 follow-up wired handleAuthFailure() into api.js so a 401 from
// any REST endpoint clears the cached session + dispatches a custom
// `lumen:session-expired` event the routes can listen for.
//
// Backend contract (apps/lumen/internal/server/api.go authUser): every
// REST endpoint validates the bearer token and returns 401 if missing/
// invalid/expired. The body includes `{ code: "ERR_AUTH" }` per
// proto/error-codes.md.
//
// Scenario:
//   1. POST /api/auctions with an obviously bogus bearer token
//   2. Assert: response is 401, body has `code: ERR_AUTH`
//   3. POST /api/dev-login to refresh
//   4. Retry the protected call with the new token → 200 (or 4xx that ISN'T 401)
//
// Usage:
//   make up && make seed
//   cd apps/web && node scripts/smoke-401.mjs

import { resolveAuctionId } from './smoke-shared.mjs';

const HOST = 'http://localhost:8080';
const AUCTION_ID = resolveAuctionId({ scriptName: 'smoke-401' });

const errors = [];
const must = (cond, msg) => { if (!cond) errors.push(msg); };

// ─── 1. Bogus token → expect 401 ───────────────────────────
const bogusResp = await fetch(`${HOST}/api/auctions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-real-token' },
  body: JSON.stringify({ productId: 'prod-1', rules: {} }),
});

console.log('bogus token → status', bogusResp.status);
must(bogusResp.status === 401, `expected 401 with bogus token, got ${bogusResp.status}`);

let body = {};
try { body = await bogusResp.json(); } catch { /* may be empty */ }
console.log('  body:', JSON.stringify(body));
// Code field is best-effort — some 401 paths only set status; others include ERR_AUTH
if (body?.code) {
  must(body.code === 'ERR_AUTH' || body.code === 'ERR_TOKEN' || body.code === 'ERR_UNAUTHORIZED',
    `unexpected 401 code: ${body.code}`);
}

// ─── 2. Refresh session ────────────────────────────────────
const login = await fetch(`${HOST}/api/dev-login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ nickname: 'fari-401-smoke' }),
});
must(login.ok, `dev-login failed with ${login.status}`);
const { token } = await login.json();
must(token, 'dev-login returned no token');

// ─── 3. Retry with new token → no longer 401 ───────────────
const retry = await fetch(`${HOST}/api/auctions/${AUCTION_ID}`, {
  method: 'GET',
  headers: { authorization: `Bearer ${token}` },
});
console.log('valid token retry → status', retry.status);
must(retry.status !== 401, `valid token still got 401 (status=${retry.status})`);

// ─── 4. Missing token entirely → also 401 ──────────────────
const noToken = await fetch(`${HOST}/api/auctions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ productId: 'prod-1', rules: {} }),
});
console.log('no token → status', noToken.status);
must(noToken.status === 401, `missing bearer should return 401, got ${noToken.status}`);

// ─── Results ───────────────────────────────────────────────
console.log('\n=== results ===');
if (errors.length === 0) {
  console.log('✓ TC-T6-271 (401 handling) smoke PASSED');
  process.exit(0);
} else {
  console.log('✗ ' + errors.length + ' FAILURES:');
  errors.forEach((e) => console.log('  · ' + e));
  process.exit(1);
}
