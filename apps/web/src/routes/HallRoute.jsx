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
import { formatCentsCNYShort, StatusBadge, Countdown } from '../components/primitives.jsx';

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

  // P0-2 (judges-stage review): the first screen must read "实时竞拍剧场",
  // not a CRUD list. Hero = the hottest LIVE auction (falls back to the next
  // SCHEDULED one); it leaves its section so the list below never duplicates.
  const hero = live[0] || upcoming[0] || null;
  const liveRest = hero ? live.filter((a) => a !== hero) : live;
  const upcomingRest = hero ? upcoming.filter((a) => a !== hero) : upcoming;

  return (
    <div style={S.page}>
      {/* Header */}
      <div style={S.header}>
        <div style={S.brandRow}>
          <div style={S.logo}>琉</div>
          <div>
            <div style={S.brandTitle}>琉森拍卖行</div>
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
        {error && (
          <div style={S.error}>
            <div>连接服务器失败 · 每 10 秒自动重试</div>
            <button onClick={load} style={S.retryBtn}>立即重试</button>
            <div style={{ fontSize: 10, opacity: .6, marginTop: 6 }}>{error}</div>
          </div>
        )}
        {auctions !== null && auctions.length === 0 && !error && (
          <div style={S.empty}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🛎️</div>
            暂无竞拍场次<br/>
            <span style={{ fontSize: 12, color: 'var(--douyin-ink-muted)' }}>
              卖家可在管理后台「新建拍品」发布
            </span>
          </div>
        )}

        {hero && <HallHero a={hero} onEnter={enterRoom}/>}

        {liveRest.length > 0 && (
          <Section title="正在直播" accent="var(--state-live)">
            {liveRest.map((a) => <AuctionCard key={a.auctionId} a={a} onEnter={enterRoom}/>)}
          </Section>
        )}
        {upcomingRest.length > 0 && (
          <Section title="即将开始" accent="var(--solemn-gold)">
            {upcomingRest.map((a) => <AuctionCard key={a.auctionId} a={a} onEnter={enterRoom}/>)}
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

// ─── HallHero — P0-2: 拍卖剧场 first screen ─────────────────────────
// One LIVE (or next SCHEDULED) auction as a stage: image, live badge,
// current price, countdown, the anti-snipe rule, and a single dominant
// CTA — 进入竞拍现场. The trust footer names the engineering, so the very
// first screen already says "实时同步 · 可追溯 · 有证据链", not "a list".
// Exported for tests.
export function HallHero({ a, onEnter }) {
  const isLive = a.status === LIVE;
  const remaining = a.endAtMs ? msRemaining(a.endAtMs) : 0;
  const price = a.currentPriceCents && a.currentPriceCents !== '0'
    ? formatCentsCNYShort(a.currentPriceCents) : null;
  return (
    <section
      aria-label="主推竞拍"
      style={{
        position: 'relative', overflow: 'hidden', borderRadius: 16,
        marginBottom: 22, minHeight: 218,
        border: isLive ? '1px solid rgba(254,44,85,.35)' : '1px solid rgba(201,169,97,.3)',
        background: 'linear-gradient(160deg, #221826 0%, #141220 55%, #0c0e18 100%)',
        display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
      }}>
      {/* item image as the stage backdrop */}
      {a.imageUrl && (
        <img src={a.imageUrl} alt=""
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
          style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%',
            objectFit: 'cover', opacity: .62,
          }}/>
      )}
      {/* legibility scrim — image stays visible, copy stays readable */}
      <div aria-hidden style={{
        position: 'absolute', inset: 0,
        background: 'linear-gradient(180deg, rgba(10,10,18,.08) 0%, rgba(10,10,18,.55) 52%, rgba(10,10,18,.92) 100%)',
      }}/>

      {/* top-left: live badge + countdown */}
      <div style={{
        position: 'absolute', top: 12, left: 12, right: 12,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <StatusBadge status={a.status} size="sm"/>
        {isLive && remaining > 0 && <Countdown remainingMs={remaining} size="sm"/>}
        <div style={{ flex: 1 }}/>
        <span className="mono" style={{
          fontSize: 9, color: 'rgba(245,237,221,.75)', letterSpacing: '.06em',
          padding: '3px 8px', borderRadius: 999,
          background: 'rgba(0,0,0,.45)', border: '1px solid rgba(255,255,255,.14)',
        }}>
          末 10 秒出价自动延时
        </span>
      </div>

      {/* bottom: name · price · CTA */}
      <div style={{ position: 'relative', padding: '14px 14px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="serif" style={{
          fontSize: 19, fontWeight: 600, lineHeight: 1.3, color: '#f5f0e4',
          overflow: 'hidden', textOverflow: 'ellipsis',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
        }}>
          {a.productName || a.auctionId}
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10, color: 'rgba(245,237,221,.6)' }}>
              {isLive ? '当前价' : '起拍价'}
            </div>
            <div className="mono" style={{
              fontSize: 26, fontWeight: 800, lineHeight: 1.1,
              color: 'var(--solemn-gold)', textShadow: '0 2px 18px rgba(201,169,97,.35)',
            }}>
              {price || '待开拍'}
            </div>
          </div>
          <button
            onClick={() => onEnter(a.auctionId)}
            style={{
              flexShrink: 0, minHeight: 46, padding: '0 20px', borderRadius: 12,
              border: 'none', cursor: 'pointer',
              background: isLive
                ? 'linear-gradient(135deg, var(--douyin-red,#FE2C55), #ff5c7a)'
                : 'linear-gradient(135deg, var(--solemn-gold,#C9A961), #dcbf7f)',
              color: isLive ? '#fff' : '#2a2310',
              fontSize: 15, fontWeight: 800, letterSpacing: '.02em',
              boxShadow: isLive ? '0 8px 24px rgba(254,44,85,.4)' : '0 8px 24px rgba(201,169,97,.32)',
            }}>
            {isLive ? '进入竞拍现场 →' : '提前进场 →'}
          </button>
        </div>
        <div className="mono" style={{
          fontSize: 9, color: 'rgba(245,237,221,.5)', letterSpacing: '.04em',
        }}>
          WebSocket 实时同步 · seq 可追溯 · 证据链落槌生成
        </div>
      </div>
    </section>
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
    ? formatCentsCNYShort(a.currentPriceCents) : '—';
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
          {a.status === LIVE ? '当前价 ' : ended ? '成交价 ' : '起拍价 '}
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
  retryBtn: {
    marginTop: 10, minHeight: 36, padding: '0 18px', borderRadius: 8, cursor: 'pointer',
    background: 'transparent', border: '1px solid rgba(254,44,85,.45)',
    color: 'var(--state-rejected,#FE2C55)', fontSize: 12, fontWeight: 600,
  },
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
