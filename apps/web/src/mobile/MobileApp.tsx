import { useEffect, useRef, useState } from 'react';
import LiveRoom from './LiveRoom';
import { ROOMS } from '../lib/mockData';
import { SwipeHint } from './components';
import { api } from '../backend/lib/api.js';
import { auctionsToRooms } from '../lib/mapBackend';
import type { Room } from '../lib/types';
import './mobile.css';

// Real buyer end: the room rail is driven by GET /api/auctions (LIVE/SCHEDULED).
// useAuctionEngine inside each LiveRoom then connects that room's WebSocket and
// runs real bids. mock ROOMS is a DEV-only fallback (VITE_USE_MOCK_DATA=true)
// for offline design work — never used when the backend returns auctions.
const USE_MOCK = String((import.meta as any).env?.VITE_USE_MOCK_DATA ?? 'false') === 'true';

export default function MobileApp() {
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [index, setIndex] = useState(0);
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

  const list = rooms ?? [];
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
        <LiveRoom room={room} />
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
