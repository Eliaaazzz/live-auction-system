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

import React, { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { MobileRoom } from '../components/mobile.jsx';
import { RoomClient, buildRoomUrl } from '../lib/ws.js';
import { useAuctionStore } from '../store/auction.js';
import { msRemaining } from '../lib/clock.js';
import { api } from '../lib/api.js';
import { ensureSession, currentToken } from '../lib/auth.js';

const USE_MOCK = String(import.meta.env.VITE_USE_MOCK_DATA ?? 'true') === 'true';
const WS_BASE  = import.meta.env.VITE_WS_BASE || undefined;

export function LiveRoomRoute() {
  const { auctionId } = useParams();
  const store  = useAuctionStore();
  const rafRef = useRef(null);

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
        store.init({
          auctionId,
          status:       snap.status,
          currentCents: snap.currentPriceCents ?? '0',
          startCents:   snap.startCents   ?? '0',
          stepCents:    snap.stepCents    ?? '0',
          capCents:     snap.capCents     ?? null,
          reserveCents: snap.reserveCents ?? '0',
          endAtMs:      snap.endAtMs ?? null,
          winnerId:     snap.winnerId ?? null,
          yourUserId:   useAuctionStore.getState().yourUserId,
        });
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
        onEvent:    (env) => useAuctionStore.getState().applyEvent(env),
        onReject:   (env) => useAuctionStore.getState().applyReject(env),
      });
      client.connect();
    })();

    return () => {
      alive = false;
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

  return (
    <MobileRoom
      remainingMs={store.remainingMs}
      currentCents={store.currentCents}
      status={store.status}
      extendCount={store.extendCount}
      connStatus={store.connStatus}
      yourRank={rankOfYou(store.leaders, store.yourUserId)}
      yourGapCents={youGap}
      ticker={store.recentEvents
        .filter((e) => e.type === 'BID_ACCEPTED')
        .slice(0, 6)
        .map((e) => ({ id: e.seq, name: e.data?.displayName, cents: e.data?.amountCents }))}
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
      aiTrigger={
        store.status === 'SOLD' ? 'hammer'
          : store.blackHorse    ? 'jump'
          : inFinal10           ? 'cold'
          : 'open'
      }
      aiText="正在等待出价 · AI 文本由 sidecar 流式生成"
      expressive
    />
  );
}

// ─── helpers ────────────────────────────────────────────────────
function rankOfYou(leaders, userId) {
  if (!userId) return null;
  const idx = leaders.findIndex((l) => l.userId === userId);
  return idx >= 0 ? idx + 1 : null;
}

function safeSubBigInt(a, b) {
  try { return (BigInt(a) - BigInt(b)).toString(); } catch { return '0'; }
}

const DEMO_LEADERS = [
  { userId: 'u1', displayName: '海风_2024', cents: '12880000', avatarBg: 'linear-gradient(135deg,#FE2C55,#cb203f)' },
  { userId: 'u2', displayName: '听雨人',    cents: '12750000', avatarBg: 'linear-gradient(135deg,#25F4EE,#0ea5e9)' },
  { userId: 'u3', displayName: '陆_LU',     cents: '12500000', avatarBg: 'linear-gradient(135deg,#a855f7,#7c3aed)', isYou: true },
  { userId: 'u4', displayName: '盐渍生活',  cents: '12380000', avatarBg: 'linear-gradient(135deg,#f59e0b,#d97706)' },
];

export default LiveRoomRoute;
