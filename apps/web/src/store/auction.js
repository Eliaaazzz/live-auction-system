// src/store/auction.js
//
// Zustand store — single source of room state for the LIVE buyer screen
// AND the admin live console (both render off the same store fed by the
// same RoomClient). Reducer-style: every WS envelope becomes one
// applyEvent() call; no React work happens here (blueprint §4 P8).
//
// Field names below mirror the backend envelopes verbatim — see
// proto/ws-envelope.md and project-blueprint.md §4.

import { create } from 'zustand';
import { setClockOffset } from '../lib/clock.js';
import { AuctionStatus, EventType, ConnStatus } from '../lib/types.js';

const LEADERBOARD_CAP = 10;

const DEFAULT_STATE = {
  // identity
  auctionId: null,

  // status (canonical 7 per blueprint §3.1)
  status: AuctionStatus.DRAFT,
  connStatus: ConnStatus.IDLE,
  connDetail: null,

  // pricing — ALL string-cents (blueprint P1).
  //
  // Backend ROOM_SNAPSHOT ships real rules in data.rules. The non-zero
  // default remains a defensive fallback for mock/back-compat payloads so
  // QuickBidChips never divides by a zero step.
  //
  // capCents=null is a valid "no buy-now ceiling" per ws-envelope.md;
  // QuickBidChips.maxBid() falls back to +10% in that case.
  currentCents: '0',
  startCents:   '0',
  stepCents:    '500000',
  capCents:     null,
  reserveCents: '0',

  // timing — backend canonical field is endAtMs (ws-envelope.md §3.5)
  endAtMs:      null,
  remainingMs:  0,
  extendCount:  0,

  // identity bits derived from BID_ACCEPTED envelopes
  winnerId:           null,
  winnerDisplayName:  null,

  // leaderboard — backend does NOT ship a leaders array on BID_ACCEPTED.
  // We maintain max-per-user from the BID_ACCEPTED stream + reconcile
  // against GET /leaderboard?n=10 at strategic moments (room open + every
  // SOLD/CANCELLED). See applyEvent + setLeaders below.
  leaders:      [],         // [{ userId, displayName, cents, avatarBg?, isYou? }]
  yourUserId:   null,
  yourCents:    null,

  // event stream (last N — used by ticker + audit panel)
  recentEvents:  [],
  recentRejects: [],
  lastSeq:       0,

  // #53-M1 / #53-M2: cumulative counters maintained alongside recentEvents.
  // recentEvents is capped at 50, so deriving "total bids" or "unique
  // bidders" by filtering it silently clips for any auction past 50 bids.
  // These two fields are reducer-maintained and reset on init().
  totalBidsCount:  0,
  bidderIds:       [],  // array of unique userIds (dedup via .includes — O(n) but n is small)

  // ephemeral feedback flags — Room components animate then clear
  leadingToast:    false,
  overtakeBanner:  false,
  blackHorse:      false,
  hammerTrans:     false,
  hammerAt:        null,
  lastRejectCode:  null,
  lastRejectAt:    null,

  // T7-3: AI sidecar health for the offline badge + graceful degrade
  // contract (issue #70 §4.3). Default 'ok' optimistically — flips to
  // 'offline' on `api.draftFacts` ApiError (502 or network failure) +
  // flips back to 'ok' on any subsequent success. AIBubble + AdminConsole
  // + AdminVLMFacts read from this. Bid path is NEVER gated on this
  // value (per V9 P3: AI is non-authoritative).
  //
  // T7-2 cross-PR (#74 H2 per Elia review): the AUCTIONEER_TEXT reducer
  // ALSO flips this to 'ok' since the event itself is proof the sidecar
  // is alive. Solves the "buyer view never sees AI health" stale-badge
  // case from #71 H1.
  aiSidecarHealth: 'ok',

  // T7-2: LLM auctioneer commentary from `AUCTIONEER_TEXT` events
  // (proto/ai-events.md §POST /auctioneer). Replace the hardcoded
  // "正在等待出价" placeholder in LiveRoomRoute. Resets on init() — each
  // room starts empty until backend's first trigger hook fires.
  //
  // V9 P3: AUCTIONEER_TEXT is non-authoritative; the reducer does NOT
  // touch status/currentCents/seqguard from this event type.
  auctioneerText:     '',
  auctioneerTrigger:  null,        // 'open' | 'jump' | 'cold' | 'hammer' | null
  auctioneerFallback: false,       // true when backend swapped in canned text
};

export const useAuctionStore = create((set, get) => ({
  ...DEFAULT_STATE,

  // ── lifecycle ────────────────────────────────────────────────
  init: (snapshot) => set({ ...DEFAULT_STATE, ...snapshot }),

  /** Set after dev-login so BID_ACCEPTED can decide self-vs-other. */
  setSelfUserId: (userId) => set({ yourUserId: userId }),

  // ── connection state (from RoomClient.onState) ───────────────
  setConn: (status, detail) => set({ connStatus: status, connDetail: detail ?? null }),

  // ── leaderboard reconcile (after REST GET /leaderboard) ──────
  setLeaders: (leaders) => set((s) => ({
    leaders: leaders.map((l) => ({
      ...l,
      isYou: l.userId === s.yourUserId,
    })),
  })),

  // ── countdown tick (driven by RAF in LiveRoomRoute) ──────────
  tickRemaining: (ms) => set({ remainingMs: ms }),

  // ── reject reducer (from RoomClient.onReject) ────────────────
  applyReject: (env) => set((s) => ({
    recentRejects: [
      { code: env.data?.code, ts: Date.now(), requestId: env.requestId },
      ...s.recentRejects,
    ].slice(0, 10),
    lastRejectCode: env.data?.code,
    lastRejectAt:   Date.now(),
  })),

  clearLastReject: () => set({ lastRejectCode: null }),

  // ── AI sidecar health (T7-3 / issue #70 §4.3) ────────────────
  // Called by lib/api.js when draftFacts() throws a 502 ApiError or
  // network error, and on the next success. Bid path never reads from
  // this — V9 P3 says AI is non-authoritative; the store keeps this as
  // pure observability state for the offline badge + AdminConsole chip.
  setAiOk:      () => set({ aiSidecarHealth: 'ok' }),
  setAiOffline: () => set({ aiSidecarHealth: 'offline' }),

  // ── event reducer (from RoomClient.onEvent) ──────────────────
  applyEvent: (env) => {
    const { type, seq, serverTimeMs, data } = env;

    // P4: every envelope updates clock offset (the WS hook also does this,
    // but applying here keeps the store reducer self-contained too).
    if (typeof serverTimeMs === 'number') setClockOffset(serverTimeMs, Date.now());

    // ROOM_SNAPSHOT resets the seq watermark (it's the new ground truth).
    // All other events dedupe against lastSeq.
    if (type !== EventType.ROOM_SNAPSHOT) {
      if (seq != null && seq <= get().lastSeq) return;
    }

    set((s) => {
      const next = { ...s };
      next.recentEvents = [{ seq, ts: serverTimeMs, type, data }, ...s.recentEvents].slice(0, 50);
      if (seq != null) next.lastSeq = Math.max(s.lastSeq, seq);

      switch (type) {
        case EventType.ROOM_SNAPSHOT: {
          // Authoritative reset (ws-envelope.md §3.2 + project-blueprint §5.5).
          // Note: ROOM_SNAPSHOT does NOT carry extendCount; we preserve the
          // current value so a reconnect-with-catchup keeps the running
          // anti-snipe count (catchup AUCTION_EXTENDED frames arrive BEFORE
          // the snapshot per backend dispatchWS:367). init() clears it on a
          // fresh room. Gap > 200 → snapshot-only fallback loses count
          // history; accepted until backend adds extendCount.
          next.status         = data.status;
          next.currentCents   = data.currentPriceCents ?? '0';
          next.winnerId       = data.winnerId ?? null;
          next.endAtMs        = data.endAtMs ?? null;
          next.lastSeq        = data.seq ?? 0;
          if (data.rules) {
            if (data.rules.stepCents != null) next.stepCents = data.rules.stepCents;
            if (hasOwn(data.rules, 'capCents')) next.capCents = data.rules.capCents;
            if (data.rules.reserveCents != null) {
              next.reserveCents = data.rules.reserveCents;
              next.startCents = data.rules.reserveCents;
            }
          }
          break;
        }

        case EventType.BID_ACCEPTED: {
          const prevWinnerId = s.winnerId;
          const isSelf       = s.yourUserId != null && data.userId === s.yourUserId;
          const wasSelf      = prevWinnerId != null && prevWinnerId === s.yourUserId;

          next.status            = data.status;            // 'LIVE' usually; 'SOLD' if cap-hit
          next.currentCents      = data.amountCents;
          next.endAtMs           = data.endAtMs;           // post-extension if any
          next.winnerId          = data.userId;
          next.winnerDisplayName = data.displayName;
          if (isSelf) next.yourCents = data.amountCents;

          // #53-M1 / #53-M2: cumulative counters. totalBidsCount climbs
          // monotonically. bidderIds appends only if the userId is new
          // AND non-null — defensive .filter(Boolean) equivalent inline.
          next.totalBidsCount = s.totalBidsCount + 1;
          if (data.userId && !s.bidderIds.includes(data.userId)) {
            next.bidderIds = [...s.bidderIds, data.userId];
          }

          // Client-side leaderboard maintenance — keep max-per-user.
          // Reconcile against GET /leaderboard at strategic points.
          next.leaders = mergeLeader(s.leaders, {
            userId:      data.userId,
            displayName: data.displayName,
            cents:       data.amountCents,
            isYou:       isSelf,
          });

          // Hero-moment flags (auto-clear)
          if (isSelf) {
            next.leadingToast = true;
            scheduleClear('leadingToast', 1700);
          } else if (wasSelf) {
            next.overtakeBanner = true;
            scheduleClear('overtakeBanner', 5000);
          }
          // F13 黑马 — jump of ≥ 5 × step
          if (s.stepCents && s.stepCents !== '0') {
            try {
              const jump = BigInt(data.amountCents) - BigInt(s.currentCents);
              if (jump >= BigInt(s.stepCents) * 5n) {
                next.blackHorse = true;
                scheduleClear('blackHorse', 5500);
              }
            } catch {/* ignore */}
          }
          break;
        }

        case EventType.AUCTION_EXTENDED: {
          next.endAtMs     = data.endAtMs;
          next.extendCount = data.extendCount ?? (s.extendCount + 1);
          break;
        }

        case EventType.AUCTION_SOLD: {
          next.status            = AuctionStatus.SOLD;
          next.currentCents      = data.amountCents ?? s.currentCents;
          next.winnerId          = data.winnerId ?? s.winnerId;
          next.hammerTrans       = true;
          next.hammerAt          = serverTimeMs;
          scheduleClear('hammerTrans', 2200);
          break;
        }

        case EventType.AUCTION_NO_BID:    next.status = AuctionStatus.NO_BID;    break;
        case EventType.AUCTION_CANCELLED: next.status = AuctionStatus.CANCELLED; break;

        case EventType.AUCTIONEER_TEXT: {
          // T7-2: observability-only. NEVER touch status / currentCents /
          // any state-machine field — V9 P3 says AI is non-authoritative.
          // seq is intentionally null on this event type (spec
          // proto/ai-events.md); the seqguard at the top of applyEvent
          // already exempts null-seq from dedup.
          if (typeof data?.text === 'string') next.auctioneerText = data.text;
          if (typeof data?.trigger === 'string') next.auctioneerTrigger = data.trigger;
          next.auctioneerFallback = data?.fallback === true;
          // Cross-PR #71↔#74 (Elia review on both): the event itself is
          // proof the sidecar is alive. Flip aiSidecarHealth back to 'ok'
          // so the buyer view (which never calls draftFacts) doesn't get
          // stuck at a stale 'offline' badge. The flag only flips offline
          // when api.js dispatches lumen:ai-sidecar-offline, so the
          // signal direction is preserved.
          next.aiSidecarHealth = 'ok';
          break;
        }

        default: /* PONG etc. — handled in WS layer */
      }
      return next;
    });
  },
}));

// ─── helpers ────────────────────────────────────────────────────

function scheduleClear(key, ms) {
  setTimeout(() => useAuctionStore.setState({ [key]: false }), ms);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Insert/update one user in the leaderboard, keep top N by cents desc.
 * String-cents compare via BigInt — never parseFloat.
 */
function mergeLeader(leaders, entry) {
  const cleaned = leaders.filter((l) => l.userId !== entry.userId);
  cleaned.push(entry);
  cleaned.sort((a, b) => {
    try {
      const av = BigInt(a.cents), bv = BigInt(b.cents);
      return av < bv ? 1 : av > bv ? -1 : 0;
    } catch { return 0; }
  });
  return cleaned.slice(0, LEADERBOARD_CAP);
}
