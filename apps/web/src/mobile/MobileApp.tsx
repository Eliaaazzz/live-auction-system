import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import LiveRoom from './LiveRoom';
import { ROOMS } from '../lib/mockData';
import { SwipeHint } from './components';
import { LoginGate } from './account';
import { useIdentity, seatIdentity, type SeatIdentity } from '../lib/identity';
import { api } from '../backend/lib/api.js';
import { auctionsToRooms } from '../lib/mapBackend';
import type { Room } from '../lib/types';
import OrderView from './OrderView';
import './mobile.css';

// Real buyer end: the room rail is driven by GET /api/auctions (LIVE/SCHEDULED).
// useAuctionEngine inside each LiveRoom then connects that room's WebSocket and
// runs real bids. mock ROOMS is a DEV-only fallback (VITE_USE_MOCK_DATA=true)
// for offline design work — never used when the backend returns auctions.
const USE_MOCK = String((import.meta as any).env?.VITE_USE_MOCK_DATA ?? 'false') === 'true';

// #/m?order=<auctionId> → login-free shareable order/result page (send to a friend).
function readOrderParam(): string | null {
  if (typeof window === 'undefined') return null;
  const q = window.location.hash.split('?')[1] || '';
  return new URLSearchParams(q).get('order');
}

// #/m?room=<auctionId> → deep-link straight into a specific live room (share link).
function readRoomParam(): string | null {
  if (typeof window === 'undefined') return null;
  const q = window.location.hash.split('?')[1] || '';
  return new URLSearchParams(q).get('room');
}

export default function MobileApp({ startIndex = 0, autoGuest = false, seat = '' }: { startIndex?: number; autoGuest?: boolean; seat?: string } = {}) {
  const orderId = readOrderParam();
  // #3/#4 unified identity: gate the buyer rail behind a lightweight nickname
  // login. The login-free order page (#/m?order=) stays exempt above. The
  // desktop Showcase passes autoGuest so its preview phones skip straight in
  // (the real login lives on a phone at /m). A returning user is hydrated
  // synchronously (no flash); resolve() just refreshes the backend userId.
  const ready = useIdentity((s) => s.ready);
  const resolve = useIdentity((s) => s.resolve);
  const continueAsGuest = useIdentity((s) => s.continueAsGuest);
  // Showcase seats (买家A/买家B) own a FIXED per-seat identity + their own backend
  // session (minted inside the engine, keyed by seat). They never touch the global
  // login store — that global singleton is exactly what collapsed A and B into one
  // account before. So seat panes skip the login gate entirely.
  const seatIdent = useMemo<SeatIdentity | null>(() => (seat ? seatIdentity(seat) : null), [seat]);
  useEffect(() => {
    if (seat) return; // seat panes manage their own session; never mutate the global identity
    if (ready) resolve();
    else if (autoGuest) continueAsGuest();
  }, [seat, ready, autoGuest, resolve, continueAsGuest]);

  if (orderId) return <OrderView auctionId={orderId} />;
  if (seat && seatIdent) return <BuyerRail startIndex={startIndex} seat={seat} identity={seatIdent} />;
  if (!ready) return autoGuest ? <CenterMsg text="正在进入直播间…" sub="LOADING" /> : <LoginGate />;
  return <BuyerRail startIndex={startIndex} />;
}

function BuyerRail({ startIndex = 0, seat = '', identity }: { startIndex?: number; seat?: string; identity?: SeatIdentity }) {
  const [rooms, setRooms] = useState<Room[] | null>(null);
  // startIndex lets the Showcase open a second phone on a different live room.
  // It's only the initial room; safeIndex below clamps it once rooms load.
  const [index, setIndex] = useState(startIndex);
  const [dir, setDir] = useState<'up' | 'down'>('up');
  const cooldown = useRef(false);
  const touchY = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { auctions = [] } = await api.listAuctions();
        if (!alive) return;
        const mapped = auctionsToRooms(auctions);
        const rp = readRoomParam();
        if (rp) { const i = mapped.findIndex((r) => r.id === rp); if (i >= 0) setIndex(i); }
        setRooms(mapped.length ? mapped : (USE_MOCK ? ROOMS : []));
      } catch {
        if (alive) setRooms(USE_MOCK ? ROOMS : []);
      }
    })();
    const poll = setInterval(async () => {
      try {
        const { auctions = [] } = await api.listAuctions();
        const mapped = auctionsToRooms(auctions);
        if (alive && mapped.length) setRooms((prev) => (sameIds(prev, mapped) ? prev : mapped));
      } catch { /* keep current */ }
    }, 15_000);
    return () => { alive = false; clearInterval(poll); };
  }, []);

  // Preload the posters of the adjacent rooms so a swipe paints the next product
  // instantly — VideoBackground's <img>/poster (same 900w variant) is already
  // decoded — instead of a black frame while the image fetches. No extra WS/engine.
  useEffect(() => {
    const ls = rooms ?? [];
    if (ls.length < 2) return;
    for (const off of [1, -1]) {
      const r = ls[(index + off + ls.length) % ls.length];
      if (!r) continue;
      const img = new Image();
      img.src = r.lot.image.replace(/w=\d+/, 'w=900'); // match VideoBackground bgImg
    }
  }, [index, rooms]);

  const list = rooms ?? [];

  // Refs keep `advance` stable (empty deps) so LiveRoom's ended-overlay 5s timer
  // effect — which depends on this callback's identity — fires exactly once.
  const indexRef = useRef(index); indexRef.current = index;
  const lenRef = useRef(list.length); lenRef.current = list.length;
  // 一件拍品结束(流拍/落槌) 5s 后自动「进入下一件」：等同向上滑到下一个直播间。
  const advance = useCallback(() => {
    const len = lenRef.current;
    if (len < 2 || cooldown.current) return;
    cooldown.current = true;
    setDir('up');
    setIndex((i) => (i + 1) % len);
    setTimeout(() => (cooldown.current = false), 480);
  }, []);

  const go = (next: number, direction: 'up' | 'down') => {
    if (cooldown.current || list.length < 2) return;
    const clamped = (next + list.length) % list.length;
    if (clamped === index) return;
    cooldown.current = true;
    setDir(direction);
    setIndex(clamped);
    setTimeout(() => (cooldown.current = false), 480);
  };
  const onWheel = (e: React.WheelEvent) => {
    if (Math.abs(e.deltaY) < 24) return;
    go(index + (e.deltaY > 0 ? 1 : -1), e.deltaY > 0 ? 'up' : 'down');
  };
  const onTouchStart = (e: React.TouchEvent) => { touchY.current = e.touches[0].clientY; };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchY.current == null) return;
    const dy = touchY.current - e.changedTouches[0].clientY;
    if (Math.abs(dy) > 56) go(index + (dy > 0 ? 1 : -1), dy > 0 ? 'up' : 'down');
    touchY.current = null;
  };

  if (rooms === null) return <CenterMsg text="正在加载直播场次…" sub="LOADING LIVE AUCTIONS" />;
  if (list.length === 0) return <CenterMsg text="暂无正在直播的竞拍" sub="卖家可在管理后台「竞拍发布」开播" />;

  const safeIndex = Math.min(index, list.length - 1);
  const room = list[safeIndex];

  return (
    <div
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: '#000' }}
      onWheel={onWheel}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div key={room.id} className={'lm-room in-' + dir}>
        <LiveRoom room={room} seat={seat} identity={identity} onEnded={list.length > 1 ? advance : undefined} />
      </div>

      {safeIndex === 0 && list.length > 1 && <SwipeHint />}

      <div className="lm-dots">
        {list.map((r, i) => (
          <i key={r.id} className={i === safeIndex ? 'on' : ''} />
        ))}
      </div>
    </div>
  );
}

function sameIds(a: Room[] | null, b: Room[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((r, i) => r.id === b[i].id);
}

function CenterMsg({ text, sub }: { text: string; sub?: string }) {
  return (
    <div style={{
      width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 10, background: '#0a0a14',
      color: '#f5f5f7', fontFamily: 'system-ui, sans-serif', textAlign: 'center', padding: 24,
    }}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{text}</div>
      {sub && <div style={{ fontSize: 12, color: '#9aa0b4' }}>{sub}</div>}
    </div>
  );
}
