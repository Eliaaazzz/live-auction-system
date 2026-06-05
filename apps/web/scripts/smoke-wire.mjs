// Smoke test for the apps/web wire layer against a running backend.
// Mirrors the envelope shape from apps/web/src/lib/ws.js so wire-contract
// drift surfaces here before browser testing.
//
// Usage, local fixture:
//   make up && make seed
//   cd apps/web && node scripts/smoke-wire.mjs
//
// Usage, deployed LIVE auction:
//   HOST_HTTP=http://lumenauction.cn HOST_WS=ws://lumenauction.cn \
//   LOGIN_PATH=/api/login AUCTION_ID=<live-auction-id> node scripts/smoke-wire.mjs
//
// Exits 0 on PASS, 1 on any assertion failure. Covers TC-T6-001/004-013 from
// docs/test-cases/T6-frontend-wire.md.

import { WebSocket } from 'ws';

const DEFAULT_SCHEMA = 2;
const SCHEMA = parsePositiveInt(process.env.WS_SCHEMA_VERSION || process.env.SCHEMA_VERSION, DEFAULT_SCHEMA);
const AUCTION_ID = process.env.WEB_SMOKE_AID || process.env.VERIFY_AID || process.env.AUCTION_ID || 'auc_demo';
const HOST_HTTP = stripTrailingSlash(
  process.env.HOST_HTTP
    || process.env.WEB_SMOKE_BASE_URL
    || process.env.BASE_URL
    || 'http://localhost:8080',
);
const HOST_WS = stripTrailingSlash(
  process.env.HOST_WS
    || process.env.BASE_WS_URL
    || deriveWsBase(HOST_HTTP),
);
const LOGIN_PATH = normalizePath(process.env.LOGIN_PATH || '/api/dev-login');
const SMOKE_NICKNAME = process.env.SMOKE_NICKNAME || 'fari-smoke';
const TIMEOUT_MS = parsePositiveInt(process.env.SMOKE_TIMEOUT_MS, 8000);
const BID_STEP_CENTS = BigInt(process.env.SMOKE_BID_STEP_CENTS || '5000');

const TYPES = {
  ROOM_JOIN: 'ROOM_JOIN',
  BID_PLACE: 'BID_PLACE',
  PING: 'PING',
  ROOM_SNAPSHOT: 'ROOM_SNAPSHOT',
  BID_ACCEPTED: 'BID_ACCEPTED',
  BID_REJECTED: 'BID_REJECTED',
  AUCTION_EXTENDED: 'AUCTION_EXTENDED',
  AUCTION_SOLD: 'AUCTION_SOLD',
  AUCTION_NO_BID: 'AUCTION_NO_BID',
  AUCTION_CANCELLED: 'AUCTION_CANCELLED',
  PONG: 'PONG',
};

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function normalizePath(value) {
  return value.startsWith('/') ? value : `/${value}`;
}

function deriveWsBase(httpBase) {
  if (httpBase.startsWith('https://')) return `wss://${httpBase.slice('https://'.length)}`;
  if (httpBase.startsWith('http://')) return `ws://${httpBase.slice('http://'.length)}`;
  throw new Error(`HOST_HTTP must start with http:// or https://, got ${httpBase}`);
}

function parsePositiveInt(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid positive integer: ${raw}`);
  return n;
}

async function login() {
  const r = await fetch(`${HOST_HTTP}${LOGIN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname: SMOKE_NICKNAME }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`${LOGIN_PATH} ${r.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
  }
  const payload = await r.json();
  if (!payload.userId || !payload.token) {
    throw new Error(`${LOGIN_PATH} response missing userId/token`);
  }
  return payload;
}

const { userId, token, nickname } = await login();
console.log('login ->', { userId, nickname, tokenLen: token.length, loginPath: LOGIN_PATH });

const ws = new WebSocket(`${HOST_WS}/ws?token=${encodeURIComponent(token)}`);
const received = [];
let snapshotSeq = 0;
let ownAccepted = null;
let postBidChecksStarted = false;
let bidSent = false;

const send = (type, data) => {
  const env = { schemaVersion: SCHEMA, type, auctionId: AUCTION_ID, serverTimeMs: Date.now(), data };
  ws.send(JSON.stringify(env));
  console.log('sent', type, data);
};

await new Promise((resolve, reject) => {
  let settled = false;
  let timer;
  const finish = (fn, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    fn(value);
  };
  timer = setTimeout(() => finish(reject, new Error(`timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);

  ws.on('open', () => {
    console.log('ws open', { hostWs: HOST_WS, auctionId: AUCTION_ID, schema: SCHEMA });
    send(TYPES.ROOM_JOIN, { auctionId: AUCTION_ID });
  });
  ws.on('message', (raw) => {
    try {
      const env = JSON.parse(raw.toString());
      received.push(env);
      console.log('recv', env.type, 'seq=' + env.seq, 'schemaVer=' + env.schemaVersion,
        env.type === TYPES.ROOM_SNAPSHOT ? `status=${env.data.status} price=${env.data.currentPriceCents}` :
        env.type === TYPES.BID_ACCEPTED ? `winner=${env.data.userId} amount=${env.data.amountCents} status=${env.data.status} endAtMs=${env.data.endAtMs}` :
        env.type === TYPES.BID_REJECTED ? `code=${env.data.code}` :
        env.type === TYPES.AUCTION_EXTENDED ? `extendCount=${env.data.extendCount} endAtMs=${env.data.endAtMs}` :
        '');

      if (env.type === TYPES.ROOM_SNAPSHOT && !bidSent) {
        bidSent = true;
        snapshotSeq = env.seq ?? env.data.seq ?? 0;
        const amount = (BigInt(env.data.currentPriceCents) + BID_STEP_CENTS).toString();
        send(TYPES.BID_PLACE, { clientBidId: 'cbid-smoke-' + Date.now(), amountCents: amount });
      }

      if (
        env.type === TYPES.BID_ACCEPTED
        && env.data.userId === userId
        && typeof env.seq === 'number'
        && env.seq > snapshotSeq
      ) {
        ownAccepted = env;
        if (postBidChecksStarted) return;
        postBidChecksStarted = true;
        setTimeout(() => {
          send(TYPES.PING, {});
          setTimeout(() => {
            send(TYPES.BID_PLACE, { clientBidId: 'cbid-toolow-' + Date.now(), amountCents: '1' });
            setTimeout(() => {
              ws.close();
              finish(resolve);
            }, 500);
          }, 300);
        }, 300);
      }
    } catch (err) {
      finish(reject, err);
    }
  });
  ws.on('error', (err) => finish(reject, err));
  ws.on('close', () => finish(resolve));
});

const seenTypes = received.map((e) => e.type);
const errors = [];

const must = (cond, msg) => { if (!cond) errors.push(msg); };

must(seenTypes.includes(TYPES.ROOM_SNAPSHOT), 'missing ROOM_SNAPSHOT');
must(seenTypes.includes(TYPES.BID_ACCEPTED), 'missing BID_ACCEPTED');
must(ownAccepted, `missing BID_ACCEPTED for smoke user ${userId}`);
must(seenTypes.includes(TYPES.BID_REJECTED), 'missing BID_REJECTED (too-low test)');
must(seenTypes.includes(TYPES.PONG), 'missing PONG');

received.forEach((env) => {
  must(env.schemaVersion === SCHEMA, `${env.type}: schemaVersion=${env.schemaVersion} expected ${SCHEMA}`);
  must(typeof env.serverTimeMs === 'number', `${env.type}: missing/non-number serverTimeMs`);
  if (env.type === TYPES.ROOM_SNAPSHOT) {
    must(typeof env.data.currentPriceCents === 'string', 'ROOM_SNAPSHOT.currentPriceCents not string');
    must(typeof env.data.endAtMs === 'number', 'ROOM_SNAPSHOT.endAtMs not number');
    must(env.data.status === 'LIVE', `ROOM_SNAPSHOT.status=${env.data.status} expected LIVE`);
  }
  if (env.type === TYPES.BID_ACCEPTED) {
    must(typeof env.seq === 'number', 'BID_ACCEPTED.seq not number');
    must(typeof env.data.amountCents === 'string', 'BID_ACCEPTED.amountCents not string');
    must(typeof env.data.endAtMs === 'number', 'BID_ACCEPTED.endAtMs not number');
  }
  if (env.type === TYPES.BID_REJECTED) {
    must(env.data.code === 'ERR_TOO_LOW', `BID_REJECTED.code=${env.data.code} expected ERR_TOO_LOW`);
  }
});

if (ownAccepted) {
  must(ownAccepted.data.userId === userId, `own BID_ACCEPTED.userId=${ownAccepted.data.userId} expected ${userId}`);
  must(ownAccepted.data.status === 'LIVE', `own BID_ACCEPTED.status=${ownAccepted.data.status} expected LIVE`);
  must(ownAccepted.seq > snapshotSeq, `own BID_ACCEPTED.seq=${ownAccepted.seq} should be > snapshotSeq=${snapshotSeq}`);
}

console.log('\n=== results ===');
console.log('events received (' + received.length + '):', seenTypes.join(' -> '));
if (errors.length === 0) {
  console.log('ALL ASSERTIONS PASSED');
  process.exit(0);
} else {
  console.log(errors.length + ' FAILURES:');
  errors.forEach((e) => console.log('  - ' + e));
  process.exit(1);
}
