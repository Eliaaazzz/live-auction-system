import { login } from './smoke-shared.mjs';

const HOST_HTTP = process.env.HOST_HTTP || process.env.WS_HOST || 'http://localhost:8080';

const errors = [];
const must = (cond, msg) => {
  if (!cond) errors.push(msg);
};

async function apiJSON(token, path, options = {}) {
  const r = await fetch(`${HOST_HTTP}/api${path}`, {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await r.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }

  if (!r.ok) {
    throw new Error(`${options.method || 'GET'} ${path} → ${r.status} ${text || '(empty body)'}`);
  }

  return body;
}

async function createProduct(token) {
  const out = await apiJSON(token, '/products', {
    method: 'POST',
    body: {
      name: 'Reserve Advisor Script Product',
      imageUrl: 'https://example.com/product.jpg',
      description: 'Smoke test product for reserve advisor edges',
    },
  });
  return out.productId;
}

async function createAuction(token, productId, rules) {
  const out = await apiJSON(token, '/auctions', {
    method: 'POST',
    body: {
      productId,
      rules,
      factsConfirmed: true,
    },
  });
  return out.auctionId;
}

function assertReason(auction, expected, label) {
  must(auction.status === 'LIVE' || auction.status === 'DRAFT' || auction.status === 'SCHEDULED', `${label}: unexpected status ${auction.status}`);
  must(auction.advice?.reasonCode === expected, `${label}: reasonCode=${auction.advice?.reasonCode} want ${expected}`);
}

const seller = await login(HOST_HTTP, 'reserve-advisor-smoke-seller');

// Case 1: not-live auction should return AUCTION_NOT_LIVE.
const draftProductId = await createProduct(seller.token);
const draftAuctionId = await createAuction(seller.token, draftProductId, {
  startPriceCents: '10000',
  incrementCents: '1000',
  capPriceCents: '20000',
  durationSec: 60,
});

const draftAdvice = await apiJSON(seller.token, `/auctions/${draftAuctionId}/reserve-advisor`);
must(draftAdvice.auctionId === draftAuctionId, 'draft case: auctionId should echo requested id');
must(draftAdvice.status === 'DRAFT', `draft case: status=${draftAdvice.status} want DRAFT`);
must(draftAdvice.advice?.reasonCode === 'AUCTION_NOT_LIVE', `draft case: reasonCode=${draftAdvice.advice?.reasonCode} want AUCTION_NOT_LIVE`);

// Case 2: live auction with no cap uses OK_NO_CAP.
await apiJSON(seller.token, `/auctions/${draftAuctionId}/freeze`, { method: 'POST' });
await apiJSON(seller.token, `/auctions/${draftAuctionId}/start`, {
  method: 'POST',
  body: { durationMs: 30000 },
});

const liveNoCap = await apiJSON(seller.token, `/auctions/${draftAuctionId}/reserve-advisor`);
assertReason(liveNoCap, 'OK_NO_CAP', 'no-cap case');
must(liveNoCap.status === 'LIVE', `no-cap case: status=${liveNoCap.status} want LIVE`);
must(liveNoCap.advice?.minBidCents === '11000', `no-cap case: minBidCents=${liveNoCap.advice?.minBidCents} want 11000`);
must(BigInt(liveNoCap.advice?.maxBidCents) >= BigInt(liveNoCap.advice?.minBidCents),
  `no-cap case: maxBidCents=${liveNoCap.advice?.maxBidCents} should be >= minBidCents=${liveNoCap.advice?.minBidCents}`,
);
must(liveNoCap.advice?.confidence > 0.5, `no-cap case: confidence=${liveNoCap.advice?.confidence} should be > 0.5`);

// Case 3: live auction with unreachable bid window returns UNREACHABLE_BID_RANGE.
const capProductId = await createProduct(seller.token);
const capAuctionId = await createAuction(seller.token, capProductId, {
  startPriceCents: '10000',
  incrementCents: '5000',
  capPriceCents: '11000',
  durationSec: 60,
});
await apiJSON(seller.token, `/auctions/${capAuctionId}/freeze`, { method: 'POST' });
await apiJSON(seller.token, `/auctions/${capAuctionId}/start`, {
  method: 'POST',
  body: { durationMs: 30000 },
});

const capAdvice = await apiJSON(seller.token, `/auctions/${capAuctionId}/reserve-advisor`);
assertReason(capAdvice, 'UNREACHABLE_BID_RANGE', 'unreachable-cap case');
must(capAdvice.status === 'LIVE', `unreachable-cap case: status=${capAdvice.status} want LIVE`);
must(BigInt(capAdvice.advice?.minBidCents) > BigInt(capAdvice.advice?.maxBidCents),
  `unreachable-cap case: minBidCents=${capAdvice.advice?.minBidCents} should be > maxBidCents=${capAdvice.advice?.maxBidCents}`,
);
must(capAdvice.advice?.confidence === 0, `unreachable-cap case: confidence=${capAdvice.advice?.confidence} should be 0`);

console.log('[reserve-advisor smoke] done');
if (errors.length === 0) {
  console.log('✓ reserve-advisor edge cases PASSED');
  process.exit(0);
}

console.log('✗ reserve-advisor smoke failed:');
for (const err of errors) {
  console.log('  ·', err);
}
process.exit(1);
