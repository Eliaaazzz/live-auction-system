// Smoke test for room-level WebSocket routing across MULTIPLE gateway
// instances (multigw compose profile — infra/docker-compose.yml).
//
// Topology under test:
//   GW1 = lumen      (--mode=all,     :8080) — gateway + timer + pg-writer
//   GW2 = lumen-gw2  (--mode=gateway, :8081) — stateless gateway only
// Both subscribe to the same Redis backbone (hub.subscribe in
// apps/lumen/internal/server/ws.go), so a bid adjudicated through GW1 must be
// broadcast to clients connected on GW2 with the IDENTICAL seq.
//
// Scenario:
//   1. Via GW1 REST: seller dev-login → create product → draft auction →
//      freeze → startLive (smoke-antisnipe.mjs conventions).
//   2. Buyer A dev-logins on GW1, buyer B on GW2 (same JWT_SECRET — tokens
//      are valid on either gateway, which is itself part of statelessness).
//   3. WS A → GW1 /ws, WS B → GW2 /ws; both ROOM_JOIN(lastSeq=0) the same
//      auction and wait for ROOM_SNAPSHOT.
//   4. A places ONE bid via GW1 (WS BID_PLACE, smoke-wire.mjs pattern).
//      Assert BOTH sockets receive BID_ACCEPTED with the SAME seq and the
//      SAME amountCents within 3s — cross-gateway fan-out.
//   5. A re-sends the SAME clientBidId. Assert the ack is idempotent: the
//      replayed BID_ACCEPTED carries the ORIGINAL seq (place_bid.lua dedupe,
//      "retry returns the original ack, NOT an error") and B observes NO
//      second BID_ACCEPTED broadcast (no new seq is minted).
//
// Usage (from repo root):
//   docker compose -f infra/docker-compose.yml --profile multigw up -d --build
//   cd apps/web && npm run smoke:multigw
//
// Env overrides: GW1 (default http://localhost:8080),
//                GW2 (default http://localhost:8081).
// Exits 0 on PASS, 1 on any assertion failure.

import { WebSocket } from 'ws';

const SCHEMA = 2;
const GW1 = process.env.GW1 || 'http://localhost:8080';
const GW2 = process.env.GW2 || 'http://localhost:8081';
const toWs = (httpUrl) => httpUrl.replace(/^http/, 'ws');

const BROADCAST_WAIT_MS = 3000; // both gateways must deliver within this
const QUIET_WINDOW_MS = 1500;   // after the dup retry, B must stay silent this long

const errors = [];
const must = (cond, msg) => { if (!cond) errors.push(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function devLogin(host, nick) {
  const r = await fetch(`${host}/api/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname: nick }),
  });
  if (!r.ok) throw new Error(`dev-login ${host} → ${r.status}`);
  return r.json();
}

async function api(host, token, path, opts = {}) {
  const r = await fetch(`${host}/api${path}`, {
    method: opts.method || 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`${opts.method || 'GET'} ${host}${path} → ${r.status}: ${body}`);
  }
  if (r.status === 204) return null;
  return r.json();
}

const send = (ws, type, data, auctionId) => {
  if (ws.readyState !== WebSocket.OPEN) {
    throw new Error(`cannot send ${type}: websocket state=${ws.readyState}`);
  }
  ws.send(JSON.stringify({
    schemaVersion: SCHEMA, type, auctionId, serverTimeMs: Date.now(), data,
  }));
};

// Opens a WS to `host`, sends ROOM_JOIN(lastSeq=0), records every envelope
// into `track`, and resolves once ROOM_SNAPSHOT lands (defensive timeout).
function joinRoom(label, host, token, auctionId, track) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${toWs(host)}/ws?token=${encodeURIComponent(token)}&auction=${encodeURIComponent(auctionId)}`,
    );
    const timer = setTimeout(
      () => reject(new Error(`${label}: timeout waiting for ROOM_SNAPSHOT from ${host}`)),
      5000,
    );
    ws.on('open', () => {
      send(ws, 'ROOM_JOIN', { auctionId, lastSeq: 0 }, auctionId);
    });
    ws.on('message', (raw) => {
      let env;
      try {
        env = JSON.parse(raw.toString());
      } catch (err) {
        errors.push(`${label}: malformed frame: ${err.message}`);
        return;
      }
      track.events.push(env);
      console.log(`[${label}] ←`, env.type, 'seq=' + env.seq,
        env.type === 'BID_ACCEPTED' ? `amount=${env.data.amountCents}` :
        env.type === 'BID_REJECTED' ? `code=${env.data.code}` : '');
      if (env.type === 'ROOM_SNAPSHOT') {
        track.snapshot = env.data;
        clearTimeout(timer);
        resolve(ws);
      }
      if (env.type === 'BID_ACCEPTED') {
        track.accepted.push({ seq: env.seq, amountCents: env.data.amountCents });
      }
      if (env.type === 'BID_REJECTED') {
        track.rejected.push(env.data.code);
      }
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(new Error(`${label}: ws error: ${err.message}`)); });
  });
}

// Polls until `cond()` is truthy or `ms` elapsed; returns cond()'s value.
async function waitFor(cond, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(50);
  }
}

// ─── Phase 0 — setup via GW1 REST ───────────────────────────
console.log(`[setup] GW1=${GW1} GW2=${GW2}`);
console.log('[setup] seller dev-login via GW1');
const seller = await devLogin(GW1, 'fari-multigw-seller');

console.log('[setup] create product + draft auction via GW1');
const { productId } = await api(GW1, seller.token, '/products', {
  method: 'POST',
  body: { name: 'Multi-gateway smoke', imageUrl: '', description: '' },
});
const { auctionId } = await api(GW1, seller.token, '/auctions', {
  method: 'POST',
  body: {
    productId,
    rules: {
      startPriceCents: '10000',
      incrementCents: '500',
      durationSec: 120,
      extendWindowSec: 0,
      extendSec: 0,
      maxExtensions: 0,
      capPriceCents: '0',
    },
    factsConfirmed: true,
  },
});
console.log('[setup] auctionId =', auctionId);

console.log('[setup] freeze + startLive via GW1');
await api(GW1, seller.token, `/auctions/${auctionId}/freeze`, { method: 'POST' });
await api(GW1, seller.token, `/auctions/${auctionId}/start`, { method: 'POST' });

console.log('[setup] buyer A dev-login via GW1, buyer B via GW2');
const buyerA = await devLogin(GW1, 'fari-multigw-buyer-a');
const buyerB = await devLogin(GW2, 'fari-multigw-buyer-b');

// ─── Phase 1 — A joins via GW1, B joins via GW2 ─────────────
const trackA = { events: [], accepted: [], rejected: [], snapshot: null };
const trackB = { events: [], accepted: [], rejected: [], snapshot: null };

let wsA = null;
let wsB = null;
let firstSeq = null;
let bidAmount = null;
const clientBidId = `cbid-multigw-${Date.now()}`;

try {
  [wsA, wsB] = await Promise.all([
    joinRoom('A@gw1', GW1, buyerA.token, auctionId, trackA),
    joinRoom('B@gw2', GW2, buyerB.token, auctionId, trackB),
  ]);
  must(trackA.snapshot?.status === 'LIVE', `A snapshot status=${trackA.snapshot?.status} expected LIVE`);
  must(trackB.snapshot?.status === 'LIVE', `B snapshot status=${trackB.snapshot?.status} expected LIVE`);

  // ─── Phase 2 — ONE bid through GW1, observed on BOTH gateways ───
  bidAmount = (BigInt(trackA.snapshot.currentPriceCents) + 5000n).toString();
  console.log(`\n[bid] A places bid via GW1: clientBidId=${clientBidId} amount=${bidAmount}`);
  send(wsA, 'BID_PLACE', { clientBidId, amountCents: bidAmount }, auctionId);

  const both = await waitFor(
    () => trackA.accepted.length > 0 && trackB.accepted.length > 0,
    BROADCAST_WAIT_MS,
  );
  must(both, `BID_ACCEPTED did not reach both gateways within ${BROADCAST_WAIT_MS}ms `
    + `(A=${trackA.accepted.length} frames, B=${trackB.accepted.length} frames)`);

  if (both) {
    firstSeq = trackA.accepted[0].seq;
    must(trackB.accepted[0].seq === firstSeq,
      `cross-gateway seq mismatch: A@gw1 seq=${trackA.accepted[0].seq} vs B@gw2 seq=${trackB.accepted[0].seq}`);
    must(trackA.accepted[0].amountCents === bidAmount,
      `A amountCents=${trackA.accepted[0].amountCents} expected ${bidAmount}`);
    must(trackB.accepted[0].amountCents === bidAmount,
      `B amountCents=${trackB.accepted[0].amountCents} expected ${bidAmount}`);
  }

  // ─── Phase 3 — idempotent retry: SAME clientBidId again ─────────
  // place_bid.lua dedupe: the retry must replay the ORIGINAL ack (same seq)
  // to the submitter and must NOT mint a new seq / broadcast a second
  // BID_ACCEPTED to the room (B's frame count stays put).
  const ackFramesBefore = trackA.accepted.length;
  const bFramesBefore = trackB.accepted.length;
  console.log(`\n[dup] A re-sends SAME clientBidId=${clientBidId}`);
  send(wsA, 'BID_PLACE', { clientBidId, amountCents: bidAmount }, auctionId);

  const dupAck = await waitFor(
    () => (trackA.accepted.length > ackFramesBefore ? trackA.accepted[trackA.accepted.length - 1] : null),
    BROADCAST_WAIT_MS,
  );
  must(dupAck, `idempotent retry: no replayed ack on A within ${BROADCAST_WAIT_MS}ms`);
  if (dupAck) {
    must(dupAck.seq === firstSeq,
      `idempotent retry: replayed seq=${dupAck.seq} expected original seq=${firstSeq}`);
    must(dupAck.amountCents === bidAmount,
      `idempotent retry: replayed amountCents=${dupAck.amountCents} expected ${bidAmount}`);
  }
  must(trackA.rejected.length === 0,
    `A received unexpected BID_REJECTED: ${trackA.rejected.join(',')}`);

  // B must observe NO second broadcast for the duplicate.
  await sleep(QUIET_WINDOW_MS);
  must(trackB.accepted.length === bFramesBefore,
    `duplicate leaked to room: B@gw2 saw ${trackB.accepted.length - bFramesBefore} extra `
    + `BID_ACCEPTED frame(s) after the retry (seqs=${trackB.accepted.map((a) => a.seq).join(',')})`);

  // Defense in depth: across the whole run exactly ONE distinct seq was
  // minted for this room on either gateway.
  const allSeqs = [...new Set([...trackA.accepted, ...trackB.accepted].map((a) => a.seq))];
  must(allSeqs.length === 1 && allSeqs[0] === firstSeq,
    `expected exactly one distinct accepted seq=${firstSeq}, observed [${allSeqs.join(',')}]`);
} catch (err) {
  errors.push(`fatal: ${err.message}`);
} finally {
  for (const ws of [wsA, wsB]) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  }
}

// ─── Results ────────────────────────────────────────────────
const seqsA = trackA.accepted.map((a) => a.seq).join(',') || '(none)';
const seqsB = trackB.accepted.map((a) => a.seq).join(',') || '(none)';
console.log('\n=== multi-gateway smoke results ===');
console.log(`auction:           ${auctionId}`);
console.log(`bid:               clientBidId=${clientBidId} amount=${bidAmount}`);
console.log(`A@gw1 (${GW1}): BID_ACCEPTED seqs = ${seqsA}`);
console.log(`B@gw2 (${GW2}): BID_ACCEPTED seqs = ${seqsB}`);
if (errors.length === 0) {
  console.log(`✓ PASS — one bid via GW1 fanned out on both gateways at seq=${firstSeq}; `
    + 'duplicate retry replayed the original ack and minted no new seq');
  process.exit(0);
} else {
  console.log('✗ FAIL — ' + errors.length + ' assertion(s):');
  errors.forEach((e) => console.log('  · ' + e));
  process.exit(1);
}
