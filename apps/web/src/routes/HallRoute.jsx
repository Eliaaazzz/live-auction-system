// src/routes/HallRoute.jsx
//
// Consumer entry point (spec §4 竞拍浏览): the buyer lands here, sets a
// lightweight identity (nickname → dev-login session), browses live/upcoming
// auctions (product, status, current price, countdown), and taps into a room.
//
// Data: api.listAuctions() → GET /api/auctions. Identity: ensureSession(nick)
// caches a JWT in localStorage that LiveRoomRoute then reuses, so "who am I"
// is consistent from the hall into the room.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { ensureSession, currentUser, clearSession } from '../lib/auth.js';
import { msRemaining } from '../lib/clock.js';
import { formatCentsCNY, StatusBadge, Countdown } from '../components/primitives.jsx';

const LIVE = 'LIVE';
const SCHEDULED = 'SCHEDULED';
const ENDED = ['SOLD', 'NO_BID', 'CANCELLED'];

function guestName() {
  return `游客${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

export function HallRoute() {
  const navigate = useNavigate();
  const [auctions, setAuctions] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [user, setUser] = useState(() => currentUser());
  const [nick, setNick] = useState(() => currentUser()?.nickname || '');
  const [editing, setEditing] = useState(() => !currentUser());
  const [busy, setBusy] = useState(false);
  const tickRef = useRef(0);
  const [, force] = useState(0); // 1Hz re-render so live countdowns advance

  const load = useCallback(async () => {
    try {
      const { auctions: list = [] } = await api.listAuctions();
      setAuctions(list);
      setError(null);
    } catch (e) {
      setError(e?.message || String(e));
      setAuctions([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Refresh the list every 10s (new auctions / status changes) + tick 1Hz for
  // the live countdowns.
  useEffect(() => {
    const sec = setInterval(() => force((n) => n + 1), 1000);
    const poll = setInterval(load, 10_000);
    return () => { clearInterval(sec); clearInterval(poll); };
  }, [load]);

  const confirmIdentity = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Force the chosen nickname even if a stale token is cached.
      clearSession();
      const s = await ensureSession(nick.trim() || guestName());
      setUser({ userId: s.userId, nickname: s.nickname });
      setNick(s.nickname);
      setEditing(false);
    } catch (e) {
      setError(`身份创建失败：${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  const enterRoom = async (id) => {
    try {
      if (!currentUser()) await ensureSession(nick.trim() || guestName());
    } catch { /* room will retry its own session */ }
    navigate(`/room/${id}`);
  };

  const live = (auctions || []).filter((a) => a.status === LIVE);
  const upcoming = (auctions || []).filter((a) => a.status === SCHEDULED);
  const past = (auctions || []).filter((a) => ENDED.includes(a.status));

  return (
    <div style={S.page}>
      {/* Header */}
      <div style={S.header}>
        <div style={S.brandRow}>
          <div style={S.logo}>琉</div>
          <div>
            <div style={S.brandTitle}>琉森拍卖</div>
            <div style={S.brandSub}>实时竞拍 · LIVE AUCTION</div>
          </div>
        </div>

        {/* Identity */}
        {editing ? (
          <div style={S.idRow}>
            <input
              style={S.input}
              value={nick}
              maxLength={16}
              placeholder="给自己起个名字"
              onChange={(e) => setNick(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmIdentity(); }}
            />
            <button style={S.idBtn} disabled={busy} onClick={confirmIdentity}>
              {busy ? '…' : '进入'}
            </button>
          </div>
        ) : (
          <div style={S.idRowDone}>
            <span style={S.idWho}>我是 <b style={{ color: 'var(--solemn-gold)' }}>{user?.nickname}</b></span>
            <button style={S.idChange} onClick={() => setEditing(true)}>修改</button>
          </div>
        )}
      </div>

      {/* Body */}
      <div style={S.body} className="no-scrollbar">
        {auctions === null && <div style={S.muted}>正在加载竞拍场次…</div>}
        {error && <div style={S.error}>加载失败：{error}</div>}
        {auctions !== null && auctions.length === 0 && !error && (
          <div style={S.empty}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🛎️</div>
            暂无竞拍场次<br/>
            <span style={{ fontSize: 12, color: 'var(--douyin-ink-muted)' }}>
              商家可在管理后台「新建拍品」发布
            </span>
          </div>
        )}

        {live.length > 0 && (
          <Section title="正在直播" accent="var(--state-live)">
            {live.map((a) => <AuctionCard key={a.auctionId} a={a} onEnter={enterRoom}/>)}
          </Section>
        )}
        {upcoming.length > 0 && (
          <Section title="即将开始" accent="var(--solemn-gold)">
            {upcoming.map((a) => <AuctionCard key={a.auctionId} a={a} onEnter={enterRoom}/>)}
          </Section>
        )}
        {past.length > 0 && (
          <Section title="历史竞拍" accent="var(--douyin-ink-dim)">
            {past.map((a) => <AuctionCard key={a.auctionId} a={a} onEnter={enterRoom} ended/>)}
          </Section>
        )}
      </div>
    </div>
  );
}

function Section({ title, accent, children }) {
  return (
    <section style={{ marginBottom: 22 }}>
      <div style={{
        fontSize: 12, fontWeight: 700, letterSpacing: '.08em', color: accent,
        margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ width: 4, height: 12, background: accent, borderRadius: 2 }}/>
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{children}</div>
    </section>
  );
}

function AuctionCard({ a, onEnter, ended = false }) {
  const remaining = a.endAtMs ? msRemaining(a.endAtMs) : 0;
  const price = a.currentPriceCents && a.currentPriceCents !== '0'
    ? formatCentsCNY(a.currentPriceCents) : '—';
  return (
    <div style={{ ...S.card, opacity: ended ? 0.72 : 1 }}>
      <div style={S.thumb}>
        {a.imageUrl
          ? <img src={a.imageUrl} alt="" style={S.thumbImg}
              onError={(e) => { e.currentTarget.style.display = 'none'; }}/>
          : <span style={{ fontSize: 22 }}>💎</span>}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <StatusBadge status={a.status} size="sm"/>
          {a.status === LIVE && remaining > 0 && (
            <Countdown remainingMs={remaining} size="sm"/>
          )}
        </div>
        <div style={S.cardTitle}>{a.productName || a.auctionId}</div>
        <div style={S.cardPrice}>
          {a.status === LIVE ? '当前价 ' : ended ? '成交价 ' : '起拍 '}
          <b style={{ color: 'var(--solemn-gold)', fontSize: 15 }}>{price}</b>
        </div>
      </div>
      <button
        style={{ ...S.enterBtn, ...(ended ? S.enterBtnGhost : {}) }}
        onClick={() => onEnter(a.auctionId)}>
        {ended ? '查看结果' : '进入竞拍'}
      </button>
    </div>
  );
}

const S = {
  page: {
    width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
    background: 'linear-gradient(180deg,#10131e 0%,#0a0c14 100%)',
    color: 'var(--douyin-ink-text,#f5f5f7)', fontFamily: 'var(--font-sans)',
  },
  header: { flexShrink: 0, padding: '16px 16px 12px', borderBottom: '1px solid rgba(255,255,255,.06)' },
  brandRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 },
  logo: {
    width: 38, height: 38, borderRadius: 10, flexShrink: 0,
    background: 'linear-gradient(135deg,var(--douyin-red,#FE2C55),var(--solemn-gold,#C9A961))',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: 'var(--font-serif)', fontWeight: 700, fontSize: 20, color: '#fff',
  },
  brandTitle: { fontSize: 16, fontWeight: 700 },
  brandSub: { fontSize: 10, color: 'rgba(245,237,221,.5)', letterSpacing: '.14em', marginTop: 2 },
  idRow: { display: 'flex', gap: 8 },
  input: {
    flex: 1, height: 38, borderRadius: 9, padding: '0 12px', fontSize: 14,
    background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.12)',
    color: '#fff', outline: 'none',
  },
  idBtn: {
    height: 38, padding: '0 18px', borderRadius: 9, border: 'none', cursor: 'pointer',
    background: 'var(--douyin-red,#FE2C55)', color: '#fff', fontSize: 14, fontWeight: 600,
  },
  idRowDone: { display: 'flex', alignItems: 'center', gap: 10 },
  idWho: { fontSize: 13, color: 'rgba(245,237,221,.85)' },
  idChange: {
    fontSize: 12, color: 'var(--douyin-cyan,#25F4EE)', background: 'none',
    border: 'none', cursor: 'pointer', padding: 0,
  },
  body: { flex: 1, overflow: 'auto', padding: '16px 16px 60px', minHeight: 0 },
  muted: { color: 'var(--douyin-ink-muted,#9aa0b4)', fontSize: 13, textAlign: 'center', padding: 40 },
  error: { color: 'var(--state-rejected,#FE2C55)', fontSize: 13, padding: 16, textAlign: 'center' },
  empty: { color: 'rgba(245,237,221,.7)', fontSize: 14, textAlign: 'center', padding: '56px 20px', lineHeight: 1.7 },
  card: {
    display: 'flex', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12,
    background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.07)',
  },
  thumb: {
    width: 56, height: 56, borderRadius: 10, flexShrink: 0, overflow: 'hidden',
    background: 'linear-gradient(135deg,#1b2030,#2a1c24)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  thumbImg: { width: '100%', height: '100%', objectFit: 'cover' },
  cardTitle: {
    fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden',
    textOverflow: 'ellipsis', marginBottom: 2,
  },
  cardPrice: { fontSize: 11, color: 'var(--douyin-ink-muted,#9aa0b4)' },
  enterBtn: {
    flexShrink: 0, height: 34, padding: '0 14px', borderRadius: 8, border: 'none',
    cursor: 'pointer', background: 'var(--douyin-red,#FE2C55)', color: '#fff',
    fontSize: 13, fontWeight: 600,
  },
  enterBtnGhost: {
    background: 'transparent', border: '1px solid rgba(255,255,255,.18)',
    color: 'rgba(245,237,221,.8)',
  },
};

export default HallRoute;
