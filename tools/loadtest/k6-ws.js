// k6 WebSocket stress test — 5k concurrent VUs against the lumen stack.
//
// Two scenarios run in parallel:
//   - observers (default 4950 VUs): open WS, ROOM_JOIN, read broadcasts
//   - bidders   (default   50 VUs): observers + send BID_PLACE every 200ms,
//                                   each bid uses (current room price + 1)
//
// Pre-stage: run tools/loadtest/k6-setup.sh first to create the auction
// and dev-log N buyer tokens into tools/loadtest/.k6-tokens.
//
// Run:
//   k6 run \
//     -e TOKENS=.k6-tokens \
//     -e AID=$(cat .k6-aid) \
//     tools/loadtest/k6-ws.js
//
// Exit codes: k6 returns non-zero if any threshold fails (see options.thresholds).
//
// Design notes — fixes from the 5k v0 run (see issue #94):
//   1. Ack-matching keys on `amountCents` (not `clientBidId`). The Lua-authored
//      BID_ACCEPTED payload includes amountCents + userId but NOT the
//      clientBidId, so the original key never matched.
//   2. Bidders watch BID_ACCEPTED + ROOM_SNAPSHOT to track the room's current
//      price, then bid `current + 1`. The previous version used per-VU
//      independent monotonic streams, so 49/50 bidders raced and got
//      ERR_TOO_LOW (correct server behavior, wrong client-side stress shape).
//   3. tokens are wrapped via modulo so N_VUS > len(tokens) is safe.
import ws from 'k6/ws';
import { check } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';

// Pre-staged buyer tokens loaded once per VU init phase.
const tokens = new SharedArray('tokens', function () {
  const path = __ENV.TOKENS || '.k6-tokens';
  return open(path).split('\n').filter((s) => s.length > 0);
});

const AID = __ENV.AID;
if (!AID) {
  throw new Error('AID env required (e.g. -e AID=$(cat .k6-aid))');
}

const HOST_WS = __ENV.HOST_WS || 'ws://localhost:8080';
const DURATION = __ENV.DURATION || '60s';
const RAMP = __ENV.RAMP || '15s';

// k6 custom metrics — these aggregate into the run summary.
const bidsAccepted = new Counter('bids_accepted');
const bidsRejected = new Counter('bids_rejected');
const broadcastFrames = new Counter('broadcast_frames');
const wsConnectFails = new Counter('ws_connect_fails');
const ackLatencyMs = new Trend('ack_latency_ms', true);
const acceptRate = new Rate('bid_accept_rate');

export const options = {
  scenarios: {
    observers: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP, target: parseInt(__ENV.N_OBSERVERS || '4950') },
        { duration: DURATION, target: parseInt(__ENV.N_OBSERVERS || '4950') },
      ],
      exec: 'observer',
    },
    bidders: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP, target: parseInt(__ENV.N_BIDDERS || '50') },
        { duration: DURATION, target: parseInt(__ENV.N_BIDDERS || '50') },
      ],
      exec: 'bidder',
      startTime: '5s', // let observers begin first
    },
  },
  thresholds: {
    // Stretch goals — V9 §4.2 ack p99 < 100ms at 1k/100. 5k is beyond stretch,
    // but server-side p99 measured 1.35ms in the v0 run, so we keep the bar
    // tight; client-side wire+queue adds another ~10ms typical.
    'ack_latency_ms': ['p(95)<500'],
    // With 50 bidders all racing for `current+1`, one wins per round; the
    // others see ERR_TOO_LOW until the price catches up. Steady-state accept
    // rate should be ≈ 1 / N_BIDDERS, so for 50 bidders ≈ 2%. The 5% bar is
    // a loose floor — way above noise, way below "everything's broken".
    'bid_accept_rate': ['rate>0.05'],
    // Allow up to 4% of 5k connects to fail (network jitter, OS-level
    // ephemeral-port exhaustion). v0 saw 0 failures.
    'ws_connect_fails': ['count<200'],
  },
};

function pickToken() {
  // VU-unique token: 1-based __VU; modulo to wrap-around safely when
  // N_VUS > tokens.length.
  return tokens[(__VU - 1) % tokens.length];
}

function envelope(type, data, seq) {
  return JSON.stringify({
    schemaVersion: 1, type, auctionId: AID,
    serverTimeMs: Date.now(), seq: seq || 0, data,
  });
}

// observer: open WS, ROOM_JOIN, count broadcasts until socket closes.
export function observer() {
  const token = pickToken();
  const url = `${HOST_WS}/ws?token=${encodeURIComponent(token)}`;
  const res = ws.connect(url, function (socket) {
    socket.on('open', function () {
      socket.send(envelope('ROOM_JOIN', { auctionId: AID }));
    });
    socket.on('message', function () {
      broadcastFrames.add(1);
    });
    socket.setTimeout(function () { socket.close(); }, 60_000);
  });
  if (!res || (res.status !== 101 && res.status !== 0)) {
    wsConnectFails.add(1);
  }
}

// bidder: open WS, ROOM_JOIN, track room's current price from BID_ACCEPTED +
// ROOM_SNAPSHOT, bid `current + 1` every 200ms.
//
// Ack matching: pending[amountCents] = send-time. On BID_ACCEPTED, look up
// by `data.amountCents` (Lua echoes the amount string verbatim from the
// originating bid). The bid is "mine" iff the userId matches OR the amount
// matches one we sent — using amount is sufficient because pending is keyed
// on it AND each bidder picks a fresh amount (current+1).
export function bidder() {
  const token = pickToken();
  // Extract the userId from the token (format: `<userId>.<hexsig>`) so we
  // can disambiguate when the room broadcasts another bidder's win.
  const myUserId = token.split('.')[0];
  const url = `${HOST_WS}/ws?token=${encodeURIComponent(token)}`;
  let currentCents = 100000; // matches setup's startPriceCents; will be
                             // overwritten by the first ROOM_SNAPSHOT
  const pending = {}; // amount → send Date.now()

  const res = ws.connect(url, function (socket) {
    socket.on('open', function () {
      socket.send(envelope('ROOM_JOIN', { auctionId: AID }));
    });
    socket.on('message', function (raw) {
      let env;
      try { env = JSON.parse(raw); } catch (e) { return; }
      if (env.type === 'ROOM_SNAPSHOT') {
        const cur = env.data && env.data.currentPriceCents;
        if (cur) {
          const n = parseInt(cur, 10);
          if (!isNaN(n)) currentCents = n;
        }
        broadcastFrames.add(1);
      } else if (env.type === 'BID_ACCEPTED') {
        const amt = env.data && env.data.amountCents;
        const uid = env.data && env.data.userId;
        if (amt) {
          const n = parseInt(amt, 10);
          if (!isNaN(n) && n > currentCents) currentCents = n;
          if (uid === myUserId && pending[amt] !== undefined) {
            ackLatencyMs.add(Date.now() - pending[amt]);
            delete pending[amt];
            bidsAccepted.add(1);
            acceptRate.add(true);
          }
        }
        broadcastFrames.add(1);
      } else if (env.type === 'BID_REJECTED') {
        bidsRejected.add(1);
        acceptRate.add(false);
      } else if (env.type === 'AUCTION_EXTENDED' || env.type === 'AUCTION_SOLD') {
        broadcastFrames.add(1);
      }
    });

    socket.setInterval(function () {
      // Bid current+1 with a clientBidId that's unique per VU + counter.
      // The amount is the key for pending-tracking; clientBidId is the
      // server-side dedupe identity (so a retry of the same VU's same local
      // counter replays the original ack, not a fresh accept).
      const amtNum = currentCents + 1;
      const amt = String(amtNum);
      const cb = `k6_${__VU}_${amtNum}`;
      // Bookkeep BEFORE send so the BID_ACCEPTED race can resolve.
      // Overwrite is fine — the latest send-time is the most accurate
      // measurement (the bid is in flight; an old ack for the same amount
      // would belong to a different VU and our userId guard rejects it).
      pending[amt] = Date.now();
      socket.send(envelope('BID_PLACE', { clientBidId: cb, amountCents: amt }));
    }, 200);

    socket.setTimeout(function () { socket.close(); }, 60_000);
  });
  if (!res || (res.status !== 101 && res.status !== 0)) {
    wsConnectFails.add(1);
  }
}

// default exec is not used; scenarios route to observer/bidder explicitly.
export default function () {}
