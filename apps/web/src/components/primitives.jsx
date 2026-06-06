import React from 'react';
import { bidRejectCopy } from '../lib/types.js';

// lumen-primitives.jsx
// §7.1 components. Money is string-cents, time is server-corrected.

// ─── formatCentsCNY — never parse to Number (§4 P1) ───
function formatCentsCNY(cents) {
  const s = String(cents);
  const neg = s.startsWith('-');
  // Cents are integer-only; strip non-digits so a malformed value
  // (undefined / null / '' / partial payload) degrades to ¥0.00 instead
  // of rendering garbage like "¥undefin.ed".
  const abs = (neg ? s.slice(1) : s).replace(/[^0-9]/g, '') || '0';
  const padded = abs.padStart(3, '0');
  const yuan = padded.slice(0, -2);
  const fen = padded.slice(-2);
  const grouped = yuan.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + '¥' + grouped + '.' + fen;
}

function formatCentsCNYCompact(cents) {
  try {
    const n = BigInt(cents);
    const neg = n < 0n;
    const abs = neg ? -n : n;
    const units = [
      { centsPerUnit: 1_000_000_000_000_00n, label: '万亿' },
      { centsPerUnit: 100_000_000_00n, label: '亿' },
      { centsPerUnit: 10_000_00n, label: '万' },
    ];
    const unit = units.find((u) => abs >= u.centsPerUnit);
    if (!unit) return formatCentsCNY(cents);
    const scaledHundred = abs * 100n / unit.centsPerUnit;
    const whole = scaledHundred / 100n;
    const frac = String(scaledHundred % 100n).padStart(2, '0').replace(/0+$/, '');
    return `${neg ? '-' : ''}¥${whole}${frac ? `.${frac}` : ''}${unit.label}`;
  } catch {
    return formatCentsCNY(cents);
  }
}

// Add string cents — for "tap to add ¥X reverse" math
function addCentsStr(a, b) {
  const an = BigInt(a), bn = BigInt(b);
  return (an + bn).toString();
}

// Canonical CN copy for `BidErrorCode` is defined in lib/types.js and
// mirrored to the UI through this re-exported identifier.

// ─── PriceDisplay — F09 odometer flip ───
function PriceDisplay({ cents, size = 56, tone = 'ink', flash = false, withUnderline = false }) {
  const txt = formatCentsCNY(cents);
  const color = tone === 'gold' ? 'var(--solemn-gold)'
              : tone === 'cream' ? 'var(--solemn-cream)'
              : tone === 'red'  ? 'var(--douyin-red)'
              : 'var(--douyin-ink-text)';
  // Per-char swap for odometer-feel without React 60fps
  const prev = React.useRef(txt);
  const changed = prev.current !== txt;
  React.useEffect(() => { prev.current = txt; }, [txt]);
  return (
    <span className={'mono' + (flash ? ' lumen-gold-flash' : '')}
      style={{
        position: 'relative',
        fontSize: size, fontWeight: 700, color, lineHeight: 1, letterSpacing: 0,
        display: 'inline-flex', alignItems: 'baseline',
        maxWidth: '100%', flexWrap: 'wrap',
        transition: 'color .18s ease', willChange: 'transform',
        paddingBottom: withUnderline ? 4 : 0,
        borderBottom: withUnderline ? '1px solid var(--x-gold-thin)' : 'none',
      }}>
      {[...txt].map((ch, i) => (
        <span key={i + ch} style={{
          display: 'inline-block', minWidth: ch === '.' || ch === ',' ? undefined : '0.62em',
          textAlign: 'center',
          animation: changed && /[0-9]/.test(ch) ? 'lumen-pulse-warn .2s' : undefined,
        }}>{ch}</span>
      ))}
    </span>
  );
}

// ─── Countdown — server-clock corrected (§4 P4) ───
function fmtRemaining(ms) {
  if (ms <= 0) return '00:00';
  const totalS = Math.ceil(ms / 1000);
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function Countdown({ remainingMs, warningMs = 10000, tone = 'live', size = 'lg' }) {
  const warn = remainingMs > 0 && remainingMs <= warningMs;
  const fontSize = size === 'lg' ? 44 : size === 'md' ? 28 : 20;
  const color = warn ? 'var(--state-live)'
             : tone === 'extended' ? 'var(--state-extended)'
             : tone === 'gold' ? 'var(--solemn-gold)'
             : 'var(--douyin-ink-text)';
  return (
    <span className={'mono' + (warn ? ' lumen-pulse-warn' : '')}
      style={{ fontSize, fontWeight: 600, color, lineHeight: 1, letterSpacing: 0 }}>
      {fmtRemaining(remainingMs)}
    </span>
  );
}

// ─── StatusBadge — 7 canonical states (§4 P2) ───
const STATUS_MAP = {
  DRAFT:        { label: '草稿', bg: 'rgba(154,160,180,.18)', fg: '#9aa0b4' },
  SCHEDULED:    { label: '即将开拍', bg: 'rgba(37,244,238,.14)', fg: 'var(--douyin-cyan)' },
  LIVE:         { label: '直播中', bg: 'var(--douyin-red)', fg: '#fff', dot: true },
  SOLD:         { label: '已成交', bg: 'rgba(201,169,97,.18)', fg: 'var(--solemn-gold)' },
  NO_BID:       { label: '本场无人出价', bg: 'rgba(107,114,128,.18)', fg: '#9ca3af' },
  CANCELLED:    { label: '已取消', bg: 'rgba(154,160,180,.18)', fg: '#9aa0b4' },
  ORDER_CREATED:{ label: '订单已生成', bg: 'rgba(201,169,97,.22)', fg: 'var(--solemn-gold)' },
};
function StatusBadge({ status, size = 'md' }) {
  const m = STATUS_MAP[status] || STATUS_MAP.DRAFT;
  const pad = size === 'sm' ? '3px 8px' : '4px 10px';
  const fs = size === 'sm' ? 11 : 12;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: pad, borderRadius: 999, fontSize: fs, fontWeight: 600,
      background: m.bg, color: m.fg, letterSpacing: '.02em',
      fontFamily: 'var(--font-sans)',
    }}>
      {m.dot && <span className="lumen-live-dot" style={{
        width: 6, height: 6, borderRadius: 999, background: '#fff',
      }}/>}
      {m.label}
    </span>
  );
}

// ─── ExtendBadge — F02 anti-snipe trust signal (§4 P5) ───
function ExtendBadge({ count, perSec = 30, sweep = false }) {
  if (!count) return null;
  return (
    <span className={'mono' + (sweep ? ' lumen-sweep' : '')}
      style={{
        position: 'relative', overflow: 'hidden',
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '3px 8px', borderRadius: 6,
        background: 'rgba(255,176,32,.16)', color: 'var(--state-extended)',
        fontSize: 11, fontWeight: 600, letterSpacing: '.02em',
        border: '1px solid rgba(255,176,32,.35)',
      }}>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
        <path d="M5 1v4l2.5 1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        <circle cx="5" cy="5" r="3.8" stroke="currentColor" strokeWidth="1.2" fill="none"/>
      </svg>
      延时 ×{count} · +{perSec}s
    </span>
  );
}

// ─── TypewriterText — char-by-char render of a streaming LLM string (§5.8) ───
function TypewriterText({ text, charDelay = 28, cursor = true, onDone }) {
  const [n, setN] = React.useState(0);
  React.useEffect(() => {
    setN(0);
    if (!text) return;
    let i = 0;
    const id = setInterval(() => {
      i += 1; setN(i);
      if (i >= text.length) { clearInterval(id); onDone && onDone(); }
    }, charDelay);
    return () => clearInterval(id);
  }, [text, charDelay]);
  const shown = text ? text.slice(0, n) : '';
  const done = !text || n >= text.length;
  return (
    <span>{shown}{cursor && !done && (
      <span className="lumen-cursor-blink mono" style={{
        display: 'inline-block', width: 6, height: 13, marginLeft: 2,
        background: 'currentColor', verticalAlign: 'text-bottom',
      }}/>
    )}</span>
  );
}

// ─── AIBubble — P3 graceful degrade + 4-trigger color states (T7) ───
// Triggers per blueprint §5.8: open / surge / cold / hammer / offline
const AI_TRIGGER = {
  open:    { dot: 'var(--douyin-cyan)',    bg: 'rgba(37,244,238,.06)',  border: 'rgba(37,244,238,.22)',  label: '开场',    icon: '▶' },
  surge:   { dot: 'var(--state-extended)', bg: 'rgba(255,176,32,.07)',  border: 'rgba(255,176,32,.28)',  label: '黑马',    icon: '⚡' },
  // compat: support legacy jump payloads until all producers switch.
  jump:    { dot: 'var(--state-extended)', bg: 'rgba(255,176,32,.07)',  border: 'rgba(255,176,32,.28)',  label: '黑马',    icon: '⚡' },
  cold:    { dot: 'var(--douyin-ink-muted)', bg: 'rgba(154,160,180,.06)', border: 'rgba(154,160,180,.18)', label: '冷场',    icon: '··' },
  hammer:  { dot: 'var(--solemn-gold)',    bg: 'rgba(201,169,97,.08)',  border: 'rgba(201,169,97,.32)',  label: '落槌',    icon: '✦' },
  offline: { dot: '#6b7280',               bg: 'rgba(107,114,128,.08)', border: 'rgba(107,114,128,.18)', label: '离线', icon: '×' },
};

function AIBubble({ status = 'open', trigger = 'open', text, streaming = false }) {
  const offline = status === 'offline';
  const m = AI_TRIGGER[offline ? 'offline' : trigger];
  return (
    <div style={{
      display: 'flex', gap: 10, alignItems: 'flex-start',
      padding: '10px 12px',
      background: m.bg,
      border: '1px solid ' + m.border,
      borderRadius: 12,
      transition: 'background .35s ease, border-color .35s ease',
    }}>
      <div style={{
        flexShrink: 0, width: 28, height: 28, borderRadius: 14,
        background: offline ? '#2a2d3a'
          : trigger === 'hammer' ? 'linear-gradient(135deg, var(--solemn-gold), var(--solemn-gold-soft))'
          : trigger === 'surge'   ? 'linear-gradient(135deg, #FE2C55, #FFB020)'
          : trigger === 'jump'    ? 'linear-gradient(135deg, #FE2C55, #FFB020)'
          : trigger === 'cold'   ? 'linear-gradient(135deg, #2a2d3a, #475569)'
          : 'linear-gradient(135deg, #25F4EE, #FE2C55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        position: 'relative',
      }}>
        <span style={{
          fontSize: 14, fontWeight: 700,
          color: offline ? '#9aa0b4' : trigger === 'hammer' ? 'var(--solemn-ink)' : '#fff',
          fontFamily: 'var(--font-sans)',
        }}>
          {offline ? '×' : '智'}
        </span>
        {!offline && (
          <span className="lumen-live-dot" style={{
            position: 'absolute', bottom: -1, right: -1,
            width: 8, height: 8, borderRadius: 4, background: m.dot,
            boxShadow: '0 0 0 1.5px var(--douyin-ink)',
          }}/>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3,
        }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--douyin-ink-muted)', fontFamily: 'var(--font-sans)' }}>
            拍卖师
          </span>
          <span className="mono" style={{
            fontSize: 9, padding: '1px 5px', borderRadius: 3,
            background: m.dot + '26', color: m.dot, letterSpacing: '.04em',
            display: 'inline-flex', alignItems: 'center', gap: 3,
          }}>{m.icon} {m.label}</span>
        </div>
        <div style={{
          fontSize: 13, lineHeight: 1.45, color: offline ? 'var(--douyin-ink-muted)' : 'var(--douyin-ink-text)',
          fontFamily: 'var(--font-sans)',
        }}>
          {offline ? '拍卖师暂离 · 出价不受影响'
                   : streaming ? <TypewriterText text={text}/>
                   : text}
        </div>
      </div>
    </div>
  );
}

// ─── Leaderboard — F11/F12 ───
// mode='list' (default) — vertical rows, used by admin console + preview routes.
// mode='podium'         — top-3 centered with #1 raised, per @Eliaaazzz round-2
//                         review feedback on PR #49 (more visual tension than
//                         a depth list; deeper ranks are demoted to a single
//                         "你 #3 · 差 ¥X 反超" gap pill that already lives
//                         beside the leaderboard in MobileRoom).
function Leaderboard({ leaders, mode = 'list' }) {
  if (mode === 'podium') return <LeaderboardPodium leaders={leaders}/>;
  const halos = ['var(--x-rank-1-glow)', 'rgba(192,192,192,.55)', 'rgba(203,32,63,.5)'];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {leaders.map((u, i) => {
        const isLead = i === 0;
        const halo = halos[i];
        const displayName = u.displayName || u.userId || '匿名买家';
        return (
          <div key={u.userId || `${i}-${displayName}`} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '8px 10px', borderRadius: 10,
            background: isLead ? 'rgba(201,169,97,.10)' : 'rgba(255,255,255,.02)',
            border: '1px solid ' + (isLead ? 'rgba(201,169,97,.4)' : 'rgba(255,255,255,.05)'),
            transition: 'all .3s ease',
            position: 'relative',
          }}>
            {isLead && (
              <div className="lumen-spotlight" style={{
                position: 'absolute', top: -4, left: 0, right: 0, height: 14,
                background: 'radial-gradient(ellipse 80% 100% at center top, var(--x-rank-1-glow), transparent)',
                pointerEvents: 'none', borderTopLeftRadius: 10, borderTopRightRadius: 10,
              }}/>
            )}
            <span className="mono" style={{
              width: 18, textAlign: 'center', fontSize: 12, fontWeight: 700,
              color: i < 3 ? ['var(--solemn-gold)', '#c0c0c0', 'var(--bridge-rose-gold)'][i] : 'var(--douyin-ink-muted)',
            }}>
              {i + 1}
            </span>
            <div style={{
              width: 26, height: 26, borderRadius: 13,
              background: u.avatarBg || '#3b4252',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontSize: 11, fontWeight: 600,
              boxShadow: halo ? `0 0 0 1.5px ${halo}` : 'none',
              fontFamily: 'var(--font-sans)',
            }}>
              {displayName[0]}
            </div>
            <span style={{
              flex: 1, minWidth: 0, fontSize: 13,
              color: isLead ? 'var(--solemn-gold-soft)' : 'var(--douyin-ink-text)',
              fontWeight: isLead ? 600 : 400,
              fontFamily: 'var(--font-sans)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              display: 'flex', alignItems: 'center', gap: 5,
            }}>
              {displayName}
              {u.combo && u.combo >= 2 && <ComboFlame count={u.combo}/>}
              {u.isYou && (
                <span style={{
                  fontSize: 9, padding: '1px 5px',
                  background: 'rgba(37,244,238,.2)', color: 'var(--douyin-cyan)',
                  borderRadius: 3, fontWeight: 600,
                }}>我</span>
              )}
            </span>
            <span className="mono" style={{
              fontSize: 12, fontWeight: 600, color: isLead ? 'var(--solemn-gold)' : 'var(--douyin-ink-text)',
            }}>
              {formatCentsCNY(u.cents)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// Podium variant — top-3 only, #1 in the center and raised. Anti-slop
// rule: gold/silver/bronze only on the medals; the surface is the same
// Douyin-Native palette as the room so it doesn't fight the buyer view.
function LeaderboardPodium({ leaders }) {
  const top3 = leaders.slice(0, 3);
  // Visual order is [#2, #1, #3] so #1 sits in the middle.
  const visualOrder = [top3[1], top3[0], top3[2]].filter(Boolean);
  const visualRank = (u) => top3.findIndex((x) => x?.userId === u.userId) + 1;
  const heights = { 1: 96, 2: 76, 3: 66 };
  const medalColor = {
    1: 'var(--solemn-gold)',
    2: '#c0c0c0',
    3: 'var(--bridge-rose-gold)',
  };
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 10,
      padding: '14px 4px 8px', minHeight: 130,
    }}>
      {visualOrder.map((u) => {
        const r = visualRank(u);
        const isLead = r === 1;
        const displayName = u.displayName || u.userId || '匿名买家';
        return (
          <div key={u.userId || `${r}-${displayName}`} style={{
            flex: '0 0 84px',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
            position: 'relative',
          }}>
            {isLead && (
              <div className="lumen-champion-aura" aria-hidden style={{
                position: 'absolute', top: -10, left: '50%',
                transform: 'translateX(-50%)',
                width: 86, height: 46,
                background: 'radial-gradient(ellipse 70% 80% at center, rgba(220,191,127,.46), rgba(201,169,97,.18) 45%, transparent 72%)',
                pointerEvents: 'none',
              }}/>
            )}
            <div style={{
              width: 40, height: 40, borderRadius: 20,
              background: u.avatarBg || '#3b4252',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontSize: 14, fontWeight: 600,
              boxShadow: isLead
                ? '0 0 0 2px var(--solemn-gold), 0 0 22px rgba(220,191,127,.34)'
                : `0 0 0 2px ${medalColor[r]}`,
              fontFamily: 'var(--font-sans)',
              position: 'relative',
            }}>
              {isLead && <span className="lumen-champion-ring" aria-hidden/>}
              {displayName[0]}
            </div>
            <span style={{
              maxWidth: 84,
              fontSize: 11, fontWeight: isLead ? 600 : 400,
              color: isLead ? 'var(--solemn-gold-soft)' : 'var(--douyin-ink-text)',
              textAlign: 'center',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              display: 'flex', alignItems: 'center', gap: 3, justifyContent: 'center',
            }}>
              {displayName}
              {u.isYou && (
                <span style={{
                  fontSize: 8, padding: '1px 4px',
                  background: 'rgba(37,244,238,.2)', color: 'var(--douyin-cyan)',
                  borderRadius: 3, fontWeight: 600,
                }}>我</span>
              )}
            </span>
            <span className="mono" style={{
              fontSize: 12, fontWeight: 600,
              color: isLead ? 'var(--solemn-gold)' : 'var(--douyin-ink-text)',
            }}>
              {formatCentsCNY(u.cents)}
            </span>
            <div style={{
              marginTop: 2,
              width: 64, height: heights[r],
              borderTopLeftRadius: 6, borderTopRightRadius: 6,
              background: isLead
                ? 'linear-gradient(180deg, rgba(201,169,97,.28), rgba(201,169,97,.08))'
                : r === 2
                  ? 'linear-gradient(180deg, rgba(192,192,192,.22), rgba(192,192,192,.06))'
                  : 'linear-gradient(180deg, rgba(184,138,90,.22), rgba(184,138,90,.06))',
              border: `1px solid ${medalColor[r]}55`,
              display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
              paddingTop: 6,
            }}>
              <span className="mono" style={{ fontSize: 14, fontWeight: 700, color: medalColor[r] }}>
                #{r}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── BidButton — F08 ───
function BidButton({ currentCents, incrementCents, onBid, disabled, shake, isLeading }) {
  const next = addCentsStr(currentCents, incrementCents);
  return (
    <button
      onClick={onBid}
      disabled={disabled}
      className={shake ? 'lumen-shake' : ''}
      style={{
        position: 'relative',
        width: '100%', padding: '14px 18px', borderRadius: 14,
        background: disabled ? 'rgba(107,114,128,.3)'
                  : isLeading ? 'linear-gradient(135deg, var(--solemn-gold) 0%, var(--solemn-gold-soft) 100%)'
                  : 'linear-gradient(135deg, var(--douyin-red) 0%, var(--douyin-red-soft) 100%)',
        color: isLeading ? 'var(--solemn-ink)' : '#fff',
        border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: 'var(--font-sans)', fontWeight: 600,
        boxShadow: disabled ? 'none' : '0 4px 14px rgba(254,44,85,.35), inset 0 1px 0 rgba(255,255,255,.2)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        transition: 'transform .12s, box-shadow .15s',
      }}
      onPointerDown={(e) => e.currentTarget.style.transform = 'scale(.97)'}
      onPointerUp={(e) => e.currentTarget.style.transform = ''}
      onPointerLeave={(e) => e.currentTarget.style.transform = ''}
    >
      <span style={{ fontSize: 14, opacity: .85 }}>
        {isLeading ? '当前领先 · 再加价' : '出价'}
      </span>
      <span className="mono" style={{ fontSize: 17, fontWeight: 700 }}>
        {formatCentsCNY(next)}
      </span>
    </button>
  );
}

// ─── ConnectionBar — P7 ───
function ConnectionBar({ status, gap }) {
  if (status === 'ok') return null;
  const msg = status === 'reconnecting' ? '连接中断 · 正在重连'
            : status === 'syncing' ? `正在同步 #${gap?.from}→#${gap?.to}`
            : status === 'schema'  ? '协议版本不匹配 · 请刷新'
            : '';
  const bg = status === 'schema' ? 'var(--state-rejected)' : 'var(--douyin-cyan)';
  return (
    <div style={{
      position: 'absolute', top: 0, left: 0, right: 0, zIndex: 30,
      height: 22, background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      gap: 8, color: bg, fontSize: 11, fontFamily: 'var(--font-sans)', fontWeight: 500,
      overflow: 'hidden',
    }}>
      <div className="lumen-shimmer" style={{
        position: 'absolute', inset: 0, height: 2, top: 'auto', bottom: 0,
      }}/>
      <svg width="10" height="10" viewBox="0 0 10 10">
        <circle cx="5" cy="5" r="3" stroke={bg} strokeWidth="1" fill="none"/>
        <circle cx="5" cy="5" r="1.2" fill={bg}/>
      </svg>
      {msg}
    </div>
  );
}

// ─── ClockDriftIndicator — F05 ───
function ClockDriftIndicator({ offsetMs }) {
  const abs = Math.abs(offsetMs);
  const warn = abs > 500;
  return (
    <div className="mono" style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      fontSize: 10, color: warn ? 'var(--state-extended)' : 'var(--douyin-ink-muted)',
    }}>
      Δ {offsetMs >= 0 ? '+' : ''}{offsetMs}ms
    </div>
  );
}

// ─── HashCell — §4 P6, F31 ───
function HashCell({ value, prefix = 8, label }) {
  const [open, setOpen] = React.useState(false);
  const shown = open ? value : value.slice(0, prefix);
  return (
    <button onClick={() => setOpen(o => !o)}
      className="mono"
      style={{
        background: 'transparent', border: 'none', cursor: 'pointer',
        color: 'var(--solemn-gold)', fontSize: 11, padding: 0, lineHeight: 1.4,
        textAlign: 'left', wordBreak: 'break-all',
      }}>
      {label && <span style={{ color: 'var(--solemn-cream-dim)', marginRight: 6 }}>{label}</span>}
      {shown}{!open && '…'}
    </button>
  );
}

// ─── QuickBidChips v2 — bid panel ───
// Step-multiple chips ("档") replacing the v1 percent chips, per cross-platform
// research (Whatnot / eBay / Sotheby's / 淘宝直播):
//
//   - Big primary label = resulting bid amount (¥133,800) — what the user
//     actually pays. v1's "+5% / ¥14K" buried the absolute number; reversing
//     the visual hierarchy matches every major live-auction app.
//   - Small secondary label = delta tag ("+1档") — auction-house dialect,
//     unambiguously maps to backend stepCents (place_bid.lua minIncrement).
//
// Custom drawer expands the v1 typed-input pattern with ± step nudge buttons
// (-3档 / -1档 / input / +1档 / +3档). Whatnot's Custom drawer has plus/minus
// controls around the value; we adopt the same pattern. Validation now
// catches step-boundary mismatches client-side (was unaddressed in v1).
//
// All chips emit `onBid(cents: string)` — same wire contract.
function QuickBidChips({
  currentCents,
  stepCents = '500000',
  capCents = null,
  disabled = false,
  shake = false,
  isLeading = false,
  onBid = () => {},
}) {
  const [showDrawer, setShowDrawer] = React.useState(false);
  const [custom, setCustom] = React.useState('');

  // Defense-in-depth: stepCents=='0' would still bypass the early disabling
  // path if the store ever regresses, so guard inside the component too.
  let stepBig = 0n;
  try { stepBig = BigInt(stepCents); } catch { stepBig = 0n; }
  const stepUsable = stepBig > 0n;

  // stepBump(N) = currentCents + N · stepCents. v2: no percentage rounding,
  // no ceil-div, no IEEE drift — straight BigInt addition.
  const stepBump = (multiplier) => {
    if (!stepUsable) return currentCents;
    try {
      return (BigInt(currentCents) + BigInt(multiplier) * stepBig).toString();
    } catch { return currentCents; }
  };
  const maxBid = () => {
    try {
      if (capCents) return capCents;
      // No cap → fall back to +10档 (matches the rightmost step chip).
      return stepBump(10);
    } catch { return currentCents; }
  };

  const chips = [
    { label: '+1档',  cents: stepBump(1) },
    { label: '+3档',  cents: stepBump(3) },
    { label: '+10档', cents: stepBump(10) },
    { label: '封顶',  cents: maxBid(), tone: 'gold' },
  ];

  const chipBase = {
    flex: '1 1 74px', minWidth: 0, minHeight: 54, padding: '9px 4px', borderRadius: 10, border: 'none',
    fontFamily: 'inherit', fontWeight: 600, fontSize: 12,
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'transform .12s',
  };
  const chipPress = (e) => { if (!disabled) e.currentTarget.style.transform = 'scale(.96)'; };
  const chipRelease = (e) => { e.currentTarget.style.transform = ''; };

  // ws-envelope.md §Money: MaxMoneyCents = 2^53-1 (server's hard ceiling).
  // Above this the value can't survive Lua/JS/Redis ZSET float64 — the
  // backend rejects with ERR_BAD_INPUT. Validate client-side so the user
  // sees the limit before submit instead of a rejection toast.
  const MAX_MONEY_CENTS = 9007199254740991n;
  let customBig = null;
  let customError = null;
  if (custom) {
    try {
      customBig = BigInt(custom);
      if (customBig > MAX_MONEY_CENTS) customError = 'max';
      else if (customBig <= BigInt(currentCents)) customError = 'low';
      // v2: step-boundary check. place_bid.lua requires the bid to land on
      // a stepCents multiple above currentCents; chips already snap, custom
      // input does not, so an off-grid bid would round-trip to ERR_BAD_INPUT.
      else if (stepUsable && (customBig - BigInt(currentCents)) % stepBig !== 0n) {
        customError = 'step';
      }
    } catch { customError = 'parse'; }
  }
  const customSubmittable = !disabled && custom && customError == null;

  // ± step buttons in the custom drawer: bump the typed value (or currentCents
  // if the input is empty/invalid) by N · stepCents. Clamped to [currentCents +
  // stepCents, MAX_MONEY_CENTS]. The −3档 / −1档 buttons let users walk back
  // from an overshoot; the chip path is for snap-up impulse, the drawer is
  // for precision.
  const stepNudge = (multiplier) => {
    if (!stepUsable || disabled) return;
    try {
      const c = BigInt(currentCents);
      const s = stepBig;
      const base = (customBig != null && customError !== 'parse') ? customBig : c + s;
      let next = base + BigInt(multiplier) * s;
      const min = c + s;
      if (next < min) next = min;
      if (next > MAX_MONEY_CENTS) next = MAX_MONEY_CENTS;
      setCustom(next.toString());
    } catch {}
  };

  return (
    <div className={shake ? 'lumen-shake' : ''}>
      {!stepUsable && (
        <div style={{
          marginBottom: 6, padding: '6px 10px', borderRadius: 6,
          background: 'rgba(255,176,32,.08)', border: '1px solid rgba(255,176,32,.3)',
          fontSize: 11, color: 'var(--state-extended)',
        }}>
          加价阶梯未配置 · 出价请使用自定义金额
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, opacity: stepUsable ? 1 : 0.3, pointerEvents: stepUsable ? 'auto' : 'none' }}>
        {chips.map((c, i) => {
          const isGold = c.tone === 'gold' || isLeading;
          return (
            <button key={i}
              disabled={disabled}
              className="lumen-bid-chip"
              onClick={() => onBid(c.cents)}
              onPointerDown={chipPress}
              onPointerUp={chipRelease}
              onPointerLeave={chipRelease}
              style={{
                ...chipBase,
                background: disabled ? 'rgba(107,114,128,.25)'
                  : isGold
                    ? 'linear-gradient(135deg, var(--solemn-gold), var(--solemn-gold-soft))'
                    : 'linear-gradient(135deg, var(--douyin-red), var(--douyin-red-soft))',
                color: isGold ? 'var(--solemn-ink)' : '#fff',
                boxShadow: disabled ? 'none'
                  : isGold
                    ? '0 4px 14px rgba(201,169,97,.28)'
                    : '0 4px 14px rgba(254,44,85,.28)',
              }}>
              <span className="mono" title={formatCentsCNY(c.cents)} style={{
                fontSize: 14, fontWeight: 700, letterSpacing: '-.01em',
                fontVariantNumeric: 'tabular-nums',
                maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {formatCentsCNYCompact(c.cents)}
              </span>
              <span style={{
                fontSize: 10, fontWeight: 500, opacity: .85, letterSpacing: '.04em',
              }}>
                {c.label}
              </span>
            </button>
          );
        })}
      </div>
      <button
        onClick={() => setShowDrawer((s) => !s)}
        disabled={disabled}
        style={{
          marginTop: 6, width: '100%', minHeight: 44, padding: '8px 10px', borderRadius: 8,
          background: 'transparent', border: '1px dashed rgba(255,255,255,.18)',
          color: 'var(--douyin-ink-muted)', fontSize: 11, fontFamily: 'inherit',
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}>
        {showDrawer ? '收起' : '自定义金额'}
      </button>
      {showDrawer && (
        <div style={{
          marginTop: 6, padding: '10px 12px', borderRadius: 10,
          background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          {/* Row 1 — typed input + Submit button (Whatnot Custom pattern). */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              // Cap raw input at 17 chars (≈ MAX_MONEY_CENTS digit count + 1)
              // so paste of "999..." (60 digits) never reaches state.
              maxLength={17}
              placeholder="输入金额（分）"
              value={custom}
              onChange={(e) => setCustom(e.target.value.replace(/[^0-9]/g, '').slice(0, 17))}
              style={{
                flex: 1, padding: '8px 10px', borderRadius: 6,
                background: 'rgba(0,0,0,.3)',
                border: `1px solid ${customError ? 'rgba(254,44,85,.4)' : 'rgba(255,255,255,.1)'}`,
                color: 'var(--douyin-ink-text)', fontFamily: 'var(--font-mono)', fontSize: 13,
                outline: 'none',
              }}
            />
            <button
              disabled={!customSubmittable}
              onClick={() => {
                if (!customSubmittable || customBig == null) return;
                onBid(customBig.toString());
                setCustom('');
                setShowDrawer(false);
              }}
              style={{
                minHeight: 44, padding: '8px 14px', borderRadius: 6, border: 'none',
                background: 'var(--douyin-red)', color: '#fff',
                fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
                cursor: customSubmittable ? 'pointer' : 'not-allowed',
                opacity: customSubmittable ? 1 : 0.5,
              }}>
              提交
            </button>
          </div>

          {/* Row 2 — ± step nudge buttons (v2 addition, per Whatnot Custom +/-
              and eBay mobile spinner pattern). Each click bumps the typed
              value by N · stepCents, clamped to valid range. */}
          {stepUsable && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'center' }}>
              {[
                { label: '−3档', mult: -3 },
                { label: '−1档', mult: -1 },
                { label: '+1档', mult:  1 },
                { label: '+3档', mult:  3 },
              ].map((b) => (
                <button key={b.mult}
                  disabled={disabled}
                  onClick={() => stepNudge(b.mult)}
                  style={{
                    flex: 1, minHeight: 44, padding: '6px 4px', borderRadius: 6,
                    background: 'rgba(255,255,255,.06)',
                    border: '1px solid rgba(255,255,255,.10)',
                    color: 'var(--douyin-ink-text)',
                    fontFamily: 'inherit', fontSize: 11, fontWeight: 600,
                    cursor: disabled ? 'not-allowed' : 'pointer',
                  }}>
                  {b.label}
                </button>
              ))}
            </div>
          )}

          {customError && (
            <div style={{
              fontSize: 10, color: 'var(--state-rejected)',
              fontFamily: 'var(--font-sans)',
            }}>
              {customError === 'max'   && '金额超过单笔上限'}
              {customError === 'low'   && `必须高于当前价 ${formatCentsCNY(currentCents)}`}
              {customError === 'step'  && `差额必须是 ${formatCentsCNY(stepCents)} 倍数 · 点 ± 档位按钮自动对齐`}
              {customError === 'parse' && '请输入纯数字金额（分）'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── HeatMeter — F-new · bids/sec from store.recentEvents ───
// Elia round-2 review point 3: surface "热度" so demo viewers feel the
// pace without us narrating it. Pure presentational — caller computes
// the rate (LiveRoomRoute does it from the Zustand recentEvents) and
// passes both an instantaneous value and a peak so the bar can scale.
function HeatMeter({ bidsPerSec = 0, peak = 1, label = '热度' }) {
  const ratio = peak > 0 ? Math.min(1, bidsPerSec / peak) : 0;
  // Color flips warm → hot as the bar fills
  const fill = ratio < 0.3 ? 'var(--douyin-cyan)'
             : ratio < 0.7 ? 'var(--state-extended)'
             : 'var(--state-live)';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '4px 8px', borderRadius: 999,
      background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)',
      minWidth: 0,
    }}>
      <span style={{ fontSize: 10, color: 'var(--douyin-ink-muted)', letterSpacing: '.06em', flexShrink: 0 }}>
        {label}
      </span>
      <div style={{
        flex: 1, height: 4, borderRadius: 2,
        background: 'rgba(255,255,255,.06)', overflow: 'hidden',
        minWidth: 36,
      }}>
        <div style={{
          width: `${Math.round(ratio * 100)}%`, height: '100%',
          background: fill,
          transition: 'width .3s ease, background-color .3s ease',
        }}/>
      </div>
      <span className="mono" style={{
        fontSize: 10, fontWeight: 600, color: fill, flexShrink: 0,
        fontVariantNumeric: 'tabular-nums', minWidth: 28, textAlign: 'right',
      }}>
        {bidsPerSec.toFixed(1)}/s
      </span>
    </div>
  );
}

export {
  formatCentsCNY,
  formatCentsCNYCompact,
  addCentsStr,
  fmtRemaining,
  bidRejectCopy,
  PriceDisplay,
  Countdown,
  StatusBadge,
  ExtendBadge,
  AIBubble,
  TypewriterText,
  Leaderboard,
  BidButton,
  QuickBidChips,
  HeatMeter,
  ConnectionBar,
  ClockDriftIndicator,
  HashCell
};
