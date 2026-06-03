// Smoke test for second-price (Vickrey) auction mode.
//
// Verifies:
//   - Multi-bidder cap-hit: winner pays runner-up bid.
//   - Single-bidder/no-runner-up: winner pays reserve/start price.
//
// Usage (from repo root):
//   make up && make seed
//   cd apps/web && node scripts/smoke-vickrey.mjs
//
// Advanced:
//   WEB_SMOKE_USE_PRESET_AUCTION=1 and WEB_SMOKE_AID=<id>[,<id2>...]
//   (or VERIFY_AID/AUCTION_ID)
//     → reuse preset auction(s) by index per scenario.
//
// Exits 0 on PASS, 1 on any assertion failure.

import { WebSocket } from 'ws';
import { SCHEMA_VERSION, resolveAuctionId } from './smoke-shared.mjs';
const HOST_HTTP = process.env.HOST_HTTP || process.env.WS_HOST || 'http://localhost:8080';
const HOST_WS = process.env.HOST_WS || process.env.WS_ADDR || 'ws://localhost:8080';

const USE_PRESET_AUCTION =
  process.env.WEB_SMOKE_USE_PRESET_AUCTION === '1'
  || process.env.WEB_SMOKE_USE_PRESET_AUCTION === 'true';
const PRESET_AUCTION_IDS = USE_PRESET_AUCTION
  ? resolveAuctionId({ scriptName: 'smoke-vickrey' })
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  : [];

const errors = [];
const must = (cond, msg) => {
  if (!cond) errors.push(msg);
};

async function devLogin(nick) {
  const r = await fetch(`${HOST_HTTP}/api/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname: nick }),
  });
  if (!r.ok) {
    throw new Error(`dev-login ${r.status} ${nick}`);
  }
  return r.json();
}

async function api(token, path, opts = {}) {
  const r = await fetch(`${HOST_HTTP}/api${path}`, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`${opts.method || 'GET'} ${path} → ${r.status}: ${body}`);
  }
  if (r.status === 204) return null;
  return r.json();
}

function send(ws, type, auctionId, data) {
  ws.send(
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      type,
      auctionId,
      serverTimeMs: Date.now(),
      data,
    }),
  );
}

async function createSecondPriceAuction(sellerToken, { durationSec = 8, capCents = '30000', reserveCents = '10000', bidStepCents = '1000' }) {
  const { productId } = await api(sellerToken, '/products', {
    method: 'POST',
    body: {
      name: 'Vickrey Smoke Product',
      imageUrl: '',
      description: 'Second-price verification seed',
    },
  });

  const { auctionId } = await api(sellerToken, '/auctions', {
    method: 'POST',
    body: {
      productId,
      factsConfirmed: true,
      rules: {
        startPriceCents: reserveCents,
        incrementCents: bidStepCents,
        durationSec,
        extendWindowSec: 0,
        extendSec: 0,
        maxExtensions: 0,
        capPriceCents: capCents,
        auctionMode: 'second_price',
      },
    },
  });

  await api(sellerToken, `/auctions/${auctionId}/freeze`, { method: 'POST' });
  await api(sellerToken, `/auctions/${auctionId}/start`, { method: 'POST' });
  return { auctionId, reserveCents };
}

async function runScenario({
  title,
  bids,
  expectedWinnerNick,
  expectedAmountCents,
  expectedReserveCents = '10000',
  presetAuctionIndex = 0,
}) {
  console.log(`\n[scenario] ${title}`);

  const slug = title.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
  const presetAuctionId =
    USE_PRESET_AUCTION
      ? PRESET_AUCTION_IDS[presetAuctionIndex] || ''
      : '';

  if (USE_PRESET_AUCTION && !presetAuctionId) {
    must(
      false,
      `preset auction index ${presetAuctionIndex} not provided in WEB_SMOKE_AID (got ${PRESET_AUCTION_IDS.length} id(s): ${PRESET_AUCTION_IDS.join(',') || '<empty>'})`,
    );
    return;
  }

  const sellerToken = presetAuctionId
    ? null
    : (await devLogin(`vickrey-${slug}-seller`)).token;

  const { auctionId, reserveCents } = presetAuctionId
    ? { auctionId: presetAuctionId, reserveCents: expectedReserveCents }
    : await createSecondPriceAuction(sellerToken, {
      durationSec: 9,
      capCents: '30000',
      reserveCents: expectedReserveCents,
      bidStepCents: '1000',
    });
  if (!auctionId) {
    must(false, `failed to resolve auction for scenario="${title}"`);
    return;
  }

  const bidders = await Promise.all(
    bids.map(async (bid) => ({
      ...bid,
      ...(await devLogin(`vickrey-${slug}-${bid.nick}`)),
    })),
  );

  const userIdByNick = new Map();
  const nickByUserId = new Map();
  for (const b of bidders) {
    userIdByNick.set(b.nick, b.userId);
    nickByUserId.set(b.userId, b.nick);
  }

  const expectedWinnerUserId = userIdByNick.get(expectedWinnerNick);
  must(Boolean(expectedWinnerUserId), `expected winner nick "${expectedWinnerNick}" was not logged in`);

  const sockets = [];
  let soldData = null;
  let snapshotCount = 0;
  const done = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`[${title}] timeout waiting for AUCTION_SOLD`));
    }, 15_000);

    for (const bidder of bidders) {
      const ws = new WebSocket(`${HOST_WS}/ws?token=${encodeURIComponent(bidder.token)}&auction=${encodeURIComponent(auctionId)}`);
      sockets.push(ws);
      let bidPlaced = false;

      ws.on('open', () => {
        send(ws, 'ROOM_JOIN', auctionId, { auctionId });
      });

      ws.on('message', (raw) => {
        const env = JSON.parse(raw.toString());
        if (env.type === 'ROOM_SNAPSHOT') {
          snapshotCount += 1;
          if (!bidPlaced) {
            bidPlaced = true;
            send(
              ws,
              'BID_PLACE',
              auctionId,
              {
                clientBidId: `cbid-${bidder.nick}-${Date.now()}`,
                amountCents: bidder.amountCents,
              },
            );
          }
          return;
        }

        if (env.type === 'BID_REJECTED') {
          const msg = `[${title}] ${bidder.nick} BID_REJECTED code=${env.data?.code} amount=${bidder.amountCents}`;
          must(false, msg);
        }

        if (env.type === 'AUCTION_SOLD') {
          soldData = env.data;
          clearTimeout(timeout);
          for (const s of sockets) {
            if (s.readyState === s.OPEN || s.readyState === s.CONNECTING) {
              s.close();
            }
          }
          resolve();
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        for (const s of sockets) {
          if (s.readyState === s.OPEN || s.readyState === s.CONNECTING) {
            s.close();
          }
        }
        reject(err);
      });
    }
  });

  try {
    await done;
  } catch (e) {
    throw e;
  }

  must(snapshotCount === bidders.length, `expected ${bidders.length} ROOM_SNAPSHOT events, got ${snapshotCount}`);
  must(soldData !== null, `expected AUCTION_SOLD, got none`);
  if (soldData) {
    must(soldData.winnerId === expectedWinnerUserId, `winner mismatch: expected ${expectedWinnerNick}(${expectedWinnerUserId}), got ${soldData.winnerId}`);
    const expectedAmount = expectedAmountCents;
    must(soldData.amountCents === expectedAmount, `sold amount mismatch: expected ${expectedAmount}, got ${soldData.amountCents}`);
  }

  console.log(
    `[scenario] ${title} PASS winner=${soldData?.winnerId || 'n/a'} winnerNick=${nickByUserId.get(soldData?.winnerId) || 'n/a'} amount=${soldData?.amountCents || 'n/a'}`,
  );
}

await runScenario({
  title: 'vickrey runner-up should pay second price',
  bids: [
    { nick: 'runner-up-lower', amountCents: '11000' },
    { nick: 'runner-up', amountCents: '12000' },
    { nick: 'winner', amountCents: '25000' },
  ],
  expectedWinnerNick: 'winner',
  expectedAmountCents: '12000',
  presetAuctionIndex: 0,
});

await runScenario({
  title: 'vickrey no runner-up falls back to reserve',
  bids: [
    { nick: 'solo', amountCents: '30000' },
  ],
  expectedWinnerNick: 'solo',
  expectedAmountCents: '10000',
  presetAuctionIndex: 1,
});

if (errors.length === 0) {
  console.log('\n✓ Vickrey second-price smoke PASSED');
  process.exit(0);
}

console.log('\n✗ Vickrey second-price smoke FAILURES:');
for (const e of errors) {
  console.log('  ·', e);
}
process.exit(1);
