// Smoke test for multi-tab same-account bidding visibility.
//
// Verifies TC-T6-113:
//   tab1 and tab2 use same account token; a bid placed on tab1 should be
//   observed as BID_ACCEPTED on tab2 as well.
//
// Usage (from repo root):
//   make up && make seed
//   cd apps/web && node scripts/smoke-multitab.mjs

import { WebSocket } from 'ws';

const SCHEMA = 1;
const HOST_HTTP = process.env.HOST_HTTP || 'http://localhost:8080';
const HOST_WS = process.env.HOST_WS || 'ws://localhost:8080';

const errors = [];

function must(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

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
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`${opts.method || 'GET'} ${path} → ${r.status}: ${body}`);
  }
  if (r.status === 204) return null;
  return r.json();
}

const send = (ws, type, data, auctionId) => {
  if (ws.readyState !== WebSocket.OPEN) {
    throw new Error(`cannot send ${type}: websocket state=${ws.readyState}`);
  }
  ws.send(
    JSON.stringify({
      schemaVersion: SCHEMA,
      type,
      auctionId,
      serverTimeMs: Date.now(),
      data,
    }),
  );
};

console.log('[setup] login buyer');
const buyer = await devLogin('fari-multitab-buyer');

console.log('[setup] create product + auction');
const { productId } = await api(buyer.token, '/products', {
  method: 'POST',
  body: { name: 'Multi-tab smoke', imageUrl: '', description: '' },
});

const { auctionId } = await api(buyer.token, '/auctions', {
  method: 'POST',
  body: {
    productId,
    rules: {
      startPriceCents: '10000',
      incrementCents: '500',
      durationSec: 60,
      extendWindowSec: 0,
      extendSec: 0,
      maxExtensions: 0,
      capPriceCents: '0',
    },
    factsConfirmed: true,
  },
});

console.log('[setup] freeze + start');
await api(buyer.token, `/auctions/${auctionId}/freeze`, { method: 'POST' });
await api(buyer.token, `/auctions/${auctionId}/start`, { method: 'POST' });

const state = {
  ws1: { snapshot: false, acceptedSeqs: [], snapshotPrice: null },
  ws2: { snapshot: false, acceptedSeqs: [] },
};

const joinEvent = { auctionId };
let bidPlaced = false;
let done = false;
let sharedSeq = null;
let doneTimer = null;
let openCount = 0;

const maybeResolve = (resolve, cleanup) => {
  const seq1 = state.ws1.acceptedSeqs[0];
  const seq2 = state.ws2.acceptedSeqs[0];
  if (seq1 !== undefined && seq2 !== undefined && seq1 === seq2) {
    sharedSeq = seq1;
    done = true;
    cleanup();
    resolve();
    return;
  }
  const firstCommon = state.ws1.acceptedSeqs.find((s) => state.ws2.acceptedSeqs.includes(s));
  if (firstCommon !== undefined) {
    sharedSeq = firstCommon;
    done = true;
    cleanup();
    resolve();
  }
};

await new Promise((resolve, reject) => {
  const ws1 = new WebSocket(`${HOST_WS}/ws?token=${encodeURIComponent(buyer.token)}&auction=${encodeURIComponent(auctionId)}`);
  const ws2 = new WebSocket(`${HOST_WS}/ws?token=${encodeURIComponent(buyer.token)}&auction=${encodeURIComponent(auctionId)}`);

  const cleanup = () => {
    [ws1, ws2].forEach((ws) => {
      if (ws.readyState === ws.OPEN) ws.close();
    });
  };

  const onOpen = () => {
    openCount += 1;
    if (openCount < 2) return;
    send(ws1, 'ROOM_JOIN', joinEvent, auctionId);
    send(ws2, 'ROOM_JOIN', joinEvent, auctionId);
  };

  const onMessage = (key, raw) => {
    let env;
    try {
      env = JSON.parse(raw.toString());
    } catch (err) {
      errors.push(`malformed websocket frame on ${key}: ${err.message}`);
      return;
    }

    if (env.type === 'ROOM_SNAPSHOT') {
      state[key].snapshot = true;
      if (!state[key].snapshotPrice) {
        state[key].snapshotPrice = env.data.currentPriceCents;
      }

      if (!bidPlaced && state.ws1.snapshot && state.ws2.snapshot && state.ws1.snapshotPrice) {
        const next = (BigInt(state.ws1.snapshotPrice) + 5000n).toString();
        send(ws1, 'BID_PLACE', {
          clientBidId: `cbid-mt-${Date.now()}`,
          amountCents: next,
        }, auctionId);
        bidPlaced = true;
      }
      return;
    }

    if (env.type === 'BID_REJECTED') {
      if (env.data?.code) {
        errors.push(`unexpected BID_REJECTED code=${env.data.code}`);
      } else {
        errors.push('unexpected BID_REJECTED (code missing)');
      }
      cleanup();
      resolve();
      return;
    }

    if (env.type === 'BID_ACCEPTED') {
      state[key].acceptedSeqs.push(env.seq);
      if (!done) maybeResolve(resolve, cleanup);
      return;
    }
  };

  ws1.on('open', onOpen);
  ws2.on('open', onOpen);

  ws1.on('message', (raw) => onMessage('ws1', raw));
  ws2.on('message', (raw) => onMessage('ws2', raw));

  const finalize = (err) => {
    if (done) return;
    cleanup();
    if (err) reject(err);
    else resolve();
  };

  ws1.on('error', (err) => finalize(new Error(`ws1 error: ${err.message}`)));
  ws2.on('error', (err) => finalize(new Error(`ws2 error: ${err.message}`)));
  ws1.on('close', () => {
    if (!done) finalize();
  });
  ws2.on('close', () => {
    if (!done) finalize();
  });

  doneTimer = setTimeout(() => {
    if (!done) {
      done = true;
      cleanup();
      reject(new Error('timeout waiting for acceptance on both tabs'));
    }
  }, 12000);
}).finally(() => {
  if (doneTimer) clearTimeout(doneTimer);
});

must(state.ws1.snapshot, 'ws1 did not receive ROOM_SNAPSHOT');
must(state.ws2.snapshot, 'ws2 did not receive ROOM_SNAPSHOT');
must(state.ws1.acceptedSeqs.length > 0, 'ws1 did not receive BID_ACCEPTED');
must(state.ws2.acceptedSeqs.length > 0, 'ws2 did not receive BID_ACCEPTED');
must(sharedSeq !== null, 'ws1 and ws2 did not observe matching BID_ACCEPTED seq');

const ws1Msg = `ws1 accepted seqs=${state.ws1.acceptedSeqs.join(',')}`;
const ws2Msg = `ws2 accepted seqs=${state.ws2.acceptedSeqs.join(',')}`;
if (errors.length > 0) {
  console.log('✗ TC-T6-113 FAILURES:');
  errors.forEach((e) => console.log('  · ' + e));
  console.log(`${ws1Msg}; ${ws2Msg}; sharedSeq=${sharedSeq}`);
  process.exit(1);
}

console.log('✓ TC-T6-113 PASS (same account on tab1 tab2, BID_ACCEPTED observed on both)');
console.log(`${ws1Msg}; ${ws2Msg}; sharedSeq=${sharedSeq}`);
process.exit(0);
