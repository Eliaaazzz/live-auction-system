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
  viewerCount: 0, // 参与人数 — real room occupancy from ROOM_SNAPSHOT

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
  leadersSeq:   0,          // state seq of the last REST /leaderboard applied (orders REST reconciles)
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
  // P0-3 (judges-stage review): one-shot anti-snipe flash. AUCTION_EXTENDED
  // sets { count, seq, addedSec } so the room can show "反狙击触发 · 延时
  // +30s · 第 N 次 · 序列 #seq" as an EVENT, not just a countdown that
  // quietly grew. Token-guarded clear (like rejects) so back-to-back
  // extends each restart the window instead of an old timer eating the
  // new banner.
  extendFlash:      null,
  extendFlashToken: 0,
  lastRejectCode:  null,
  lastRejectAt:    null,
  lastRejectSeq:   0,

  // T7-3: AI sidecar health for the offline badge + graceful degrade
  // contract (issue #70 §4.3). Default 'ok' optimistically — flips to
  // 'offline' on `api.draftFacts` ApiError (502 or network failure) +
  // flips back to 'ok' on any subsequent success. AIBubble + AdminConsole
  // + AdminVLMFacts read from this. Bid path is NEVER gated on this
  // value (per V9 P3: AI is non-authoritative).
  //
  // T7-2 cross-PR (#74 H2 per Elia review): the AI_COMMENTARY reducer
  // ALSO flips this to 'ok' since the event itself is proof the sidecar
  // is alive. Solves the "buyer view never sees AI health" stale-badge
  // case from #71 H1.
  aiSidecarHealth: 'ok',

  // T7-2: LLM auctioneer commentary from `AI_COMMENTARY` events
  // (proto/ai-events.md §POST /llm/auctioneer). Replace the hardcoded
  // "正在等待出价" placeholder in LiveRoomRoute. Resets on init() — each
  // room starts empty until backend's first trigger hook fires.
  //
  // V9 P3: AI_COMMENTARY is non-authoritative; the reducer does NOT
  // touch status/currentCents/seqguard from this event type.
  auctioneerText:     '',
  auctioneerTrigger:  null,        // 'open' | 'surge' | 'cold' | 'hammer' | null
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
  // MERGE-MAX into the live board, never wholesale-overwrite: a late/stale REST
  // response must not regress a row a ROOM_STATE_PATCH already advanced (跨端排名
  // 一致). snapSeq (from the backend response) gates the apply so an out-of-order
  // older REST response can't clobber a newer one; merge-max itself guarantees no
  // regression even without it. snapSeq omitted (older backend) => always merge.
  setLeaders: (leaders, snapSeq) => set((s) => {
    if (typeof snapSeq === 'number' && snapSeq < s.leadersSeq) return {}; // stale REST → ignore
    return {
      leaders: mergeLeadersMax(s.leaders, leaders, s.yourUserId),
      leadersSeq: typeof snapSeq === 'number' ? Math.max(s.leadersSeq, snapSeq) : s.leadersSeq,
    };
  }),

  // ── countdown tick (driven by RAF in LiveRoomRoute) ──────────
  tickRemaining: (ms) => set({ remainingMs: ms }),

  // ── reject reducer (from RoomClient.onReject) ────────────────
  applyReject: (env) => {
    const now = Date.now();
    return set((s) => {
      const rejectSeq = (s.lastRejectSeq ?? 0) + 1;
      scheduleRejectClear(rejectSeq);
      return {
        recentRejects: [
          { code: env.data?.code, ts: now, requestId: env.requestId },
          ...s.recentRejects,
        ].slice(0, 10),
        lastRejectCode: env.data?.code,
        lastRejectAt: now,
        lastRejectSeq: rejectSeq,
      };
    });
  },

  clearLastReject: () => set({ lastRejectCode: null, lastRejectAt: null, lastRejectSeq: 0 }),

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
    if (type !== EventType.ROOM_SNAPSHOT && type !== EventType.ROOM_STATE_PATCH) {
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
          if (data.viewerCount != null) next.viewerCount = data.viewerCount; // 参与人数

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
          next.totalBidsCount = Number.isFinite(data.bidCount)
            ? Math.max(s.totalBidsCount + 1, data.bidCount)
            : s.totalBidsCount + 1;
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
          next.lastRejectCode = null;
          next.lastRejectAt = null;
          next.lastRejectSeq = 0;
          break;
        }

        case EventType.ROOM_STATE_PATCH: {
          const prevWinnerId = s.winnerId;
          const wasSelf      = prevWinnerId != null && prevWinnerId === s.yourUserId;
          const patchSeq     = typeof seq === 'number' ? seq : (typeof data.seq === 'number' ? data.seq : null);
          const freshState   = patchSeq == null || patchSeq >= s.lastSeq;

          if (freshState) {
            next.status            = data.status ?? s.status;
            next.currentCents      = data.currentPriceCents ?? s.currentCents;
            next.endAtMs           = data.endAtMs ?? s.endAtMs;
            next.winnerId          = data.winnerId ?? s.winnerId;
            next.winnerDisplayName = data.winnerDisplayName ?? s.winnerDisplayName;
            if (data.extendCount != null) next.extendCount = data.extendCount;
          }

          if (Number.isFinite(data.bidCountTotal)) {
            next.totalBidsCount = Math.max(s.totalBidsCount, data.bidCountTotal);
          } else if (freshState) {
            const seqDelta = typeof seq === 'number' ? Math.max(0, seq - s.lastSeq) : 0;
            const bidDelta = Number.isFinite(data.bidCountDelta) ? Math.max(0, data.bidCountDelta) : seqDelta;
            next.totalBidsCount = s.totalBidsCount + Math.min(bidDelta, seqDelta || bidDelta);
          }
          if (freshState && data.winnerId) {
            next.leaders = mergeLeader(s.leaders, {
              userId:      data.winnerId,
              displayName: data.winnerDisplayName || data.winnerId,
              cents:       data.currentPriceCents ?? s.currentCents,
              isYou:       data.winnerId === s.yourUserId,
            });
          }
          if (freshState && s.yourUserId != null && data.winnerId === s.yourUserId) {
            next.yourCents = data.currentPriceCents ?? s.currentCents;
            if (prevWinnerId !== s.yourUserId) {
              next.leadingToast = true;
              scheduleClear('leadingToast', 1700);
            }
          }
          if (freshState && wasSelf && data.winnerId !== s.yourUserId) {
            next.overtakeBanner = true;
            scheduleClear('overtakeBanner', 5000);
          }
          next.lastRejectCode = null;
          next.lastRejectAt = null;
          next.lastRejectSeq = 0;
          break;
        }

        case EventType.AUCTION_EXTENDED: {
          next.endAtMs     = data.endAtMs;
          next.extendCount = data.extendCount ?? (s.extendCount + 1);
          // P0-3: surface the anti-snipe rule as a visible event. addedSec is
          // derived from the authoritative endAtMs delta (never invented);
          // when the previous endAtMs is unknown (catchup/replay) fall back
          // to the contract's 30s so the copy still reads correctly.
          const deltaMs = (typeof data.endAtMs === 'number' && typeof s.endAtMs === 'number')
            ? data.endAtMs - s.endAtMs
            : NaN;
          const token = s.extendFlashToken + 1;
          next.extendFlash = {
            count:    next.extendCount,
            seq:      seq ?? null,
            addedSec: Number.isFinite(deltaMs) && deltaMs > 0 ? Math.round(deltaMs / 1000) : 30,
          };
          next.extendFlashToken = token;
          scheduleExtendFlashClear(token);
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

        case EventType.AI_COMMENTARY: {
          // T7-2: observability-only. NEVER touch status / currentCents /
          // any state-machine field — V9 P3 says AI is non-authoritative.
          // seq is intentionally null on this event type (spec
          // proto/ai-events.md); the seqguard at the top of applyEvent
          // already exempts null-seq from dedup.
          if (typeof data?.commentary === 'string') next.auctioneerText = data.commentary;
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

// 2.6s: long enough to read "反狙击触发 · 延时 +30s · 第 N 次 · 序列 #x",
// short enough to be gone before the next endgame beat. Token compare keeps
// rapid consecutive extends from being clipped by an older timer.
function scheduleExtendFlashClear(token, ms = 2600) {
  setTimeout(() => {
    const current = useAuctionStore.getState();
    if (current.extendFlashToken === token) {
      useAuctionStore.setState({ extendFlash: null });
    }
  }, ms);
}

// 3s: the reject bar sits right above the bid chips now; 1.8s was gone
// before a mid-tap buyer even looked down (design review P0-1).
function scheduleRejectClear(seq, ms = 3000) {
  setTimeout(() => {
    const current = useAuctionStore.getState();
    if (current.lastRejectSeq === seq) {
      useAuctionStore.setState({ lastRejectCode: null, lastRejectAt: null, lastRejectSeq: 0 });
    }
  }, ms);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Insert/update one user in the leaderboard, keep top N by cents desc.
 * String-cents compare via BigInt — never parseFloat.
 */
// centsDesc orders leaderboard rows high→low by string-cents (BigInt, never
// parseFloat — money is exact decimal strings up to 2^53-1+).
function centsDesc(a, b) {
  try {
    const av = BigInt(a.cents), bv = BigInt(b.cents);
    return av < bv ? 1 : av > bv ? -1 : 0;
  } catch {
    return 0;
  }
}

// maxCents returns the larger of two string-cents (either may be undefined).
function maxCents(a, b) {
  if (a == null) return String(b ?? '0');
  if (b == null) return String(a);
  try {
    return BigInt(a) >= BigInt(b) ? String(a) : String(b);
  } catch {
    return String(b ?? a ?? '0');
  }
}

function mergeLeader(leaders, entry) {
  const cleaned = leaders.filter((l) => l.userId !== entry.userId);
  cleaned.push(entry);
  cleaned.sort(centsDesc);
  return cleaned.slice(0, LEADERBOARD_CAP);
}

// mergeLeadersMax reconciles a REST /leaderboard snapshot into the live board.
// CRITICAL (跨端排名一致): it MUST NOT wholesale-overwrite — a late/stale REST
// response must never regress a row the user watched climb via ROOM_STATE_PATCH.
// So it keeps max(existing.cents, rest.cents) per user, ADDS rows it hasn't seen,
// and never drops a live-only row. The auction ZSET is monotonic max-per-user, so
// merge-max is the correct reconciliation. Pure + hidden-tested.
export function mergeLeadersMax(existing, restRows, yourUserId) {
  const byId = new Map((existing || []).map((l) => [l.userId, l]));
  for (const l of restRows || []) {
    if (!l || l.userId == null) continue;
    const restCents = l.cents ?? l.amountCents ?? '0';
    const prev = byId.get(l.userId);
    byId.set(l.userId, {
      ...prev,
      ...l,
      userId: l.userId,
      displayName: l.displayName || prev?.displayName || l.userId,
      cents: maxCents(prev?.cents, restCents),
      isYou: l.userId === yourUserId,
    });
  }
  return [...byId.values()].sort(centsDesc).slice(0, LEADERBOARD_CAP);
}
