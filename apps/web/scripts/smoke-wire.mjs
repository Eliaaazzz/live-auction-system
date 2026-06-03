// Smoke test for apps/web wire layer against running backend on :8080.
// Mirrors the exact envelope shape from apps/web/src/lib/ws.js so any
// wire-contract drift surfaces here before browser testing.
//
// Usage (from repo root):
//   make up && make seed
//   cd apps/web && node scripts/smoke-wire.mjs
//
// Exits 0 on PASS, 1 on any assertion failure. Suitable for a future CI
// gate paired with a docker-compose test fixture.
//
// Covers TC-T6-001/004-013 from docs/test-cases/T6-frontend-wire.md.

import { WebSocket } from 'ws';

const SCHEMA = 1;
const AUCTION_ID = process.env.VERIFY_AID || process.env.AUCTION_ID || 'auc_demo';
const TYPES = {
  ROOM_JOIN: 'ROOM_JOIN', BID_PLACE: 'BID_PLACE', PING: 'PING',
  ROOM_SNAPSHOT: 'ROOM_SNAPSHOT', BID_ACCEPTED: 'BID_ACCEPTED', BID_REJECTED: 'BID_REJECTED',
  AUCTION_EXTENDED: 'AUCTION_EXTENDED', AUCTION_SOLD: 'AUCTION_SOLD',
  AUCTION_NO_BID: 'AUCTION_NO_BID', AUCTION_CANCELLED: 'AUCTION_CANCELLED', PONG: 'PONG',
};

async function devLogin() {
  const r = await fetch('http://localhost:8080/api/dev-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname: 'fari-smoke' }),
  });
  if (!r.ok) throw new Error(`dev-login ${r.status}`);
  return r.json();
}

const { userId, token, nickname } = await devLogin();
console.log('login →', { userId, nickname, tokenLen: token.length });

const ws = new WebSocket(`ws://localhost:8080/ws?token=${encodeURIComponent(token)}`);
const received = [];
let bidSeqSeen = null;

const send = (type, data) => {
  const env = { schemaVersion: SCHEMA, type, auctionId: AUCTION_ID, serverTimeMs: Date.now(), data };
  ws.send(JSON.stringify(env));
  console.log('→ sent', type, data);
};

await new Promise((resolve, reject) => {
  ws.on('open', () => {
    console.log('ws open');
    send(TYPES.ROOM_JOIN, { auctionId: AUCTION_ID });
  });
  ws.on('message', (raw) => {
    const env = JSON.parse(raw.toString());
    received.push(env);
    console.log('← recv', env.type, 'seq=' + env.seq, 'schemaVer=' + env.schemaVersion,
      env.type === TYPES.ROOM_SNAPSHOT ? `status=${env.data.status} price=${env.data.currentPriceCents}` :
      env.type === TYPES.BID_ACCEPTED ? `winner=${env.data.userId} amount=${env.data.amountCents} status=${env.data.status} endAtMs=${env.data.endAtMs}` :
      env.type === TYPES.BID_REJECTED ? `code=${env.data.code}` :
      env.type === TYPES.AUCTION_EXTENDED ? `extendCount=${env.data.extendCount} endAtMs=${env.data.endAtMs}` :
      '');
    if (env.type === TYPES.ROOM_SNAPSHOT) {
      // place a bid just above current price (snapshot showed currentPriceCents='10000')
      const amount = (BigInt(env.data.currentPriceCents) + 5000n).toString();
      send(TYPES.BID_PLACE, { clientBidId: 'cbid-smoke-' + Date.now(), amountCents: amount });
    }
    if (env.type === TYPES.BID_ACCEPTED) {
      bidSeqSeen = env.seq;
      setTimeout(() => {
        send(TYPES.PING, {});
        setTimeout(() => {
          // try a too-low bid to verify reject path
          send(TYPES.BID_PLACE, { clientBidId: 'cbid-toolow-' + Date.now(), amountCents: '1' });
          setTimeout(() => {
            ws.close();
            resolve();
          }, 500);
        }, 300);
      }, 300);
    }
  });
  ws.on('error', reject);
  ws.on('close', () => resolve());
  setTimeout(() => reject(new Error('timeout')), 8000);
});

// Assertions
const seenTypes = received.map((e) => e.type);
const errors = [];

const must = (cond, msg) => { if (!cond) errors.push(msg); };

must(seenTypes.includes(TYPES.ROOM_SNAPSHOT), 'missing ROOM_SNAPSHOT');
must(seenTypes.includes(TYPES.BID_ACCEPTED), 'missing BID_ACCEPTED');
must(seenTypes.includes(TYPES.BID_REJECTED), 'missing BID_REJECTED (too-low test)');
must(seenTypes.includes(TYPES.PONG), 'missing PONG');

received.forEach((env) => {
  must(env.schemaVersion === SCHEMA, `${env.type}: schemaVersion=${env.schemaVersion} expected ${SCHEMA}`);
  must(typeof env.serverTimeMs === 'number', `${env.type}: missing/non-number serverTimeMs`);
  if (env.type === TYPES.ROOM_SNAPSHOT) {
    must(typeof env.data.currentPriceCents === 'string', `ROOM_SNAPSHOT.currentPriceCents not string`);
    must(typeof env.data.endAtMs === 'number', `ROOM_SNAPSHOT.endAtMs not number`);
    must(env.data.status === 'LIVE', `ROOM_SNAPSHOT.status=${env.data.status} expected LIVE`);
  }
  if (env.type === TYPES.BID_ACCEPTED) {
    must(typeof env.data.amountCents === 'string', `BID_ACCEPTED.amountCents not string`);
    must(typeof env.data.endAtMs === 'number', `BID_ACCEPTED.endAtMs not number`);
    must(env.data.userId === userId, `BID_ACCEPTED.userId=${env.data.userId} expected ${userId}`);
    must(env.data.status === 'LIVE', `BID_ACCEPTED.status=${env.data.status} expected LIVE`);
  }
  if (env.type === TYPES.BID_REJECTED) {
    must(env.data.code === 'ERR_TOO_LOW', `BID_REJECTED.code=${env.data.code} expected ERR_TOO_LOW`);
  }
});

console.log('\n=== results ===');
console.log('events received (' + received.length + '):', seenTypes.join(' · '));
if (errors.length === 0) {
  console.log('✓ ALL ASSERTIONS PASSED');
  process.exit(0);
} else {
  console.log('✗ ' + errors.length + ' FAILURES:');
  errors.forEach((e) => console.log('  · ' + e));
  process.exit(1);
}
