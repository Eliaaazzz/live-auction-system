import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuctionState, Bid, EngineEvent, Lot, RankRow, AuctionStatus } from './types';
import { BOT_USERS, ME, pick } from './mockData';

interface Opts {
  seedToPrice?: number;
  startDelaySec?: number;
  running?: boolean;
  onEvent?: (e: EngineEvent) => void;
}

const ENDING_WINDOW_MS = 10_000;
let seq = 0;
const bid = (): string => `b${(seq++).toString(36)}${Date.now().toString(36).slice(-4)}`;

interface Model {
  status: AuctionStatus;
  startsAt: number;
  endsAt: number;
  totalMs: number;
  currentPrice: number;
  leaderId: string | null;
  bids: Bid[];
  maxByUser: Map<string, Bid>;
  myMax: number | null;
  autoBidMax: number | null;
  nextBotAt: number;
  lastEvent: EngineEvent | null;
  extendedFlash: number;
  settledWon: boolean | null;
}

function computeNextMin(m: Model, lot: Lot): number {
  if (m.bids.length === 0) return lot.startPrice > 0 ? lot.startPrice : lot.minIncrement;
  return m.currentPrice + lot.minIncrement;
}

function ranking(m: Model): RankRow[] {
  return Array.from(m.maxByUser.values())
    .sort((a, b) => b.amount - a.amount || a.ts - b.ts)
    .map((b) => ({ userId: b.userId, userName: b.userName, avatar: b.avatar, amount: b.amount, self: b.self }));
}

function snapshot(m: Model, lot: Lot, now: number): AuctionState {
  const rank = ranking(m);
  const myRank = m.myMax != null ? rank.findIndex((r) => r.userId === ME.id) + 1 || null : null;
  const leader = m.bids.find((b) => b.userId === m.leaderId) ?? m.bids[0] ?? null;
  return {
    status: m.status,
    startsInMs: Math.max(0, m.startsAt - now),
    remainingMs: Math.max(0, m.endsAt - now),
    totalMs: m.totalMs,
    currentPrice: m.currentPrice,
    leader,
    bids: m.bids,
    ranking: rank,
    participants: m.maxByUser.size,
    myMaxBid: m.myMax,
    myRank,
    extendedFlash: m.extendedFlash,
    lastEvent: m.lastEvent,
    bidCount: m.bids.length,
  };
}

function applyBid(m: Model, lot: Lot, b: Bid, now: number): void {
  m.bids = [b, ...m.bids].slice(0, 60);
  m.currentPrice = b.amount;
  const wasLeaderMe = m.leaderId === ME.id;
  m.leaderId = b.userId;
  const prev = m.maxByUser.get(b.userId);
  if (!prev || b.amount > prev.amount) m.maxByUser.set(b.userId, b);
  if (b.self) m.myMax = Math.max(m.myMax ?? 0, b.amount);

  if (b.self) {
    m.lastEvent = { kind: 'leading', amount: b.amount };
  } else if (wasLeaderMe) {
    m.lastEvent = { kind: 'outbid', by: b.userName, amount: b.amount };
  }

  const remaining = m.endsAt - now;
  if (m.status !== 'sold' && m.status !== 'unsold' && remaining < ENDING_WINDOW_MS && m.currentPrice < lot.capPrice) {
    m.endsAt = now + lot.extendSec * 1000;
    m.extendedFlash = now;
    m.lastEvent = { kind: 'extend', addSec: lot.extendSec };
  }

  if (m.currentPrice >= lot.capPrice) {
    settle(m, lot, now, { cap: true });
  }
}

function settle(m: Model, lot: Lot, now: number, opt?: { cap?: boolean }): void {
  const won = m.leaderId === ME.id;
  if (m.bids.length === 0) {
    m.status = 'unsold';
  } else {
    m.status = 'sold';
  }
  m.endsAt = now;
  m.settledWon = won;
  if (opt?.cap) m.lastEvent = { kind: 'cap' };
  m.lastEvent = { kind: 'settle', won: m.status === 'sold' && won, price: m.currentPrice };
}

export function useAuctionEngine(lot: Lot, opts: Opts = {}) {
  const { seedToPrice, startDelaySec = 0, running = true, onEvent } = opts;
  const modelRef = useRef<Model | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const lastEmittedRef = useRef<EngineEvent | null>(null);

  const init = useCallback((): Model => {
    const now = Date.now();
    const m: Model = {
      status: startDelaySec > 0 ? 'upcoming' : 'live',
      startsAt: now + startDelaySec * 1000,
      endsAt: now + (startDelaySec > 0 ? startDelaySec + lot.durationSec : lot.durationSec) * 1000,
      totalMs: lot.durationSec * 1000,
      currentPrice: lot.startPrice,
      leaderId: null,
      bids: [],
      maxByUser: new Map(),
      myMax: null,
      autoBidMax: null,
      nextBotAt: now + 1500 + Math.random() * 1500,
      lastEvent: null,
      extendedFlash: 0,
      settledWon: null,
    };
    if (seedToPrice && seedToPrice > lot.startPrice) {
      let price = lot.startPrice <= 0 ? lot.increment : lot.startPrice;
      let t = now - 45_000;
      while (price <= seedToPrice) {
        const u = pick(BOT_USERS);
        applyBid(m, lot, { id: bid(), userId: u.id, userName: u.name, avatar: u.avatar, color: u.color, amount: price, ts: t }, t);
        price += lot.increment * (1 + (Math.random() < 0.25 ? 1 : 0));
        t += 1500 + Math.random() * 2500;
      }
      const u1 = BOT_USERS[0];
      const top = seedToPrice;
      applyBid(m, lot, { id: bid(), userId: u1.id, userName: u1.name, avatar: u1.avatar, color: u1.color, amount: top, ts: now - 1500 }, now - 1500);
      m.status = startDelaySec > 0 ? 'upcoming' : 'live';
      m.endsAt = now + (startDelaySec > 0 ? startDelaySec + lot.durationSec : lot.durationSec) * 1000;
    }
    return m;
  }, [lot, seedToPrice, startDelaySec]);

  const [state, setState] = useState<AuctionState>(() => {
    const m = init();
    modelRef.current = m;
    return snapshot(m, lot, Date.now());
  });

  const botStep = useCallback(
    (m: Model, now: number) => {
      if (m.status === 'sold' || m.status === 'unsold' || m.status === 'upcoming') return;
      if (now < m.nextBotAt) return;
      const nextMin = computeNextMin(m, lot);
      if (nextMin > lot.capPrice) return;
      const headroom = (lot.capPrice - m.currentPrice) / lot.capPrice;
      const eager = Math.random() < 0.7 * Math.max(0.2, headroom) + 0.15;
      if (eager) {
        const bump = Math.random() < 0.2 ? 2 : 1;
        const amount = Math.min(lot.capPrice, nextMin + (bump - 1) * lot.increment);
        const u = pick(BOT_USERS);
        applyBid(m, lot, { id: bid(), userId: u.id, userName: u.name, avatar: u.avatar, color: u.color, amount, ts: now }, now);

        if (m.autoBidMax != null && m.leaderId !== ME.id) {
          const myNext = computeNextMin(m, lot);
          if (myNext <= m.autoBidMax) {
            applyBid(m, lot, { id: bid(), userId: ME.id, userName: ME.name, avatar: ME.avatar, color: ME.color, amount: myNext, ts: now + 1, self: true }, now + 1);
          }
        }
      }
      const speed = m.status === 'ending' ? 700 : 1400;
      m.nextBotAt = now + speed + Math.random() * 2200;
    },
    [lot]
  );

  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let alive = true;
    const loop = () => {
      if (!alive) return;
      const m = modelRef.current!;
      const now = Date.now();

      if (m.status === 'upcoming' && now >= m.startsAt) {
        m.status = 'live';
        m.endsAt = now + m.totalMs;
        m.lastEvent = { kind: 'start' };
      }
      if (m.status === 'live' || m.status === 'ending') {
        m.status = m.endsAt - now <= ENDING_WINDOW_MS ? 'ending' : 'live';
        botStep(m, now);
        if (now >= m.endsAt) settle(m, lot, now);
      }

      if (m.lastEvent && m.lastEvent !== lastEmittedRef.current) {
        lastEmittedRef.current = m.lastEvent;
        onEventRef.current?.(m.lastEvent);
      }
      setState(snapshot(m, lot, now));
      raf = window.setTimeout(loop, 60) as unknown as number;
    };
    loop();
    return () => {
      alive = false;
      window.clearTimeout(raf);
    };
  }, [running, botStep, lot]);

  const nextMinBid = modelRef.current ? computeNextMin(modelRef.current, lot) : lot.startPrice;

  const placeBid = useCallback(
    (amount: number): { ok: boolean; reason?: string } => {
      const m = modelRef.current!;
      const now = Date.now();
      if (m.status !== 'live' && m.status !== 'ending') return { ok: false, reason: 'not biddable' };
      const min = computeNextMin(m, lot);
      if (amount < min) return { ok: false, reason: `出价需 ≥ ¥${min}` };
      const amt = Math.min(amount, lot.capPrice);
      applyBid(m, lot, { id: bid(), userId: ME.id, userName: ME.name, avatar: ME.avatar, color: ME.color, amount: amt, ts: now, self: true }, now);
      setState(snapshot(m, lot, now));
      return { ok: true };
    },
    [lot]
  );

  const setAutoBidMax = useCallback((max: number | null) => {
    const m = modelRef.current!;
    m.autoBidMax = max;
  }, []);

  const restart = useCallback(() => {
    const m = init();
    modelRef.current = m;
    lastEmittedRef.current = null;
    setState(snapshot(m, lot, Date.now()));
  }, [init, lot]);

  return { state, nextMinBid, placeBid, setAutoBidMax, autoBidMax: modelRef.current?.autoBidMax ?? null, restart };
}
