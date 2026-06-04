// src/routes/LiveRoomRoute.jsx
//
// Real backend-wired auction room.
//
// Boot order (project-blueprint.md §5.1 + §7):
//   1. ensureSession()      → JWT bearer cached locally
//   2. api.getAuction()     → REST snapshot fallback (pre-LIVE preview /
//                              gap-too-big rescue) so first paint isn't blank
//   3. api.getLeaderboard() → seed the leaderboard before WS opens
//   4. RoomClient.connect() → ROOM_JOIN(lastSeq) catchup → live events
//
// If VITE_USE_MOCK_DATA=true the same screen renders from inline demo data
// (useful when the backend isn't running). The component shape is the same.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { MobileRoom } from '../components/mobile.jsx';
import { PullToResync } from '../components/PullToResync.jsx';
import { RoomClient, buildRoomUrl } from '../lib/ws.js';
import { useAuctionStore } from '../store/auction.js';
import { msRemaining, serverNow, getDriftMs } from '../lib/clock.js';
import { api } from '../lib/api.js';
import { ensureSession, currentToken } from '../lib/auth.js';

// Default OFF: real backend unless a dev explicitly opts into demo data with
// VITE_USE_MOCK_DATA=true. The old 'true' default shipped the production build
// in mock mode (frozen room). #106.
const USE_MOCK = String(import.meta.env.VITE_USE_MOCK_DATA ?? 'false') === 'true';
const WS_BASE  = import.meta.env.VITE_WS_BASE || undefined;

export function LiveRoomRoute() {
  const { auctionId } = useParams();
  const navigate = useNavigate();
  const store  = useAuctionStore();
  const rafRef = useRef(null);
  const clientRef = useRef(null);
  const leaderboardAtMsRef = useRef(0);
  const pendingLeaderBumpRef = useRef(0);
  const leaderboardFlightRef = useRef(false);
  // Item 3: the real product image, rendered as the "live" feed in the room
  // (V9: video is non-authoritative — purely the ambiance; never gates bids).
  const [productImage, setProductImage] = useState(null);
  // #121: optional live-stream play URL (火山直播 HLS .m3u8) for the 直播画面.
  // Non-authoritative — null → the room simulates the feed (CSS sheen).
  const [livePlayUrl, setLivePlayUrl] = useState(null);

  // F26: stable callback for PullToResync — closes WS, exp-backoff reconnect
  // resets to 0, ROOM_JOIN(lastSeq) replays missed events from the Stream.
  const handleResync = useCallback(() => {
    clientRef.current?.resync();
  }, []);

  // QuickBidChips emits absolute cents strings. We wrap placeBid with a
  // freshly minted clientBidId so the backend's dedupe cache (Hash) keyed
  // by (auctionId, userId, clientBidId) doesn't collapse two legit
  // sequential bids. Generated client-side; opaque to the server.
  const handleBid = useCallback((amountCents) => {
    const s = useAuctionStore.getState();
    if (s.status !== 'LIVE') return;
    if (s.endAtMs && msRemaining(s.endAtMs) <= 0) return;

    const client = clientRef.current;
    if (!client) return;
    const clientBidId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `cbid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    client.placeBid({ clientBidId, amountCents });
  }, []);

  const maybeRefreshLeaders = useCallback(async (opts) => {
    if (!auctionId) return;
    const now = Date.now();
    const force = opts?.force === true;
    if (leaderboardFlightRef.current) return;

    const shouldThrottle = now - leaderboardAtMsRef.current < 2_500;
    const shouldRefresh = force || (!shouldThrottle);
    if (!shouldRefresh) return;

    leaderboardFlightRef.current = true;
    try {
      const { leaderboard = [] } = await api.getLeaderboard(auctionId, 10);
      useAuctionStore.getState().setLeaders(leaderboard);
      leaderboardAtMsRef.current = now;
    } catch (e) {
      // Non-fatal: local mergeLeader already keeps the UI responsive.
      console.warn('[LiveRoom] leaderboard reconcile failed', e);
    } finally {
      leaderboardFlightRef.current = false;
    }
  }, [auctionId]);

  const handleEvent = useCallback((env) => {
    const s = useAuctionStore.getState();
    if (!s) return;
    s.applyEvent(env);

    const bump = nextLeaderRefreshBump(pendingLeaderBumpRef.current, env);
    if (bump.hadBidActivity) {
      pendingLeaderBumpRef.current = bump.pending;
      if (bump.shouldRefresh) {
        void maybeRefreshLeaders({ force: false });
      }
      return;
    }

    if (
      env?.type === 'AUCTION_SOLD' ||
      env?.type === 'AUCTION_NO_BID' ||
      env?.type === 'AUCTION_CANCELLED' ||
      env?.type === 'ROOM_SNAPSHOT'
    ) {
      pendingLeaderBumpRef.current = 0;
      void maybeRefreshLeaders({ force: true });
    }
  }, [maybeRefreshLeaders]);

  // ── Bootstrap: session → snapshot → leaderboard → WS ──
  useEffect(() => {
    let alive = true;
    let client;

    (async () => {
      if (USE_MOCK) {
        store.init({
          auctionId,
          status: 'LIVE',
          currentCents: '12880000',
          stepCents:    '500000',
          endAtMs:      Date.now() + 28400,
          extendCount:  2,
          yourUserId:   'u3',
          yourCents:    '12500000',
          leaders:      DEMO_LEADERS,
        });
        return;
      }

      try {
        // 1. Session
        const session = await ensureSession('demo');
        if (!alive) return;
        useAuctionStore.getState().setSelfUserId(session.userId);
      } catch (e) {
        console.error('[LiveRoom] dev-login failed', e);
        useAuctionStore.getState().setConn('reconnecting', { reason: 'login-failed' });
        return;
      }

      try {
        // 2. Snapshot — gives us status/price/endAtMs before WS opens.
        const snap = await api.getAuction(auctionId);
        if (!alive) return;
        const rules = snap.rules ?? {};
        store.init({
          auctionId,
          status:       snap.status,
          currentCents: snap.currentPriceCents ?? '0',
          startCents:   snap.startCents ?? rules.reserveCents ?? '0',
          stepCents:    rules.stepCents ?? snap.stepCents ?? '500000',
          capCents:     hasOwn(rules, 'capCents') ? rules.capCents : (snap.capCents ?? null),
          reserveCents: rules.reserveCents ?? snap.reserveCents ?? '0',
          endAtMs:      snap.endAtMs ?? null,
          winnerId:     snap.winnerId ?? null,
          yourUserId:   useAuctionStore.getState().yourUserId,
        });
        if (snap.imageUrl) setProductImage(snap.imageUrl);
        if (snap.livePlayUrl) setLivePlayUrl(snap.livePlayUrl);
      } catch (e) {
        console.warn('[LiveRoom] snapshot failed (continuing — WS will rebuild)', e);
      }

      try {
        // 3. Leaderboard seed
        const { leaderboard = [] } = await api.getLeaderboard(auctionId, 10);
        if (alive) useAuctionStore.getState().setLeaders(leaderboard);
      } catch (e) {
        // Non-fatal — leaderboard will fill from BID_ACCEPTED events.
        console.warn('[LiveRoom] leaderboard seed failed', e);
      }

      // 4. Open WS
      const url = buildRoomUrl(WS_BASE, auctionId, currentToken());
      client = new RoomClient({
        url,
        auctionId,
        getLastSeq: () => useAuctionStore.getState().lastSeq,
        onState:    (s) => useAuctionStore.getState().setConn(s.status, s),
        onEvent:    handleEvent,
        onReject:   (env) => useAuctionStore.getState().applyReject(env),
      });
      clientRef.current = client;
      client.connect();
    })();

    return () => {
      alive = false;
      clientRef.current = null;
      client?.leave();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auctionId]);

  // ── Countdown — tick remainingMs every frame from server clock ──
  useEffect(() => {
    const tick = () => {
      const endAtMs = useAuctionStore.getState().endAtMs;
      if (endAtMs) useAuctionStore.getState().tickRemaining(msRemaining(endAtMs));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // ── Map store → MobileRoom props (component contract preserved) ──
  const top = store.leaders[0];
  const youGap = top && store.yourCents
    ? safeSubBigInt(top.cents, store.yourCents)
    : '0';

  const inFinal10 = store.remainingMs > 0 && store.remainingMs <= 10_000;

  // Bids/sec over the last 5s window. recentEvents is bounded to 50 by the
  // store reducer; that's safely > 5s of typical bid traffic.
  const nowMs = serverNow();
  const bidsLast5s = store.recentEvents.reduce((sum, e) => {
    if (!e.ts || nowMs - e.ts >= 5000) return sum;
    return sum + bidActivityDeltaFromEvent(e);
  }, 0);
  const bidsPerSec = bidsLast5s / 5;

  // #54-M1: bidsPerSecPeak was hardcoded to 6 which is right for a calm
  // demo but causes the heat meter to clip to 100% during a real bidding
  // storm. Adaptive cap = max(6, observed peak this session). Stored in a
  // ref so it persists across renders and only ratchets UP, never down.
  const observedPeakRef = useRef(6);
  if (bidsPerSec > observedPeakRef.current) {
    observedPeakRef.current = bidsPerSec;
  }
  const bidsPerSecPeak = observedPeakRef.current;

  return (
    <PullToResync onResync={handleResync}>
    <MobileRoom
      productImage={productImage}
      videoUrl={livePlayUrl}
      viewerCount={store.viewerCount}
      remainingMs={store.remainingMs}
      currentCents={store.currentCents}
      stepCents={store.stepCents}
      capCents={store.capCents}
      status={store.status}
      extendCount={store.extendCount}
      connStatus={store.connStatus}
      yourRank={rankOfYou(store.leaders, store.yourUserId)}
      yourGapCents={youGap}
      leaders={store.leaders}
      onBid={handleBid}
      bidsPerSec={bidsPerSec}
      bidsPerSecPeak={bidsPerSecPeak}
      serverClockOffsetMs={getDriftMs()}
      lastSeq={store.lastSeq}
      winnerName={store.winnerDisplayName || store.winnerId || '匿名买家'}
      onViewEvidence={() => navigate(`/evidence/${auctionId}`)}
      ticker={store.recentEvents
        .map(tickerItemFromEvent)
        .filter(Boolean)
        .slice(0, 6)}
      isYouLeading={top?.isYou ?? false}
      showLeadingToast={store.leadingToast}
      overtakeBanner={store.overtakeBanner}
      showBlackHorse={store.blackHorse}
      showHammerTransition={store.hammerTrans}
      rejectCode={store.lastRejectCode}
      rejectShake={!!store.lastRejectCode}
      showColorRamp={inFinal10}
      showHourglass={inFinal10}
      showPulseWaves={inFinal10}
      // T7-2: aiTrigger / aiText prefer the AI_COMMENTARY broadcast
      // (store.auctioneerTrigger / store.auctioneerText) when available;
      // fall back to the heuristic derived from status / blackHorse /
      // inFinal10 when the backend hasn't fired a trigger yet. The
      // hardcoded placeholder remains as the ultimate fallback so the
      // bubble is never empty.
      aiTrigger={
        store.auctioneerTrigger
        ?? (store.status === 'SOLD' ? 'hammer'
            : store.blackHorse      ? 'surge'
            : inFinal10             ? 'cold'
            : 'open')
      }
      // T7-3 §4.3 + T7-2 §4.2 composition (resolved at rebase):
      // - aiStatus reflects sidecar health (#71): offline → AIBubble
      //   renders its offline variant which hardcodes the "拍卖师暂离" copy
      // - aiText resolves only when sidecar is live: prefer the broadcast
      //   AI_COMMENTARY commentary (#74), fall back to the placeholder
      //   so the bubble is never empty. AIBubble ignores aiText when
      //   status='offline' so the offline copy wins automatically.
      aiStatus={store.aiSidecarHealth === 'offline' ? 'offline' : 'live'}
      aiText={
        store.auctioneerText
        || '正在等待出价 · AI 文本由 sidecar 流式生成'
      }
      expressive
    />
    </PullToResync>
  );
}

// ─── helpers ────────────────────────────────────────────────────
function rankOfYou(leaders, userId) {
  if (!userId) return null;
  const idx = leaders.findIndex((l) => l.userId === userId);
  return idx >= 0 ? idx + 1 : null;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function safeSubBigInt(a, b) {
  try { return (BigInt(a) - BigInt(b)).toString(); } catch { return '0'; }
}

export function bidActivityDeltaFromEvent(env) {
  if (env?.type === 'BID_ACCEPTED') return 1;
  if (env?.type !== 'ROOM_STATE_PATCH') return 0;
  const delta = Number(env.data?.bidCountDelta);
  if (!Number.isFinite(delta)) return 1;
  return Math.max(0, delta);
}

export function nextLeaderRefreshBump(current, env) {
  const delta = bidActivityDeltaFromEvent(env);
  if (delta <= 0) {
    return { hadBidActivity: false, shouldRefresh: false, pending: current };
  }
  const pending = current + delta;
  if (pending >= 3) {
    return { hadBidActivity: true, shouldRefresh: true, pending: 0 };
  }
  return { hadBidActivity: true, shouldRefresh: false, pending };
}

export function tickerItemFromEvent(e) {
  if (e?.type === 'BID_ACCEPTED') {
    return { id: e.seq, name: e.data?.displayName, cents: e.data?.amountCents };
  }
  if (e?.type === 'ROOM_STATE_PATCH') {
    return {
      id: e.seq,
      name: e.data?.winnerDisplayName || e.data?.winnerId,
      cents: e.data?.currentPriceCents,
    };
  }
  return null;
}

const DEMO_LEADERS = [
  { userId: 'u1', displayName: '海风_2024', cents: '12880000', avatarBg: 'linear-gradient(135deg,#FE2C55,#cb203f)' },
  { userId: 'u2', displayName: '听雨人',    cents: '12750000', avatarBg: 'linear-gradient(135deg,#25F4EE,#0ea5e9)' },
  { userId: 'u3', displayName: '陆_LU',     cents: '12500000', avatarBg: 'linear-gradient(135deg,#a855f7,#7c3aed)', isYou: true },
  { userId: 'u4', displayName: '盐渍生活',  cents: '12380000', avatarBg: 'linear-gradient(135deg,#f59e0b,#d97706)' },
];

export default LiveRoomRoute;
