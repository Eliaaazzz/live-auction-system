// Smoke test for anti-snipe AUCTION_EXTENDED path.
// Mirrors TC-T6-100 + TC-T6-101 from docs/test-cases/T6-frontend-wire.md.
//
// Scenario:
//   1. Login as seller, create a product
//   2. Create a short-duration auction (durationMs=8000) with factsConfirmed=true
//      to skip the VLM flow.
//   3. Freeze + startLive — auction is LIVE with ~8s to go
//   4. Login as buyer in a separate session
//   5. Open WS, wait for ROOM_SNAPSHOT (gives us starting endAtMs)
//   6. Sleep until the room is in the anti-snipe window (final 10s; for an
//      8s auction we're there immediately)
//   7. Place a bid — backend detects bid in anti-snipe window, fires
//      AUCTION_EXTENDED extending endAtMs by anti_snipe_window_ms
//   8. Assert:
//      - TC-T6-100: AUCTION_EXTENDED arrives with extendCount=1 and a
//        post-extension endAtMs > original endAtMs
//      - TC-T6-101: the BID_ACCEPTED that triggered the extension carries
//        the same post-extension endAtMs (so the FE doesn't render a stale
//        countdown)
//
// Usage (from repo root):
//   make up && make seed     # for the dev-login + ai-sidecar
//   cd apps/web && node scripts/smoke-antisnipe.mjs
//
// Exits 0 on PASS, 1 on any assertion failure.

import { WebSocket } from 'ws';

const SCHEMA = 2;
const HOST_HTTP = 'http://localhost:8080';
const HOST_WS = 'ws://localhost:8080';

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
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok && r.status !== 409) {
    const body = await r.text().catch(() => '');
    throw new Error(`${opts.method || 'GET'} ${path} → ${r.status}: ${body}`);
  }
  if (r.status === 204) return null;
  return r.json();
}

// ─── Phase 0 — setup ────────────────────────────────────────
console.log('[setup] seller dev-login');
const seller = await devLogin('fari-antisnipe-seller');

console.log('[setup] create product + draft (factsConfirmed=true, durationSec=8)');
const { productId } = await api(seller.token, '/products', {
  method: 'POST',
  body: { name: 'AntiSnipe Smoke Test', imageUrl: '', description: '' },
});

// 8-second auction so the entire bidding window is inside the anti-snipe
// final-10s zone. extendWindowSec=10 and extendSec=10 push endAtMs forward.
const draftBody = {
  productId,
  rules: {
    startPriceCents:   '10000',
    incrementCents:    '500',
    durationSec:       8,
    extendWindowSec:   10,
    extendSec:         10,
    maxExtensions:     5,
    capPriceCents:     '999900',
  },
  factsConfirmed: true,
};
const { auctionId } = await api(seller.token, '/auctions', { method: 'POST', body: draftBody });
console.log('[setup] auctionId =', auctionId);

console.log('[setup] freeze');
const fz = await api(seller.token, `/auctions/${auctionId}/freeze`, { method: 'POST' });
console.log('[setup] freeze →', fz?.code || 'ok');

console.log('[setup] startLive');
const st = await api(seller.token, `/auctions/${auctionId}/start`, { method: 'POST' });
const originalEndAtMs = st?.endAtMs;
console.log('[setup] startLive → endAtMs=' + originalEndAtMs);
must(typeof originalEndAtMs === 'number', `startLive: missing endAtMs (got ${JSON.stringify(st)})`);

// ─── Phase 1 — buyer joins, observes the room ──────────────
const buyer = await devLogin('fari-antisnipe-buyer');
const events = [];
let snapshotEndAtMs = null;
let bidAcceptedEndAtMs = null;
let extendedEndAtMs = null;
let extendCount = null;

const ws = new WebSocket(`${HOST_WS}/ws?token=${encodeURIComponent(buyer.token)}&auction=${encodeURIComponent(auctionId)}`);

await new Promise((resolve, reject) => {
  let timer;
  ws.on('open', () => {
    ws.send(JSON.stringify({
      schemaVersion: SCHEMA,
      type: 'ROOM_JOIN',
      auctionId,
      serverTimeMs: Date.now(),
      data: { auctionId },
    }));
  });
  ws.on('message', (raw) => {
    const env = JSON.parse(raw.toString());
    events.push(env);
    console.log('←', env.type, 'seq=' + env.seq, env.data?.endAtMs ? `endAt=${env.data.endAtMs}` : '');

    if (env.type === 'ROOM_SNAPSHOT') {
      snapshotEndAtMs = env.data.endAtMs;
      // Place a bid right away — we're in the anti-snipe window because
      // the entire 8s auction is inside the 10s anti-snipe zone.
      const bidAmount = (BigInt(env.data.currentPriceCents) + 500n).toString();
      ws.send(JSON.stringify({
        schemaVersion: SCHEMA,
        type: 'BID_PLACE',
        auctionId,
        serverTimeMs: Date.now(),
        data: { clientBidId: 'cbid-antisnipe-' + Date.now(), amountCents: bidAmount },
      }));
    }
    if (env.type === 'BID_ACCEPTED') {
      bidAcceptedEndAtMs = env.data.endAtMs;
    }
    if (env.type === 'AUCTION_EXTENDED') {
      extendedEndAtMs = env.data.endAtMs;
      extendCount = env.data.extendCount;
      // Got everything — give the wire a beat then close.
      setTimeout(() => { clearTimeout(timer); ws.close(); }, 200);
    }
  });
  ws.on('error', reject);
  ws.on('close', () => resolve());
  timer = setTimeout(() => { ws.close(); reject(new Error('timeout waiting for AUCTION_EXTENDED')); }, 12_000);
});

// ─── Assertions ────────────────────────────────────────────
console.log('\n[assert] checking anti-snipe contract');

// TC-T6-100 (store.extendCount + endAtMs updated + sweep visual)
must(extendedEndAtMs != null, 'TC-T6-100: AUCTION_EXTENDED envelope never arrived');
must(extendCount === 1, `TC-T6-100: expected extendCount=1, got ${extendCount}`);
must(extendedEndAtMs > snapshotEndAtMs,
  `TC-T6-100: post-extension endAtMs (${extendedEndAtMs}) should be > snapshot endAtMs (${snapshotEndAtMs})`);

// TC-T6-101 (the BID_ACCEPTED that triggered must carry the same post-ext endAtMs)
must(bidAcceptedEndAtMs != null, 'TC-T6-101: BID_ACCEPTED envelope never arrived');
// Backend behavior: the BID_ACCEPTED that triggers anti-snipe SHOULD carry
// the post-extension endAtMs so the FE's `applyEvent(BID_ACCEPTED)` reducer
// doesn't render a stale countdown for the few ms before AUCTION_EXTENDED
// dispatches. PR #45 evidenceSummary derives from this property too.
must(bidAcceptedEndAtMs === extendedEndAtMs,
  `TC-T6-101: BID_ACCEPTED.endAtMs (${bidAcceptedEndAtMs}) should match AUCTION_EXTENDED.endAtMs (${extendedEndAtMs})`);

// ─── Results ────────────────────────────────────────────────
console.log('\n=== results ===');
console.log(`snapshot endAt:  ${snapshotEndAtMs}`);
console.log(`BID_ACCEPTED endAt: ${bidAcceptedEndAtMs}`);
console.log(`AUCTION_EXT endAt:  ${extendedEndAtMs} · extendCount=${extendCount}`);
console.log(`total events: ${events.length} (${events.map((e) => e.type).join(', ')})`);

if (errors.length === 0) {
  console.log('✓ TC-T6-100/101 anti-snipe smoke PASSED');
  process.exit(0);
} else {
  console.log('✗ ' + errors.length + ' FAILURES:');
  errors.forEach((e) => console.log('  · ' + e));
  process.exit(1);
}
