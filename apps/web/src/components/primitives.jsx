import React from 'react';

// lumen-primitives.jsx
// §7.1 components. Money is string-cents, time is server-corrected.

// ─── formatCentsCNY — never parse to Number (§4 P1) ───
function formatCentsCNY(cents) {
  const s = String(cents);
  const neg = s.startsWith('-');
  const abs = neg ? s.slice(1) : s;
  const padded = abs.padStart(3, '0');
  const yuan = padded.slice(0, -2);
  const fen = padded.slice(-2);
  const grouped = yuan.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + '¥' + grouped + '.' + fen;
}

// Add string cents — for "tap to add ¥X reverse" math
function addCentsStr(a, b) {
  const an = BigInt(a), bn = BigInt(b);
  return (an + bn).toString();
}

// ─── bidRejectCopy — CN copy per backend error code (§4.3 wire) ───
// Source: proto/error-codes.md (mirrored from blueprint §4.3 + §5.2).
const bidRejectCopy = {
  ERR_TOO_LOW:        '出价低于最低加价',
  ERR_NOT_LIVE:       '本场不在 LIVE 状态，无法出价',
  ERR_AFTER_END:      '本场已结束，无法继续出价',
  ERR_AUCTION_PAUSED: '拍卖已暂停 · 请稍候',
  ERR_NOT_ALLOWED:    '当前账号不能出价此场',
  ERR_BAD_INPUT:      '出价参数有误',
  ERR_INTERNAL:       '服务器繁忙 · 请重试',
};

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
        fontSize: size, fontWeight: 700, color, lineHeight: 1, letterSpacing: '-0.025em',
        display: 'inline-flex', alignItems: 'baseline',
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
      style={{ fontSize, fontWeight: 600, color, lineHeight: 1, letterSpacing: '-0.02em' }}>
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
// Triggers per blueprint §5.8: open / jump / cold / hammer / offline
const AI_TRIGGER = {
  open:    { dot: 'var(--douyin-cyan)',    bg: 'rgba(37,244,238,.06)',  border: 'rgba(37,244,238,.22)',  label: '开场',    icon: '▶' },
  jump:    { dot: 'var(--state-extended)', bg: 'rgba(255,176,32,.07)',  border: 'rgba(255,176,32,.28)',  label: '黑马',    icon: '⚡' },
  cold:    { dot: 'var(--douyin-ink-muted)', bg: 'rgba(154,160,180,.06)', border: 'rgba(154,160,180,.18)', label: '冷场',    icon: '··' },
  hammer:  { dot: 'var(--solemn-gold)',    bg: 'rgba(201,169,97,.08)',  border: 'rgba(201,169,97,.32)',  label: '落槌',    icon: '✦' },
  offline: { dot: '#6b7280',               bg: 'rgba(107,114,128,.08)', border: 'rgba(107,114,128,.18)', label: 'OFFLINE', icon: '×' },
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
          : trigger === 'jump'   ? 'linear-gradient(135deg, #FE2C55, #FFB020)'
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
          {offline ? '×' : 'AI'}
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
function Leaderboard({ leaders }) {
  const halos = ['var(--x-rank-1-glow)', 'rgba(192,192,192,.55)', 'rgba(203,32,63,.5)'];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {leaders.map((u, i) => {
        const isLead = i === 0;
        const halo = halos[i];
        return (
          <div key={u.userId} style={{
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
              {u.displayName[0]}
            </div>
            <span style={{
              flex: 1, minWidth: 0, fontSize: 13,
              color: isLead ? 'var(--solemn-gold-soft)' : 'var(--douyin-ink-text)',
              fontWeight: isLead ? 600 : 400,
              fontFamily: 'var(--font-sans)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              display: 'flex', alignItems: 'center', gap: 5,
            }}>
              {u.displayName}
              {u.combo && u.combo >= 2 && <ComboFlame count={u.combo}/>}
              {u.isYou && (
                <span style={{
                  fontSize: 9, padding: '1px 5px',
                  background: 'rgba(37,244,238,.2)', color: 'var(--douyin-cyan)',
                  borderRadius: 3, fontWeight: 600,
                }}>YOU</span>
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

export {
  formatCentsCNY,
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
  ConnectionBar,
  ClockDriftIndicator,
  HashCell
};
