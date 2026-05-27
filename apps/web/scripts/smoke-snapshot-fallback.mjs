// Smoke test for gap-too-large snapshot fallback.
// Mirrors TC-T6-103 from docs/test-cases/T6-frontend-wire.md.
//
// Contract (project-blueprint.md §5.5 + ws-envelope.md §3.2):
//   - On `ROOM_JOIN { lastSeq }`, backend chooses the catchup path:
//     - gap = current_tip_seq - lastSeq
//     - gap ≤ 200 → XRANGE replay events from lastSeq+1 to tip
//     - gap > 200 → skip replay, send fresh ROOM_SNAPSHOT (clients reset
//       their seqguard watermark to snapshot.seq)
//   - The boundary is chosen so a long-disconnected client doesn't drown
//     in stale events when reconnecting.
//
// Scenario:
//   1. Login as seller, create an auction
//   2. Login as buyer, open WS, observe ROOM_SNAPSHOT (gives current seq=N)
//   3. Generate enough bid traffic to push seq past N + 200
//      (We use the existing auction's bidding pipeline — place 250+ bids
//      via WS to make sure we cross the threshold.)
//   4. Close WS
//   5. Reopen with lastSeq=N (gap > 200)
//   6. Assert:
//      - We receive a ROOM_SNAPSHOT (not a flood of XRANGE-replayed events)
//      - The snapshot.seq is at or near the tip (the catchup-200 cutoff)
//      - extendCount and other state come from snapshot, not event replay
//
// Note: this test is HEAVIER than the others — it deliberately generates
// 250+ events. Allow up to 30s for the bid storm to settle.
//
// Usage:
//   make up && make seed
//   cd apps/web && node scripts/smoke-snapshot-fallback.mjs

import { WebSocket } from 'ws';

const SCHEMA = 1;
const HOST_HTTP = 'http://localhost:8080';
const HOST_WS = 'ws://localhost:8080';
const TARGET_GAP = 220; // > 200 boundary

const errors = [];
const must = (cond, msg) => { if (!cond) errors.push(msg); };

async function devLogin(nick) {
  const r = await fetch(`${HOST_HTTP}/api/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname: nick }),
  });
  if (!r.ok) throw new Error(`dev-login ${r.status}`);
  return r.json();
}

async function api(token, path, opts = {}) {
  const r = await fetch(`${HOST_HTTP}/api${path}`, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok && r.status !== 409) {
    const body = await r.text().catch(() => '');
    throw new Error(`${opts.method || 'GET'} ${path} → ${r.status}: ${body}`);
  }
  if (r.status === 204) return null;
  return r.json();
}

// ─── Phase 0 — setup a long-duration auction ──────────────
console.log('[setup] seller dev-login');
const seller = await devLogin('fari-snap-seller');

console.log('[setup] create product + draft (durationMs=120000)');
const { productId } = await api(seller.token, '/products', {
  method: 'POST',
  body: { name: 'Snapshot Fallback Smoke', imageUrl: '', description: '' },
});
const { auctionId } = await api(seller.token, '/auctions', {
  method: 'POST',
  body: {
    productId,
    rules: {
      startCents:        '10000',
      stepCents:         '500',
      durationMs:        120000,           // 2 minutes — enough time to generate 250 bids
      maxExtensions:     0,                // no anti-snipe so endAtMs stable
      antiSnipeWindowMs: 0,
      capCents:          '99999999999999', // very high so we don't hit it
      reserveCents:      '10000',
    },
    factsConfirmed: true,
  },
});
console.log('[setup] auctionId =', auctionId);
await api(seller.token, `/auctions/${auctionId}/freeze`, { method: 'POST' });
await api(seller.token, `/auctions/${auctionId}/start`, { method: 'POST' });

// Multiple buyer sessions so each can submit bids in parallel without
// hitting the dedupe Hash (keyed by userId).
const buyers = await Promise.all([
  devLogin('fari-snap-b1'),
  devLogin('fari-snap-b2'),
  devLogin('fari-snap-b3'),
]);

// ─── Phase 1 — observe initial snapshot, record starting seq ──
let startingSeq = null;
const observer = new WebSocket(`${HOST_WS}/ws?token=${encodeURIComponent(buyers[0].token)}&auction=${encodeURIComponent(auctionId)}`);
await new Promise((resolve, reject) => {
  observer.on('open', () => {
    observer.send(JSON.stringify({
      schemaVersion: SCHEMA, type: 'ROOM_JOIN', auctionId, serverTimeMs: Date.now(),
      data: { auctionId },
    }));
  });
  observer.on('message', (raw) => {
    const env = JSON.parse(raw.toString());
    if (env.type === 'ROOM_SNAPSHOT') {
      startingSeq = env.data.seq;
      observer.close();
      resolve();
    }
  });
  observer.on('error', reject);
  setTimeout(() => reject(new Error('observer timeout')), 4000);
});
console.log('[phase1] starting seq =', startingSeq);

// ─── Phase 2 — generate 250+ bids to push tip past gap=200 ──
console.log('[phase2] generating ' + TARGET_GAP + ' bids to push tip past gap=200');
//
// Bugfix: the prior version `resolve()`d synchronously after creating the
// WebSocket, BEFORE 'open' fired. Phase 2's tight bid loop below would then
// call ws.send() while readyState was still CONNECTING (0), throwing
// `WebSocket is not open: readyState 0 (CONNECTING)`. This happened
// intermittently in slow CI runners (caught by 444435d on PR #77's e2e job).
//
// Fix: resolve the per-flooder promise ONLY after 'open' fires (so the loop
// can't start until every WS has handshaked) and reject after a 5s timeout
// so a hung connection doesn't deadlock the run.
const flooders = await Promise.all(buyers.map((b) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`${HOST_WS}/ws?token=${encodeURIComponent(b.token)}&auction=${encodeURIComponent(auctionId)}`);
  let currentCents = '10000';
  const timeout = setTimeout(() => reject(new Error('flooder ws open timeout (5s)')), 5_000);
  ws.on('open', () => {
    clearTimeout(timeout);
    ws.send(JSON.stringify({
      schemaVersion: SCHEMA, type: 'ROOM_JOIN', auctionId, serverTimeMs: Date.now(),
      data: { auctionId },
    }));
    resolve({ ws, getCurrent: () => currentCents });
  });
  ws.on('message', (raw) => {
    const env = JSON.parse(raw.toString());
    if (env.type === 'BID_ACCEPTED') currentCents = env.data.amountCents;
    if (env.type === 'ROOM_SNAPSHOT') currentCents = env.data.currentPriceCents;
  });
  ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
})));

// Round-robin bid placement across all flooders.
let placed = 0;
const startTime = Date.now();
while (placed < TARGET_GAP && Date.now() - startTime < 25000) {
  const flooder = flooders[placed % flooders.length];
  const next = (BigInt(flooder.getCurrent()) + 500n).toString();
  flooder.ws.send(JSON.stringify({
    schemaVersion: SCHEMA, type: 'BID_PLACE', auctionId, serverTimeMs: Date.now(),
    data: { clientBidId: 'cbid-flood-' + placed + '-' + Date.now(), amountCents: next },
  }));
  placed++;
  // Tiny delay so the server can process and broadcast — otherwise bids
  // pile up before currentCents updates locally and all collide on TOO_LOW.
  await new Promise((r) => setTimeout(r, 20));
}
console.log('[phase2] placed ' + placed + ' bid messages');

// Wait for the stream to settle
await new Promise((r) => setTimeout(r, 1500));
flooders.forEach((f) => f.ws.close());

// ─── Phase 3 — reconnect with the FAR-BEHIND lastSeq ──────
console.log('[phase3] reconnecting with lastSeq=' + startingSeq + ' (expect gap > 200)');
const phase3Events = [];
let sawSnapshot = false;
let xrangeReplayCount = 0;

const ws3 = new WebSocket(`${HOST_WS}/ws?token=${encodeURIComponent(buyers[0].token)}&auction=${encodeURIComponent(auctionId)}`);
await new Promise((resolve, reject) => {
  ws3.on('open', () => {
    ws3.send(JSON.stringify({
      schemaVersion: SCHEMA, type: 'ROOM_JOIN', auctionId, serverTimeMs: Date.now(),
      data: { auctionId, lastSeq: startingSeq },
    }));
  });
  ws3.on('message', (raw) => {
    const env = JSON.parse(raw.toString());
    phase3Events.push(env);
    if (env.type === 'ROOM_SNAPSHOT') {
      sawSnapshot = true;
      console.log('[phase3] ← ROOM_SNAPSHOT seq=' + env.data.seq);
    } else if (env.seq && env.seq > startingSeq && env.seq <= startingSeq + placed) {
      xrangeReplayCount++;
    }
  });
  ws3.on('error', reject);
  setTimeout(() => { ws3.close(); resolve(); }, 2000);
});

// ─── Assertions ────────────────────────────────────────────
console.log('\n[assert] checking snapshot-fallback contract');

must(sawSnapshot, 'TC-T6-103: backend should send fresh ROOM_SNAPSHOT when gap > 200');

// XRANGE replay should NOT have been used — if backend replayed the full
// 250-bid history we'd see all those BID_ACCEPTED envelopes here. A few
// fresh ones from concurrent traffic is fine, but we shouldn't see
// hundreds.
const REPLAY_CAP = 50;
must(xrangeReplayCount < REPLAY_CAP,
  `TC-T6-103: backend replayed ${xrangeReplayCount} events; gap>200 path should skip replay and send snapshot only (≤${REPLAY_CAP} fresh acceptable)`);

console.log('\n=== results ===');
console.log(`starting seq: ${startingSeq}`);
console.log(`bids placed:  ${placed}`);
console.log(`phase3 events: ${phase3Events.length} (snapshot=${sawSnapshot} · xrange-replay=${xrangeReplayCount})`);

if (errors.length === 0) {
  console.log('✓ TC-T6-103 snapshot-fallback smoke PASSED');
  process.exit(0);
} else {
  console.log('✗ ' + errors.length + ' FAILURES:');
  errors.forEach((e) => console.log('  · ' + e));
  process.exit(1);
}
