// Smoke test for ROOM_JOIN(lastSeq) catchup reconnect path.
// Mirrors TC-T6-102 from docs/test-cases/T6-frontend-wire.md.
//
// Scenario:
//   1. Open WS, ROOM_JOIN, wait for ROOM_SNAPSHOT (gives us seq=N)
//   2. Place a bid → BID_ACCEPTED at seq=N+1
//   3. Hard close the WS (simulate network drop)
//   4. Open a new WS, ROOM_JOIN { lastSeq: N } (one behind the bid)
//   5. Assert: the missed BID_ACCEPTED at seq=N+1 is replayed
//
// Usage (from repo root):
//   make up && make seed
//   cd apps/web && node scripts/smoke-catchup.mjs
//
// Exits 0 on PASS, 1 on any assertion failure.

import { WebSocket } from 'ws';

const SCHEMA = 2;
const HOST_HTTP = 'http://localhost:8080';
const HOST_WS = 'ws://localhost:8080';
const AUCTION_ID = process.env.VERIFY_AID || process.env.AUCTION_ID || 'auc_demo';

async function devLogin(nick) {
  const r = await fetch(`${HOST_HTTP}/api/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname: nick }),
  });
  if (!r.ok) throw new Error(`dev-login ${r.status}`);
  return r.json();
}

function openRoom(token, auctionId, lastSeq, onEvent) {
  return new Promise((resolve, reject) => {
    const url = `${HOST_WS}/ws?token=${encodeURIComponent(token)}&auction=${encodeURIComponent(auctionId)}`;
    const ws = new WebSocket(url);
    ws.on('open', () => {
      const join = {
        schemaVersion: SCHEMA,
        type: 'ROOM_JOIN',
        auctionId,
        serverTimeMs: Date.now(),
        data: { auctionId, ...(lastSeq > 0 ? { lastSeq } : {}) },
      };
      ws.send(JSON.stringify(join));
      resolve(ws);
    });
    ws.on('message', (raw) => onEvent(JSON.parse(raw.toString())));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('open timeout')), 4000);
  });
}

const send = (ws, type, data, auctionId = AUCTION_ID) => {
  ws.send(JSON.stringify({ schemaVersion: SCHEMA, type, auctionId, serverTimeMs: Date.now(), data }));
};

const errors = [];
const must = (cond, msg) => { if (!cond) errors.push(msg); };

// ─── Phase 1 — initial session ─────────────────────────────
const { token, userId } = await devLogin('fari-catchup');
console.log('login → userId=' + userId);

let snapshotSeq = null;
let bidSeq = null;
const phase1Events = [];

const ws1 = await openRoom(token, AUCTION_ID, 0, (env) => {
  phase1Events.push(env);
  console.log('[ws1] ←', env.type, 'seq=' + env.seq);
  if (env.type === 'ROOM_SNAPSHOT') {
    snapshotSeq = env.data.seq;
    const amount = (BigInt(env.data.currentPriceCents) + 5000n).toString();
    send(ws1, 'BID_PLACE', { clientBidId: 'cbid-catchup-1-' + Date.now(), amountCents: amount });
  }
  if (env.type === 'BID_ACCEPTED') {
    bidSeq = env.seq;
  }
});

// Wait for the bid to land
await new Promise((r) => setTimeout(r, 800));
must(snapshotSeq !== null, 'phase1: no ROOM_SNAPSHOT received');
must(bidSeq !== null, 'phase1: no BID_ACCEPTED received');
must(bidSeq > snapshotSeq, `phase1: bidSeq=${bidSeq} should be > snapshotSeq=${snapshotSeq}`);

ws1.close();
console.log(`phase1: snapshot seq=${snapshotSeq} · bid seq=${bidSeq}`);

// ─── Phase 2 — reconnect with lastSeq=snapshotSeq (BEHIND the bid) ─
//                Backend should replay the BID_ACCEPTED at bidSeq.
console.log('\nphase2: reconnecting with lastSeq=' + snapshotSeq + ' (one behind bid)');

const phase2Events = [];
await new Promise((r) => setTimeout(r, 300));
const ws2 = await openRoom(token, AUCTION_ID, snapshotSeq, (env) => {
  phase2Events.push(env);
  console.log('[ws2] ←', env.type, 'seq=' + env.seq);
});

await new Promise((r) => setTimeout(r, 800));
ws2.close();

// Phase 2 should replay the bid (or include it in a fresh snapshot)
const replayHasBid = phase2Events.some((e) =>
  (e.type === 'BID_ACCEPTED' && e.seq === bidSeq)
  || (e.type === 'ROOM_SNAPSHOT' && e.data.seq >= bidSeq),
);
must(replayHasBid, `phase2: missed bid seq=${bidSeq} NOT replayed (received: ${phase2Events.map((e) => e.type + '@' + e.seq).join(', ')})`);

// Every replayed event must keep the seq monotonic in our local view
let prev = snapshotSeq;
for (const e of phase2Events) {
  if (e.seq != null && e.type !== 'ROOM_SNAPSHOT') {
    must(e.seq > prev, `phase2: seq regression — saw seq=${e.seq} after ${prev}`);
    prev = e.seq;
  }
}

// ─── Results ────────────────────────────────────────────────
console.log('\n=== results ===');
console.log(`phase1: ${phase1Events.length} events · phase2: ${phase2Events.length} events`);
if (errors.length === 0) {
  console.log('✓ TC-T6-102 catchup smoke PASSED');
  process.exit(0);
} else {
  console.log('✗ ' + errors.length + ' FAILURES:');
  errors.forEach((e) => console.log('  · ' + e));
  process.exit(1);
}
