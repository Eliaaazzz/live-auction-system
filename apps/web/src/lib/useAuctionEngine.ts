// useAuctionEngine — REAL backend-connected auction engine.
//
// Drop-in replacement for the prototype's mock engine: SAME signature
// ({ state, nextMinBid, placeBid, setAutoBidMax, autoBidMax, restart }) and the
// SAME AuctionState shape the UI consumes, but driven by the production backend:
//   - ensureSession  → JWT (auth.js)
//   - api.getAuction → REST snapshot seeds the store
//   - api.getLeaderboard → top-N ranking
//   - RoomClient (WebSocket) → live events into the battle-tested zustand reducer
//   - placeBid → HTTP command lane (POST /api/auctions/{id}/bids) + WS fallback
//
// The backend speaks string-CENTS; the UI speaks YUAN numbers, so we ÷100 on the
// way out and ×100 on the way in. AI is never in the bid path (V9 P3): the server
// Lua adjudicates; a mis-bid is rejected, never double-charged.
//
// Reuses src/backend/{lib,store} (the original apps/web data layer, unchanged).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AuctionState, EngineEvent, Lot, RankRow, Bid, AuctionStatus } from './types';
import { avatar } from './assets';
import { useIdentity } from './identity';
import { useAuctionStore } from '../backend/store/auction.js';
import { RoomClient, buildRoomUrl } from '../backend/lib/ws.js';
import { api } from '../backend/lib/api.js';
import { ensureSession, currentToken } from '../backend/lib/auth.js';
import { msRemaining } from '../backend/lib/clock.js';
import { EventType, BidErrorCode } from '../backend/lib/types.js';

interface Opts {
  seedToPrice?: number;
  startDelaySec?: number;
  running?: boolean;
  onEvent?: (e: EngineEvent) => void;
  /** Backend identity. Buyers omit → per-device guest (deviceNickname); admin passes 'seller-demo' (owner). */
  nickname?: string;
}

const WS_BASE = (import.meta as any).env?.VITE_WS_BASE || undefined;
const BID_HTTP_TIMEOUT_MS = 1_200;
const ENDING_WINDOW_MS = 10_000;

// stable pseudo-avatar from a backend userId (the backend has no avatar field).
function hashNum(s: string): number {
  let h = 0;
  for (let i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 70 + 1;
}
const yuan = (cents: string | number | null | undefined): number => {
  if (cents == null) return 0;
  try { return Math.round(Number(BigInt(String(cents))) / 100); } catch { return Math.round(Number(cents) / 100) || 0; }
};

// backend status string → prototype AuctionStatus
function mapStatus(beStatus: string, remainingMs: number): AuctionStatus {
  switch (beStatus) {
    case 'LIVE':
      return remainingMs > 0 && remainingMs <= ENDING_WINDOW_MS ? 'ending' : 'live';
    case 'SOLD':
    case 'ORDER_CREATED':
      return 'sold';
    case 'NO_BID':
    case 'CANCELLED':
      return 'unsold';
    default:
      return 'upcoming'; // DRAFT / SCHEDULED
  }
}

function bidFromLeader(l: any, rank: number): Bid {
  const uid = l?.userId ?? `u${rank}`;
  return {
    id: `${uid}-${l?.cents ?? 0}`,
    userId: uid,
    userName: l?.displayName || l?.userId || '匿名买家',
    avatar: avatar(hashNum(uid)),
    amount: yuan(l?.cents),
    ts: Date.now(),
    self: !!l?.isYou,
  };
}

export function useAuctionEngine(lot: Lot, opts: Opts = {}) {
  const { running = true, onEvent, nickname } = opts;
  const auctionId = lot.id;
  const store = useAuctionStore();
  const clientRef = useRef<any>(null);
  const rafRef = useRef<number>(0);
  const onEventRef = useRef(onEvent);
  const lastEmitRef = useRef<string>('');
  const [autoBidMax, setAutoBidMaxState] = useState<number | null>(null);
  const [livePlayUrl, setLivePlayUrl] = useState<string>(''); // real HLS from REST snapshot (#121)
  // 我的统一头像：与 LiveRoom 的 gifts/comments 同源（identity store，登录所选优先）。
  // 用它覆盖所有「自己」行的头像，彻底消除「同一个我，出价/送礼头像不一样」(#3)。
  const selfAvatar = useIdentity((s) => s.avatar);
  const autoMaxRef = useRef<number | null>(null);
  useEffect(() => { onEventRef.current = onEvent; });

  // ── boot: session → snapshot → leaderboard → WS ──
  useEffect(() => {
    if (!running || !auctionId) return undefined;
    let alive = true;
    let client: any;
    const st = useAuctionStore.getState();

    (async () => {
      try {
        const session = await ensureSession(nickname);
        if (!alive) return;
        st.setSelfUserId(session.userId);
      } catch { /* room retries with its own session */ }

      try {
        const snap = await api.getAuction(auctionId);
        if (!alive) return;
        const rules = snap.rules ?? {};
        st.init({
          auctionId,
          status: snap.status,
          currentCents: snap.currentPriceCents ?? '0',
          startCents: snap.startCents ?? rules.reserveCents ?? '0',
          stepCents: rules.stepCents ?? snap.stepCents ?? String(lot.minIncrement * 100),
          capCents: rules.capCents ?? snap.capCents ?? (lot.capPrice ? String(lot.capPrice * 100) : null),
          endAtMs: snap.endAtMs ?? null,
          winnerId: snap.winnerId ?? null,
          yourUserId: useAuctionStore.getState().yourUserId,
        });
        if ((snap as any).livePlayUrl) setLivePlayUrl(String((snap as any).livePlayUrl));
      } catch { /* WS will rebuild from snapshot frame */ }

      try {
        const { leaderboard = [] } = await api.getLeaderboard(auctionId, 10);
        if (alive) useAuctionStore.getState().setLeaders(leaderboard);
      } catch { /* fills from BID_ACCEPTED */ }

      const url = buildRoomUrl(WS_BASE, auctionId, currentToken());
      client = new RoomClient({
        url,
        auctionId,
        getLastSeq: () => useAuctionStore.getState().lastSeq,
        onState: (s: any) => useAuctionStore.getState().setConn(s.status, s),
        onEvent: (env: any) => {
          useAuctionStore.getState().applyEvent(env);
          emitEngineEvent(env);
          maybeRefreshLeaders(env);
        },
        onReject: (env: any) => useAuctionStore.getState().applyReject(env),
      });
      clientRef.current = client;
      client.connect();
    })();

    return () => {
      alive = false;
      clientRef.current = null;
      try { client?.leave(); } catch { /* noop */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auctionId, running]);

  // ── countdown: drive store.remainingMs from the server clock ──
  useEffect(() => {
    const tick = () => {
      const endAtMs = useAuctionStore.getState().endAtMs;
      if (endAtMs) useAuctionStore.getState().tickRemaining(msRemaining(endAtMs));
      rafRef.current = window.requestAnimationFrame(tick);
    };
    rafRef.current = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafRef.current);
  }, []);

  function maybeRefreshLeaders(env: any) {
    if (env?.type === EventType.BID_ACCEPTED || env?.type === EventType.AUCTION_SOLD) {
      api.getLeaderboard(auctionId, 10)
        .then(({ leaderboard = [] }: any) => useAuctionStore.getState().setLeaders(leaderboard))
        .catch(() => {});
    }
  }

  // translate a backend envelope into the prototype's EngineEvent (overlays/撒花)
  function emitEngineEvent(env: any) {
    const cb = onEventRef.current;
    if (!cb) return;
    const key = `${env?.type}:${env?.seq ?? ''}`;
    if (key === lastEmitRef.current) return;
    lastEmitRef.current = key;
    const s = useAuctionStore.getState();
    switch (env?.type) {
      case EventType.BID_ACCEPTED: {
        const self = s.yourUserId && env.data?.userId === s.yourUserId;
        if (self) cb({ kind: 'leading', amount: yuan(env.data?.amountCents) });
        else cb({ kind: 'outbid', by: env.data?.displayName || '竞拍者', amount: yuan(env.data?.amountCents) });
        break;
      }
      case EventType.AUCTION_EXTENDED:
        cb({ kind: 'extend', addSec: 30 });
        break;
      case EventType.AUCTION_SOLD:
        cb({ kind: 'settle', won: !!(s.yourUserId && env.data?.winnerId === s.yourUserId), price: yuan(env.data?.amountCents ?? s.currentCents) });
        break;
      default:
        break;
    }
  }

  // ── map store state → prototype AuctionState ──
  const state: AuctionState = useMemo(() => {
    const remainingMs = store.remainingMs ?? 0;
    const status = mapStatus(store.status, remainingMs);
    const leaders = (store.leaders ?? []) as any[];
    const ranking: RankRow[] = leaders.map((l, i) => ({
      userId: l.userId,
      userName: l.displayName || l.userId || '匿名买家',
      avatar: (l.isYou && selfAvatar) ? selfAvatar : avatar(hashNum(l.userId ?? `u${i}`)),
      amount: yuan(l.cents),
      self: !!l.isYou,
    }));
    const leader = leaders.length ? bidFromLeader(leaders[0], 0) : null;
    if (leader && leader.self && selfAvatar) leader.avatar = selfAvatar;
    const bids: Bid[] = (store.recentEvents ?? [])
      .filter((e: any) => e.type === EventType.BID_ACCEPTED && e.data?.amountCents)
      .slice(0, 50)
      .map((e: any) => ({
        id: String(e.seq ?? e.ts ?? Math.random()),
        userId: e.data.userId,
        userName: e.data.displayName || e.data.userId || '匿名买家',
        avatar: (store.yourUserId && e.data.userId === store.yourUserId && selfAvatar) ? selfAvatar : avatar(hashNum(e.data.userId ?? '')),
        amount: yuan(e.data.amountCents),
        ts: e.ts ?? Date.now(),
        self: !!(store.yourUserId && e.data.userId === store.yourUserId),
      }));
    const myRankIdx = store.yourUserId ? leaders.findIndex((l) => l.userId === store.yourUserId) : -1;
    return {
      status,
      startsInMs: 0,
      remainingMs,
      totalMs: (lot.durationSec || 60) * 1000,
      currentPrice: yuan(store.currentCents),
      leader,
      bids,
      ranking,
      participants: store.viewerCount ?? 0,
      myMaxBid: store.yourCents ? yuan(store.yourCents) : null,
      myRank: myRankIdx >= 0 ? myRankIdx + 1 : null,
      extendedFlash: store.extendFlash ? (store.extendFlash.addedSec ?? 30) : 0,
      lastEvent: null,
      bidCount: store.totalBidsCount ?? 0,
    };
  }, [store, lot.durationSec, selfAvatar]);

  // True once THIS room's REST snapshot has initialised the (singleton) store —
  // i.e. real price/bids/status are present, not the previous room's leftovers.
  // LiveRoom uses it to drop the loading skeleton exactly when real data lands,
  // so a swipe reveals live chrome with no stale-price flash.
  const ready = store.auctionId === auctionId;

  const nextMinBid = useMemo(() => {
    const cur = yuan(store.currentCents);
    const step = yuan(store.stepCents) || lot.minIncrement || 1;
    if (!store.currentCents || store.currentCents === '0') return lot.startPrice > 0 ? lot.startPrice : step;
    return cur + step;
  }, [store.currentCents, store.stepCents, lot.minIncrement, lot.startPrice]);

  // ── placeBid: HTTP command lane + WS fallback (server adjudicates) ──
  const placeBid = useCallback((amount: number): { ok: boolean; reason?: string } => {
    const s = useAuctionStore.getState();
    if (s.status !== 'LIVE') return { ok: false, reason: '当前不可出价' };
    if (s.endAtMs && msRemaining(s.endAtMs) <= 0) return { ok: false, reason: '竞拍已结束' };
    const amountCents = String(Math.round(amount) * 100);
    const clientBidId = makeBidId();
    void submitBid(auctionId, { clientBidId, amountCents }, clientRef.current);
    return { ok: true };
  }, [auctionId]);

  const setAutoBidMax = useCallback((max: number | null) => {
    autoMaxRef.current = max;
    setAutoBidMaxState(max);
  }, []);

  const restart = useCallback(() => {
    try { clientRef.current?.resync?.(); } catch { /* noop */ }
  }, []);

  return { state, nextMinBid, placeBid, setAutoBidMax, autoBidMax, restart, livePlayUrl, ready, selfAvatar, auctioneerText: (store as any).auctioneerText || '' };
}

function makeBidId(): string {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `cbid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function submitBid(auctionId: string, payload: any, client: any) {
  try {
    const env = await placeBidHttp(auctionId, payload);
    if (env?.type === EventType.BID_REJECTED) useAuctionStore.getState().applyReject(env);
    else if (env?.type) useAuctionStore.getState().applyEvent(env);
    return;
  } catch (e: any) {
    const status = Number(e?.status);
    const fallback = e?.name === 'AbortError' || e?.name === 'TypeError' || status === 404 || status === 405 || status === 501;
    if (fallback && client) { client.placeBid(payload); return; }
    useAuctionStore.getState().applyReject({ type: EventType.BID_REJECTED, auctionId, requestId: payload.clientBidId, data: { code: BidErrorCode.ERR_INTERNAL } });
  }
}

async function placeBidHttp(auctionId: string, payload: any) {
  if (typeof AbortController === 'undefined') return api.placeBid(auctionId, payload);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), BID_HTTP_TIMEOUT_MS);
  try { return await api.placeBid(auctionId, payload, { signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}
