// Smoke for per-connection BID_PLACE burst control.
// Verifies TC-T6-116: two BID_PLACE frames within ~100ms on same socket should
// yield ERR_RATE_LIMITED on the second frame.
//
// Usage (from repo root):
//   make up && make seed
//   cd apps/web && node scripts/smoke-ratelimit.mjs
// Optional overrides:
//   HOST_HTTP=http://localhost:8080 HOST_WS=ws://localhost:8080 \
//   AUCTION_ID=auc_demo BURST_MS=10 TIMEOUT_MS=8000 node scripts/smoke-ratelimit.mjs

import { WebSocket } from 'ws';

const SCHEMA = 1;
const HOST_HTTP = process.env.HOST_HTTP || 'http://localhost:8080';
const HOST_WS = process.env.HOST_WS || 'ws://localhost:8080';
const AUCTION_ID = process.env.VERIFY_AID || process.env.AUCTION_ID || 'auc_demo';
const BURST_MS = Number.isFinite(Number(process.env.BURST_MS)) && Number(process.env.BURST_MS) >= 0
  ? Number(process.env.BURST_MS)
  : 10;
const TIMEOUT_MS = Number.isFinite(Number(process.env.TIMEOUT_MS)) && Number(process.env.TIMEOUT_MS) > 0
  ? Number(process.env.TIMEOUT_MS)
  : 8000;

function must(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

async function devLogin(nick) {
  let r;
  try {
    r = await fetch(`${HOST_HTTP}/api/dev-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nickname: nick }),
    });
  } catch (err) {
    throw new Error(`dev-login failed for ${HOST_HTTP}: ${err.message}`);
  }
  must(r.ok, `dev-login ${r.status}`);
  return r.json();
}

const send = (ws, type, data, auctionId = AUCTION_ID) => {
  const env = {
    schemaVersion: SCHEMA,
    type,
    auctionId,
    serverTimeMs: Date.now(),
    data,
  };
  ws.send(JSON.stringify(env));
};

const { token } = await devLogin('fari-ratelimit');
console.log('login ok, token len=', token.length);

const results = {
  gotSnapshot: false,
  gotAccepted: false,
  gotRateLimit: false,
  rateLimitData: null,
  events: [],
};

await new Promise((resolve, reject) => {
  const ws = new WebSocket(`${HOST_WS}/ws?auction=${encodeURIComponent(AUCTION_ID)}&token=${encodeURIComponent(token)}`);
  const cleanup = () => {
    if (ws.readyState === ws.OPEN) ws.close();
  };

  let sentSecond = false;

  ws.on('open', () => {
    send(ws, 'ROOM_JOIN', { auctionId: AUCTION_ID });
    console.log('[ws] open');
  });

  ws.on('message', (raw) => {
    const env = JSON.parse(raw.toString());
    results.events.push(env);
    if (env.type === 'ROOM_SNAPSHOT') {
      results.gotSnapshot = true;
      must(env.data.status === 'LIVE', `auction status ${env.data.status} not LIVE`);
      const amount = (BigInt(env.data.currentPriceCents) + 5_000n).toString();
      send(ws, 'BID_PLACE', {
        clientBidId: `cbid-ratelimit-1-${Date.now()}`,
        amountCents: amount,
      });
      // Burst: immediate second bid should be rejected at gateway rate limit.
      setTimeout(() => {
        sentSecond = true;
        send(ws, 'BID_PLACE', {
          clientBidId: `cbid-ratelimit-2-${Date.now()}`,
          amountCents: (BigInt(amount) + 1n).toString(),
        });
      }, BURST_MS);
    }

    if (env.type === 'BID_ACCEPTED') {
      results.gotAccepted = true;
    }

    if (env.type === 'BID_REJECTED') {
      if (env.data?.code === 'ERR_RATE_LIMITED') {
        results.gotRateLimit = true;
        results.rateLimitData = env;
      }
    }

    if (results.gotSnapshot && sentSecond && results.gotAccepted && results.gotRateLimit) {
      cleanup();
      resolve();
      return;
    }

    // Leave some headroom for first accept / reject sequence to arrive.
    if (results.events.length >= 8) {
      cleanup();
      resolve();
    }
  });

  ws.on('error', (err) => {
    cleanup();
    reject(new Error(`ws error: ${err.message}`));
  });

  ws.on('close', () => {
    resolve();
  });

  setTimeout(() => {
    cleanup();
    reject(new Error('timeout waiting for rate-limit reject'));
  }, TIMEOUT_MS);
});

must(results.gotSnapshot, 'missing ROOM_SNAPSHOT');
must(results.gotAccepted, 'missing BID_ACCEPTED from first burst bid');
must(results.gotRateLimit, 'missing BID_REJECTED{ERR_RATE_LIMITED} for rapid second bid');
must(results.rateLimitData?.data?.code === 'ERR_RATE_LIMITED', `reject code not ERR_RATE_LIMITED: ${JSON.stringify(results.rateLimitData)}`);

console.log('✓ TC-T6-116 PASS (rapid second BID_PLACE => ERR_RATE_LIMITED)');
console.log('events:', results.events.map((e) => `${e.type}${e.data?.code ? `:${e.data.code}` : ''}`).join(' · '));
process.exit(0);
