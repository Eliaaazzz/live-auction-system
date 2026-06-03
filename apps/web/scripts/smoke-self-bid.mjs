// Smoke test for seller self-bid rejection.
// Verifies TC-T6-115: seller self-bid should be rejected as
// ERR_NOT_ALLOWED with documented CN copy in the frontend contract.
//
// Scenario:
//   1. Login as seller
//   2. Create product + auction (factsConfirmed=true)
//   3. Freeze + start auction
//   4. Open WS as the same seller user and try BID_PLACE
//   5. Expect BID_REJECTED with code ERR_NOT_ALLOWED
//
// Usage (from repo root):
//   make up && make seed
//   cd apps/web && node scripts/smoke-self-bid.mjs
//
// Exits 0 on PASS, 1 on any assertion failure.

import { WebSocket } from 'ws';
import { SCHEMA_VERSION } from './smoke-shared.mjs';

const HOST_HTTP = process.env.HOST_HTTP || process.env.WS_HOST || 'http://localhost:8080';
const HOST_WS = process.env.HOST_WS || process.env.WS_ADDR || 'ws://localhost:8080';

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

console.log('[setup] seller dev-login');
const seller = await devLogin('fari-selfbid-seller');

console.log('[setup] create product + auction (factsConfirmed=true)');
const { productId } = await api(seller.token, '/products', {
  method: 'POST',
  body: { name: 'Self-bid Smoke', imageUrl: '', description: '' },
});

const { auctionId } = await api(seller.token, '/auctions', {
  method: 'POST',
  body: {
    productId,
    rules: {
      startPriceCents:   '10000',
      incrementCents:    '500',
      durationSec:       30,
      extendWindowSec:   0,
      extendSec:         0,
      maxExtensions:     0,
      capPriceCents:     '0',
    },
    factsConfirmed: true,
  },
});
console.log('[setup] auctionId =', auctionId);

console.log('[setup] freeze');
await api(seller.token, `/auctions/${auctionId}/freeze`, { method: 'POST' });

console.log('[setup] start');
await api(seller.token, `/auctions/${auctionId}/start`, { method: 'POST' });

let seenSnapshot = false;
let gotSelfBidReject = false;
let seenAccepted = false;

const ws = new WebSocket(`${HOST_WS}/ws?token=${encodeURIComponent(seller.token)}&auction=${encodeURIComponent(auctionId)}`);

await new Promise((resolve, reject) => {
  const cleanup = () => {
    if (ws.readyState === ws.OPEN) ws.close();
  };

  ws.on('open', () => {
    ws.send(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      type: 'ROOM_JOIN',
      auctionId,
      serverTimeMs: Date.now(),
      data: { auctionId },
    }));
  });

  ws.on('message', (raw) => {
    const env = JSON.parse(raw.toString());
    if (env.type === 'ROOM_SNAPSHOT') {
      seenSnapshot = true;
      const next = (BigInt(env.data.currentPriceCents) + 500n).toString();
      ws.send(JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        type: 'BID_PLACE',
        auctionId,
        serverTimeMs: Date.now(),
        data: {
          clientBidId: `cbid-self-bid-${Date.now()}`,
          amountCents: next,
        },
      }));
      return;
    }

    if (env.type === 'BID_REJECTED') {
      if (env.data?.code === 'ERR_NOT_ALLOWED') {
        gotSelfBidReject = true;
        cleanup();
        resolve();
        return;
      }
      errors.push(`unexpected reject code: ${env.data?.code}`);
      cleanup();
      resolve();
    }

    if (env.type === 'BID_ACCEPTED') {
      seenAccepted = true;
      errors.push('seller was unexpectedly accepted on own bid (BID_ACCEPTED)');
      cleanup();
      resolve();
    }
  });

  ws.on('error', (err) => {
    cleanup();
    reject(err);
  });
  ws.on('close', () => resolve());
  setTimeout(() => {
    errors.push('timeout waiting for bidder rejection');
    cleanup();
    resolve();
  }, 10000);
});

must(seenSnapshot, 'expected ROOM_SNAPSHOT before bid attempt');
must(gotSelfBidReject, 'expected BID_REJECTED { code: ERR_NOT_ALLOWED } for seller self-bid');
must(!seenAccepted, 'seller was accepted on own bid');

console.log('\n[assert] checking seller self-bid contract');
if (errors.length === 0) {
  console.log('✓ TC-T6-115 PASS (seller self-bid -> ERR_NOT_ALLOWED)');
  process.exit(0);
} else {
  console.log('✗ ' + errors.length + ' FAILURES:');
  errors.forEach((e) => console.log('  · ' + e));
  process.exit(1);
}
