// src/lib/ws.js
//
// WebSocket client for the auction room. Pairs with the Lumen backend
// gateway (apps/lumen --mode=gateway). Authoritative protocol spec:
//   proto/ws-envelope.md  (envelope shape + every event type)
//   proto/error-codes.md  (BID_REJECTED `code` values)
//   project-blueprint.md  §4 (FE-side wire summary)
//                          §5 (life-of walkthroughs)
//
// HARD RULES (blueprint §4):
//   P1  money is string-cents — never parseFloat
//   P4  serverClockOffsetMs comes from every envelope's serverTimeMs,
//       not just heartbeat acks
//   P7  silent reconnect FORBIDDEN — every state change goes to onState
//   P8  message handler ≤5ms — dispatch to Zustand only, no React work here
//
// Envelope (both directions):
//   { schemaVersion, type, auctionId?, requestId?, seq?, serverTimeMs, data }
// `type` is SCREAMING_SNAKE — NEVER lowercase, NEVER `kind`.

import { CURRENT_SCHEMA_VERSION, ClientFrameType, EventType, ConnStatus } from './types.js';
import { setClockOffset } from './clock.js';
import { normalizeSyncStartSeq } from './connState.js';

const HEARTBEAT_MS  = 15_000;
const RECONNECT_MIN = 500;
const RECONNECT_MAX = 8_000;
const MAX_CLIENT_BID_ID_LEN = 128;
const MAX_AMOUNT_CENTS = 9_007_199_254_740_991n; // max safe + model boundary

/**
 * Build the backend WS URL from a base + auctionId + JWT.
 * Backend convention: ws(s)://<host>/ws?auction=<id>&token=<jwt>
 */
export function buildRoomUrl(wsBase, auctionId, token) {
  const base = (wsBase || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`)
    .replace(/^http/, 'ws')
    .replace(/\/+$/, '');
  const q = new URLSearchParams({ auction: auctionId, token: token ?? '' });
  return `${base}/ws?${q.toString()}`;
}

export class RoomClient {
  /**
   * @param {object} opts
   * @param {string} opts.url             full ws(s):// URL (see buildRoomUrl)
   * @param {string} opts.auctionId       room/auction id (sent inside ROOM_JOIN data)
   * @param {function} [opts.onState]     ({ status, ... }) — drives <ConnectionBar>
   * @param {function} [opts.onEvent]     (envelope)        — server→client business event
   * @param {function} [opts.onReject]    (envelope)        — BID_REJECTED specifically
   * @param {function} [opts.getLastSeq]  () => number      — for ROOM_JOIN(lastSeq) catchup
   */
  constructor({ url, auctionId, onState, onEvent, onReject, getLastSeq }) {
    this.url = url;
    this.auctionId = auctionId;
    this.onState   = onState   ?? (() => {});
    this.onEvent   = onEvent   ?? (() => {});
    this.onReject  = onReject  ?? (() => {});
    this.getLastSeq = getLastSeq ?? (() => 0);

    this.ws = null;
    this.heartbeatId = null;
    this.attempts = 0;
    this.dead = false;
  }

  connect() {
    if (this.dead) return;
    this.onState({ status: ConnStatus.CONNECTING, attempts: this.attempts });
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.unhandledTypes = new Set();

    ws.onopen = () => {
      this.attempts = 0;
      let lastSeq = 0;
      try {
        lastSeq = normalizeSyncStartSeq(this.getLastSeq());
      } catch {
        lastSeq = 0;
      }
      // Tell the gateway who we are + replay anything since lastSeq.
      this.#send(ClientFrameType.ROOM_JOIN, {
        auctionId: this.auctionId,
        ...(lastSeq > 0 ? { lastSeq } : {}),
      });
      this.onState({ status: ConnStatus.SYNCING, lastSeq });
      this.heartbeatId = setInterval(() => this.#send(ClientFrameType.PING, {}), HEARTBEAT_MS);
    };

    ws.onmessage = (msg) => {
      let env;
      try { env = JSON.parse(msg.data); } catch { return; }
      if (!env || typeof env !== 'object') return;
      if (this.dead) return;

      // Schema gate (blueprint §4 P7). A mismatch is terminal — the user
      // is on a stale build vs the server protocol; surface and stop.
      if (env.schemaVersion !== CURRENT_SCHEMA_VERSION) {
        this.dead = true;
        this.onState({
          status: ConnStatus.SCHEMA,
          server: env.schemaVersion,
          client: CURRENT_SCHEMA_VERSION,
        });
        clearInterval(this.heartbeatId);
        this.heartbeatId = null;
        ws.close(1000, 'schema mismatch');
        return;
      }
      if (typeof env.type !== 'string' || env.type.trim().length === 0) return;

      // P4: derive clock offset from EVERY envelope's serverTimeMs.
      if (typeof env.serverTimeMs === 'number') {
        setClockOffset(env.serverTimeMs, Date.now());
      }

      switch (env.type) {
        case EventType.PONG:
          // heartbeat ack; clock offset already applied above
          return;

        case EventType.BID_REJECTED:
          this.onReject(env);
          return;

        case EventType.ROOM_SNAPSHOT:
        case EventType.BID_ACCEPTED:
        case EventType.ROOM_STATE_PATCH:
        case EventType.AUCTION_EXTENDED:
        case EventType.AUCTION_SOLD:
        case EventType.AUCTION_NO_BID:
        case EventType.AUCTION_CANCELLED:
        case EventType.AI_COMMENTARY:
          this.onEvent(env);
          // First downstream business event after open == we're caught up.
          this.onState({ status: ConnStatus.OPEN });
          return;

        default:
          // Unknown type — log once, do nothing (forward-compat: a future
          // schemaVersion may add events the old client doesn't yet handle).
          if (!this.unhandledTypes.has(env.type) && typeof console !== 'undefined') {
            this.unhandledTypes.add(env.type);
            console.warn('[RoomClient] unhandled envelope.type =', env.type);
          }
      }
    };

    ws.onclose = () => {
      clearInterval(this.heartbeatId);
      this.heartbeatId = null;
      if (this.dead) return;
      this.attempts += 1;
      const delay = Math.min(RECONNECT_MAX, RECONNECT_MIN * 2 ** this.attempts);
      this.onState({
        status: ConnStatus.RECONNECTING,
        attempts: this.attempts,
        backoff: delay,
      });
      setTimeout(() => this.connect(), delay);
    };

    ws.onerror = () => {
      // 'close' fires next — keep state changes there.
    };
  }

  /**
   * Submit a bid. `clientBidId` is the idempotency key — a retry of the same
   * id replays the cached BID_ACCEPTED (see ws-envelope.md "DUPLICATE").
   */
  placeBid({ amountCents, clientBidId }) {
    if (this.dead) {
      this.onReject({
        type: EventType.BID_REJECTED,
        data: { code: 'ERR_INTERNAL' },
        requestId: clientBidId,
      });
      return;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.onReject({
        type: EventType.BID_REJECTED,
        data: { code: 'ERR_INTERNAL' },
        requestId: clientBidId,
      });
      return;
    }
    if (
      typeof clientBidId !== 'string' ||
      clientBidId.length === 0 ||
      clientBidId.length > MAX_CLIENT_BID_ID_LEN ||
      !/^\S+$/.test(clientBidId)
    ) {
      this.onReject({
        type: EventType.BID_REJECTED,
        data: { code: 'ERR_INTERNAL' },
        requestId: clientBidId,
      });
      return;
    }
    let normalizedAmountCents = amountCents;
    if (typeof amountCents === 'number') {
      if (!Number.isFinite(amountCents) ||
          !Number.isInteger(amountCents) ||
          !Number.isSafeInteger(amountCents) ||
          amountCents < 1) {
        this.onReject({
          type: EventType.BID_REJECTED,
          data: { code: 'ERR_INTERNAL' },
          requestId: clientBidId,
        });
        return;
      }
      normalizedAmountCents = String(amountCents);
    } else if (typeof amountCents === 'bigint') {
      if (amountCents < 1n || amountCents > MAX_AMOUNT_CENTS) {
        this.onReject({
          type: EventType.BID_REJECTED,
          data: { code: 'ERR_INTERNAL' },
          requestId: clientBidId,
        });
        return;
      }
      normalizedAmountCents = amountCents.toString();
    } else if (typeof amountCents !== 'string') {
      this.onReject({
        type: EventType.BID_REJECTED,
        data: { code: 'ERR_INTERNAL' },
        requestId: clientBidId,
      });
      return;
    } else {
      if (!/^\+?\d+$/.test(amountCents)) {
        this.onReject({
          type: EventType.BID_REJECTED,
          data: { code: 'ERR_INTERNAL' },
          requestId: clientBidId,
        });
        return;
      }

      try {
        const normalized = BigInt(amountCents);
        if (normalized < 1n || normalized > MAX_AMOUNT_CENTS) {
          this.onReject({
            type: EventType.BID_REJECTED,
            data: { code: 'ERR_INTERNAL' },
            requestId: clientBidId,
          });
          return;
        }
        normalizedAmountCents = normalized.toString();
      } catch {
        this.onReject({
          type: EventType.BID_REJECTED,
          data: { code: 'ERR_INTERNAL' },
          requestId: clientBidId,
        });
        return;
      }
    }

    this.#send(ClientFrameType.BID_PLACE, { amountCents: normalizedAmountCents, clientBidId });
  }

  /**
   * User-initiated resync (F26 pull-to-refresh). Close → reconnect →
   * ROOM_JOIN(lastSeq) replays the missed Stream delta.
   */
  resync() {
    if (this.dead) return;
    this.attempts = 0;
    this.ws?.close();
  }

  leave() {
    this.dead = true;
    clearInterval(this.heartbeatId);
    try { this.ws?.close(1000, 'leave'); } catch {}
  }

  // ── private ─────────────────────────────────────────────────────
  #send(type, data) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const env = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      type,
      auctionId: this.auctionId,
      serverTimeMs: Date.now(),  // client time on outbound; server overwrites
      data,
    };
    try { ws.send(JSON.stringify(env)); } catch {}
  }
}
