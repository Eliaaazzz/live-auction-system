// src/routes/JudgesShowcaseRoute.jsx
//
// /showcase — 评委导演模式 (P0-1, judges-stage review).
//
// NOT a fake: a clearly-labeled, scripted STAGE that reuses the exact same
// production components (MobileRoom / MobileHammer / MobileEvidence) with
// deterministic props, so the 90-second judge path can be told reliably even
// if the venue network / seed data / WS misbehaves. The header banner says
// 导演模式 · 脚本数据 in plain text — what's being demonstrated is the UX
// and the event grammar (seq, extend, hammer, evidence), not live traffic.
//
// Layout:  [买家 A 手机]  [买家 B 手机]  [证据/指标栏]
//          [   导演按钮条: 末10秒 → A出价 → B反超 → 反狙击 → 落槌 → 证据卡 ]
//
// All state lives in showcaseReducer (exported, unit-tested): every director
// button is one dispatched action; both phones render two PERSPECTIVES of
// the same scripted room (isYou / leadingToast / overtakeBanner flip per
// viewer), which is exactly the dual-browser demo script in #234/#238.

import React from 'react';
import { Link } from 'react-router-dom';
import { MobileRoom, MobileEvidence } from '../components/mobile.jsx';

// ─── scripted identities ────────────────────────────────────────
const VIEWER_A = { userId: 'uA', displayName: '陆_LU',     avatarBg: 'linear-gradient(135deg,#a855f7,#7c3aed)' };
const VIEWER_B = { userId: 'uB', displayName: '海风_2024', avatarBg: 'linear-gradient(135deg,#FE2C55,#cb203f)' };
const ITEM = {
  productName: '劳力士 Explorer 114270 · 黑面',
  lotNo: '2024-0142',
  productImage: '/demo/watch-explorer.jpg',
  capCents: '30000000',
};

export const SHOWCASE_STEPS = [
  { key: 'FINAL10',  label: '末10秒',   hint: '进入终局节奏' },
  { key: 'BID_A',    label: 'A 出价',   hint: 'A 领先 · B 被超越' },
  { key: 'BID_B',    label: 'B 反超',   hint: 'B 领先 · A 被超越' },
  { key: 'EXTEND',   label: '反狙击延时', hint: '+30s · 规则可见' },
  { key: 'HAMMER',   label: '落槌',     hint: 'A→B 翻转' },
  { key: 'EVIDENCE', label: '证据卡',   hint: '哈希链收束' },
];

export function initialShowcase() {
  const seq0 = 14920;
  return {
    stepIdx: 0,                  // next suggested director step
    status: 'LIVE',
    currentCents: '12880000',
    stepCents: '500000',
    remainingMs: 28_000,
    extendCount: 2,
    lastSeq: seq0,
    bidsPerSec: 0.8,
    leaderId: VIEWER_B.userId,
    winnerId: null,
    // scripted event log → ticker + synthesized evidence timeline
    events: [
      { type: 'BID_ACCEPTED', seq: seq0, by: VIEWER_B, amountCents: '12880000' },
    ],
    // one-shot per-viewer flags, cleared by CLEAR_FLASH
    flags: { A: {}, B: {} },
    extendFlash: null,
    showEvidence: false,
  };
}

function addCents(a, b) {
  try { return (BigInt(a) + BigInt(b)).toString(); } catch { return String(a); }
}

// showcaseReducer — one action per director button (+ TICK / CLEAR_FLASH /
// BID_FROM for judges tapping the real chips). Deterministic, no Date.now.
export function showcaseReducer(s, action) {
  switch (action.type) {
    case 'TICK': {
      if (s.status !== 'LIVE') return s;
      const remainingMs = Math.max(0, s.remainingMs - (action.ms ?? 250));
      return { ...s, remainingMs };
    }
    case 'CLEAR_FLASH':
      return { ...s, flags: { A: {}, B: {} }, extendFlash: null };

    case 'FINAL10':
      return { ...s, stepIdx: 1, remainingMs: Math.min(s.remainingMs, 9_800), bidsPerSec: Math.max(s.bidsPerSec, 2.2) };

    case 'BID_A':
    case 'BID_B':
    case 'BID_FROM': {
      if (s.status !== 'LIVE') return s;
      const who = action.type === 'BID_A' ? 'A' : action.type === 'BID_B' ? 'B' : action.who;
      const viewer = who === 'A' ? VIEWER_A : VIEWER_B;
      const amountCents = action.amountCents || addCents(s.currentCents, s.stepCents);
      try { if (BigInt(amountCents) <= BigInt(s.currentCents)) return s; } catch { return s; }
      const seq = s.lastSeq + 1;
      const other = who === 'A' ? 'B' : 'A';
      const otherWasLeading = s.leaderId === (other === 'A' ? VIEWER_A.userId : VIEWER_B.userId);
      // final-10s bid auto-arms anti-snipe? No — keep EXTEND an explicit
      // director beat so the narration controls the moment.
      return {
        ...s,
        stepIdx: Math.max(s.stepIdx, who === 'A' ? 2 : 3),
        currentCents: amountCents,
        lastSeq: seq,
        leaderId: viewer.userId,
        bidsPerSec: Math.min(6, s.bidsPerSec + 1.2),
        events: [...s.events, { type: 'BID_ACCEPTED', seq, by: viewer, amountCents }],
        flags: {
          ...s.flags,
          [who]: { leadingToast: true },
          [other]: otherWasLeading ? { overtakeBanner: true } : s.flags[other],
        },
      };
    }

    case 'EXTEND': {
      if (s.status !== 'LIVE') return s;
      const seq = s.lastSeq + 1;
      const extendCount = s.extendCount + 1;
      return {
        ...s,
        stepIdx: Math.max(s.stepIdx, 4),
        extendCount,
        lastSeq: seq,
        remainingMs: s.remainingMs + 30_000,
        extendFlash: { count: extendCount, seq, addedSec: 30 },
        events: [...s.events, { type: 'AUCTION_EXTENDED', seq, extendCount }],
      };
    }

    case 'HAMMER': {
      if (s.status !== 'LIVE') return s;
      const seq = s.lastSeq + 1;
      const winner = s.leaderId === VIEWER_A.userId ? VIEWER_A : VIEWER_B;
      return {
        ...s,
        stepIdx: Math.max(s.stepIdx, 5),
        status: 'SOLD',
        winnerId: winner.userId,
        lastSeq: seq,
        remainingMs: 0,
        events: [...s.events, { type: 'AUCTION_SOLD', seq, by: winner, amountCents: s.currentCents }],
      };
    }

    case 'EVIDENCE':
      return { ...s, stepIdx: 6, showEvidence: true };

    case 'RESET':
      return initialShowcase();

    default:
      return s;
  }
}

// Synthesize an evidence payload from the scripted event log so the evidence
// card's prices/seqs/extends MATCH what the judges just watched. Hashes are
// deterministic pseudo-hex derived from seq — this stage is labeled 脚本数据;
// the real chain (HMAC, Replay Verifier) lives at /evidence/:id.
export function buildScriptEvidence(s) {
  let prev = '0000000000000000';
  const timeline = s.events.map((e) => {
    const hash = pseudoHash(e.seq);
    const payload = JSON.stringify({
      amountCents: e.amountCents,
      displayName: e.by?.displayName,
      extendCount: e.extendCount,
      serverTimeMs: 1_780_000_000_000 + e.seq * 1_000,
    });
    const row = { seq: e.seq, eventType: e.type, payload, prevHash: prev, eventHash: hash };
    prev = hash;
    return row;
  });
  return {
    auctionId: 'showcase-脚本数据',
    chainVerified: true,
    eventsHash: `0x${prev}${pseudoHash(s.lastSeq + 7)}`,
    currentPriceCents: s.currentCents,
    timeline,
  };
}

function pseudoHash(seq) {
  // 16 hex chars, deterministic, obviously synthetic (导演模式).
  let x = (seq * 2654435761) >>> 0;
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += x.toString(16).padStart(8, '').slice(0, 4);
    x = ((x ^ (x << 13)) * 1103515245 + 12345) >>> 0;
  }
  return out.slice(0, 16).padEnd(16, '0');
}

// Map the shared script state into ONE viewer's MobileRoom props.
export function viewerProps(s, who) {
  const me = who === 'A' ? VIEWER_A : VIEWER_B;
  const other = who === 'A' ? VIEWER_B : VIEWER_A;
  const meLeading = s.leaderId === me.userId;
  const flags = s.flags[who] || {};
  const leaders = [
    { ...(meLeading ? me : other), cents: s.currentCents, isYou: meLeading },
    { ...(meLeading ? other : me),
      cents: (() => { try { return (BigInt(s.currentCents) - BigInt(s.stepCents)).toString(); } catch { return s.currentCents; } })(),
      isYou: !meLeading },
  ];
  return {
    ...ITEM,
    followScopeId: `showcase-${who}`,
    status: s.status,
    currentCents: s.currentCents,
    stepCents: s.stepCents,
    remainingMs: s.remainingMs,
    extendCount: s.extendCount,
    extendFlash: s.extendFlash,
    lastSeq: s.lastSeq,
    viewerCount: 1024,
    bidsPerSec: s.bidsPerSec,
    serverClockOffsetMs: who === 'A' ? 8 : -5,
    leaders,
    isYouLeading: meLeading,
    showLeadingToast: !!flags.leadingToast,
    overtakeBanner: !!flags.overtakeBanner,
    yourRank: meLeading ? 1 : 2,
    yourGapCents: meLeading ? '0' : s.stepCents,
    yourCents: meLeading
      ? s.currentCents
      : (() => { try { return (BigInt(s.currentCents) - BigInt(s.stepCents)).toString(); } catch { return '0'; } })(),
    winnerName: s.winnerId === me.userId ? me.displayName : other.displayName,
    isYouWinner: s.winnerId === me.userId,
    showColorRamp: s.remainingMs <= 10_000 && s.status === 'LIVE',
    showHourglass: s.remainingMs <= 10_000 && s.status === 'LIVE',
    ticker: s.events
      .filter((e) => e.type === 'BID_ACCEPTED')
      .slice(-4)
      .map((e) => ({ id: e.seq, kind: 'bid', name: e.by.displayName, cents: e.amountCents })),
    aiStatus: 'live',
    aiTrigger: s.status === 'SOLD' ? 'hammer' : s.remainingMs <= 10_000 ? 'surge' : 'open',
    aiText: s.status === 'SOLD'
      ? `落槌 · ${s.winnerId === VIEWER_A.userId ? VIEWER_A.displayName : VIEWER_B.displayName} 以最终价竞得本场。`
      : s.remainingMs <= 10_000
        ? '最后 10 秒 · 任何有效出价都会自动延时 30 秒，无需抢秒。'
        : '双买家对决进行中 · 出价由服务端按序裁决。',
    expressive: true,
  };
}

// ─── the stage ──────────────────────────────────────────────────
export function JudgesShowcaseRoute() {
  const [s, dispatch] = React.useReducer(showcaseReducer, undefined, initialShowcase);

  // Pre-accept the 拍卖须知 for both stage phones — the join gate is part of
  // the /room/:id flow demo, not of this scripted stage. A lazy useState
  // initializer runs synchronously BEFORE the phones mount (an effect would
  // be too late: MobileRoom reads the flag in its own useState initializer).
  React.useState(() => {
    try {
      window.localStorage.setItem('lumen:joined:showcase-A', '1');
      window.localStorage.setItem('lumen:joined:showcase-B', '1');
    } catch { /* private mode — MobileRoom falls back to its gate */ }
    return true;
  });

  // countdown tick
  React.useEffect(() => {
    const id = setInterval(() => dispatch({ type: 'TICK', ms: 250 }), 250);
    return () => clearInterval(id);
  }, []);

  // one-shot flags auto-clear (same cadence as the real store)
  React.useEffect(() => {
    if (!s.flags.A.leadingToast && !s.flags.B.leadingToast
      && !s.flags.A.overtakeBanner && !s.flags.B.overtakeBanner && !s.extendFlash) return undefined;
    const id = setTimeout(() => dispatch({ type: 'CLEAR_FLASH' }), 2_600);
    return () => clearTimeout(id);
  }, [s.flags, s.extendFlash]);

  const evidence = s.showEvidence ? buildScriptEvidence(s) : null;

  return (
    <div style={ST.page}>
      {/* header */}
      <div style={ST.header}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
          <span className="serif" style={{ fontSize: 18, fontWeight: 700 }}>琉森拍卖行 · 评委演示舞台</span>
          <span style={ST.scriptTag}>导演模式 · 脚本数据 · 非实时连接</span>
        </div>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <span className="mono" style={{ fontSize: 11, color: 'var(--douyin-ink-muted)' }}>
            seq #{s.lastSeq} · 延时×{s.extendCount} · {s.bidsPerSec.toFixed(1)} bids/s
          </span>
          <Link to="/" style={{ fontSize: 12, color: 'var(--douyin-cyan)' }}>真实大厅 →</Link>
        </div>
      </div>

      {/* stage */}
      <div style={ST.stage} className="no-scrollbar">
        <PhoneShell label={`买家 A · ${VIEWER_A.displayName}`}>
          <MobileRoom {...viewerProps(s, 'A')}
            onBid={(c) => dispatch({ type: 'BID_FROM', who: 'A', amountCents: c })}
            onViewEvidence={() => dispatch({ type: 'EVIDENCE' })}/>
        </PhoneShell>
        <PhoneShell label={`买家 B · ${VIEWER_B.displayName}`}>
          <MobileRoom {...viewerProps(s, 'B')}
            onBid={(c) => dispatch({ type: 'BID_FROM', who: 'B', amountCents: c })}
            onViewEvidence={() => dispatch({ type: 'EVIDENCE' })}/>
        </PhoneShell>

        {/* right rail: evidence + narration */}
        <div style={ST.rail} className="no-scrollbar">
          {evidence ? (
            <div style={ST.evidenceWrap}>
              <MobileEvidence evidence={evidence}/>
            </div>
          ) : (
            <div style={ST.railCard}>
              <div style={ST.railTitle}>讲解线索</div>
              {[
                ['实时情绪', '真实房间的领先/被超越/末 10 秒来自服务端事件；导演模式用同构脚本事件复现这套语法。'],
                ['工程可信', '脚本事件也带 seq 与服务端时间形态；真实房间里这些字段由 WebSocket 与 Stream 驱动。'],
                ['成交可信', '落槌从抖音红黑切到拍卖行金色，证据卡用哈希链收束整场。'],
              ].map(([t, d]) => (
                <div key={t} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--solemn-gold)' }}>{t}</div>
                  <div style={{ fontSize: 11, color: 'var(--douyin-ink-muted)', lineHeight: 1.6 }}>{d}</div>
                </div>
              ))}
              <div style={{ marginTop: 'auto', fontSize: 10, color: 'var(--douyin-ink-dim)', lineHeight: 1.6 }}>
                按底部 1→6 顺序走完 90 秒评委路径；手机里的加价键同样可用，出价会进入同一脚本状态。
              </div>
            </div>
          )}
        </div>
      </div>

      {/* director bar */}
      <div style={ST.bar}>
        {SHOWCASE_STEPS.map((st, i) => {
          const done = i < s.stepIdx;
          const next = i === s.stepIdx;
          return (
            <button key={st.key}
              onClick={() => dispatch({ type: st.key })}
              style={{
                ...ST.stepBtn,
                ...(done ? ST.stepBtnDone : next ? ST.stepBtnNext : {}),
              }}>
              <span className="mono" style={{ fontSize: 10, opacity: .75 }}>{i + 1}</span>
              <span style={{ fontSize: 13, fontWeight: 800 }}>{st.label}</span>
              <span style={{ fontSize: 9, opacity: .7 }}>{st.hint}</span>
            </button>
          );
        })}
        <button onClick={() => dispatch({ type: 'RESET' })} style={ST.resetBtn}>重置</button>
      </div>
    </div>
  );
}

function PhoneShell({ label, children }) {
  return (
    <div style={ST.phoneCol}>
      <div style={ST.phoneLabel}>{label}</div>
      <div className="lumen-phone-frame" style={{ width: 330, height: 716, boxShadow: '0 22px 70px rgba(0,0,0,.38)' }}>
        {children}
      </div>
    </div>
  );
}

const ST = {
  page: {
    minHeight: '100vh',
    background: 'radial-gradient(circle at 12% 0%, rgba(254,44,85,.16), transparent 35%), linear-gradient(135deg,#090a10,#151827 55%,#0b0c12)',
    color: 'var(--douyin-ink-text)',
    fontFamily: 'var(--font-sans)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    height: 56,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 22px',
    borderBottom: '1px solid rgba(255,255,255,.08)',
    background: 'rgba(7,8,12,.72)',
    backdropFilter: 'blur(16px)',
  },
  scriptTag: {
    fontSize: 11,
    color: '#111827',
    background: 'linear-gradient(135deg,#FDE68A,#F59E0B)',
    padding: '4px 8px',
    borderRadius: 999,
    fontWeight: 800,
  },
  stage: {
    flex: 1,
    minHeight: 0,
    display: 'grid',
    gridTemplateColumns: '360px 360px minmax(260px,1fr)',
    gap: 16,
    padding: '16px 18px 12px',
    overflow: 'auto',
  },
  phoneCol: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 },
  phoneLabel: { fontSize: 12, color: 'var(--douyin-ink-muted)', letterSpacing: '.04em' },
  rail: { minHeight: 0, overflow: 'auto', display: 'flex' },
  railCard: {
    width: '100%',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    padding: 16,
    borderRadius: 20,
    background: 'rgba(255,255,255,.06)',
    border: '1px solid rgba(255,255,255,.1)',
  },
  railTitle: { fontSize: 15, fontWeight: 900, marginBottom: 14 },
  evidenceWrap: { width: 330, height: 716, overflow: 'hidden', margin: '0 auto' },
  bar: {
    minHeight: 78,
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    padding: '10px 18px 14px',
    borderTop: '1px solid rgba(255,255,255,.08)',
    background: 'rgba(7,8,12,.84)',
  },
  stepBtn: {
    minWidth: 122,
    height: 54,
    border: '1px solid rgba(255,255,255,.12)',
    background: 'rgba(255,255,255,.06)',
    color: 'var(--douyin-ink-text)',
    borderRadius: 14,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    justifyContent: 'center',
    padding: '0 12px',
    cursor: 'pointer',
  },
  stepBtnDone: { borderColor: 'rgba(245,158,11,.55)', background: 'rgba(245,158,11,.14)' },
  stepBtnNext: { borderColor: 'rgba(37,244,238,.65)', background: 'rgba(37,244,238,.12)' },
  resetBtn: {
    marginLeft: 'auto',
    height: 40,
    padding: '0 14px',
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,.14)',
    background: 'transparent',
    color: 'var(--douyin-ink-muted)',
    cursor: 'pointer',
  },
};
