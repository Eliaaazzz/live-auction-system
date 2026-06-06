import React from 'react';
import { formatCentsCNY, formatCentsCompact, addCentsStr } from './primitives.jsx';

// lumen-atmosphere.jsx
// Visceral feedback layers that sit on top of MobileRoom.
// Per §9: emoji is OK if paired with text + semantic.
// Particles are reserved for the hammer (§9.2), so we use rings + sweeps here.

// ─── LeadingToast — "🎉 领先!" gold pop ──────────────────────────
function LeadingToast({ visible, gainCents }) {
  if (!visible) return null;
  return (
    <div style={{
      position: 'absolute', top: '38%', left: '50%', zIndex: 60,
      pointerEvents: 'none',
    }}>
      {/* expanding ring */}
      <div className="lumen-lead-ring" style={{
        position: 'absolute', left: '50%', top: '50%',
        transform: 'translate(-50%,-50%)',
        width: 80, height: 80, borderRadius: 40,
        border: '2px solid var(--solemn-gold)',
        boxShadow: '0 0 24px rgba(201,169,97,.6)',
      }}/>
      <div className="lumen-lead-ring" style={{
        position: 'absolute', left: '50%', top: '50%',
        transform: 'translate(-50%,-50%)',
        width: 60, height: 60, borderRadius: 30,
        border: '1.5px solid var(--solemn-gold-soft)',
        animationDelay: '.2s',
      }}/>
      {/* pop label */}
      <div className="lumen-lead-pop" style={{
        position: 'absolute', left: '50%', top: '50%',
        transform: 'translate(-50%,0)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
      }}>
        <div style={{
          padding: '8px 18px', borderRadius: 999,
          background: 'linear-gradient(135deg, var(--solemn-gold), var(--solemn-gold-soft))',
          color: 'var(--solemn-ink)',
          fontFamily: 'var(--font-sans)', fontSize: 17, fontWeight: 700,
          letterSpacing: '.04em',
          boxShadow: '0 10px 30px rgba(201,169,97,.45)',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span>🎉</span><span>领先!</span>
        </div>
        {gainCents && (
          <span className="mono" style={{
            fontSize: 11, color: 'var(--solemn-gold)', fontWeight: 600,
            textShadow: '0 2px 8px rgba(0,0,0,.6)',
          }}>
            +{formatCentsCNY(gainCents).replace('¥','¥')}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── OvertakenSlam — "⚡ 被超越!" drops from top, screen shakes ──
function OvertakenSlam({ visible, byName, gapCents, onReverse }) {
  if (!visible) return null;
  return (
    <div className="lumen-slam-in" style={{
      position: 'absolute', top: 76, left: 12, right: 12, zIndex: 60,
      padding: '12px 14px', borderRadius: 12,
      background: 'linear-gradient(135deg, var(--douyin-red-deep) 0%, var(--douyin-red) 60%)',
      boxShadow: '0 12px 32px rgba(254,44,85,.5), inset 0 1px 0 rgba(255,255,255,.18)',
      display: 'flex', alignItems: 'center', gap: 12,
    }}>
      {/* lightning bolt */}
      <div style={{
        position: 'relative', width: 32, height: 32, flexShrink: 0,
      }}>
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
          <path d="M18 3L7 18h7l-3 11 11-16h-7l3-10z" fill="#fff" stroke="rgba(0,0,0,.15)" strokeWidth=".5"/>
        </svg>
        <svg className="lumen-bolt-flash" width="32" height="32" viewBox="0 0 32 32" fill="none"
          style={{ position: 'absolute', inset: 0 }}>
          <path d="M18 3L7 18h7l-3 11 11-16h-7l3-10z" fill="#fff"/>
        </svg>
      </div>
      <div style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-sans)' }}>
        <div style={{
          fontSize: 14, fontWeight: 700, color: '#fff',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span>⚡</span><span>被超越!</span>
        </div>
        <div className="mono" style={{ fontSize: 11, color: 'rgba(255,255,255,.85)', marginTop: 2 }}>
          {byName} 反超 · 差 {formatCentsCNY(gapCents)}
        </div>
      </div>
      <button onClick={onReverse} style={{
        padding: '7px 12px', borderRadius: 8, border: 'none',
        background: 'rgba(255,255,255,.95)', color: 'var(--douyin-red-deep)',
        fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 700,
        cursor: 'pointer', whiteSpace: 'nowrap',
        boxShadow: '0 4px 10px rgba(0,0,0,.18)',
      }}>反超 →</button>
    </div>
  );
}

// ─── MyPositionGap — sticky 'your rank · gap' chip ──────────────
function MyPositionGap({ rank, gapCents, isYou, isLeading }) {
  if (isLeading) {
    return (
      <div className="lumen-you-pulse" style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px', borderRadius: 8,
        background: 'rgba(201,169,97,.12)',
        border: '1px solid rgba(201,169,97,.45)',
      }}>
        <span style={{
          width: 18, height: 18, borderRadius: 9, background: 'var(--solemn-gold)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 10, fontWeight: 700, color: 'var(--solemn-ink)',
          fontFamily: 'var(--font-sans)',
        }}>★</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--solemn-gold)', fontFamily: 'var(--font-sans)' }}>
          你正领先 · 守住!
        </span>
      </div>
    );
  }
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 10px', borderRadius: 8,
      background: 'rgba(37,244,238,.08)',
      border: '1px solid rgba(37,244,238,.32)',
    }}>
      <span className="mono" style={{
        width: 18, height: 18, borderRadius: 9, background: 'rgba(37,244,238,.25)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 11, fontWeight: 700, color: 'var(--douyin-cyan)',
      }}>#{rank}</span>
      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--douyin-ink-text)', fontFamily: 'var(--font-sans)' }}>
        你 · 差
      </span>
      <span className="mono" style={{ fontSize: 13, fontWeight: 700, color: 'var(--douyin-cyan)' }}>
        {formatCentsCNY(gapCents)}
      </span>
      <span style={{ fontSize: 11, color: 'var(--douyin-ink-muted)', fontFamily: 'var(--font-sans)' }}>反超</span>
    </div>
  );
}

// ─── BidTickerStream — small pills sliding up on the left ───────
// Anchored INSIDE the video band (top ≈30%) and width-clamped so the danmaku
// floats over the stream and fades before it can cover the price card or the
// leaderboard below (meeting feedback: 弹幕遮挡内容). Names ellipsis so a long
// handle never spans the screen on a narrow device (动态像素适配).
function BidTickerStream({ items }) {
  // Show last 3, oldest at top (fading), newest at bottom
  const shown = items.slice(-3);
  return (
    <div style={{
      position: 'absolute', left: 12, top: '30%',
      zIndex: 9, display: 'flex', flexDirection: 'column', gap: 6,
      maxWidth: 'min(62%, 230px)', pointerEvents: 'none',
    }}>
      {shown.map((it) => (
        <div key={it.id} className="lumen-ticker-up" style={{
          display: 'flex', alignItems: 'center', gap: 6, maxWidth: '100%',
          padding: '4px 8px 4px 4px', borderRadius: 999,
          background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(8px)',
          border: '1px solid rgba(255,255,255,.08)',
        }}>
          <span style={{
            flexShrink: 0,
            width: 18, height: 18, borderRadius: 9,
            background: it.color || 'linear-gradient(135deg,#FE2C55,#cb203f)',
            color: '#fff', fontSize: 9, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--font-sans)',
          }}>{(it.name || '?')[0]}</span>
          <span style={{
            fontSize: 10, color: 'rgba(255,255,255,.85)', fontFamily: 'var(--font-sans)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
          }}>
            {it.name}
          </span>
          <span className="mono" style={{ flexShrink: 0, fontSize: 10, fontWeight: 600, color: 'var(--solemn-gold)' }}>
            {formatCentsCompact(it.cents)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── HeartbeatVignette — red glow on device edges in final-10s ─
function HeartbeatVignette({ active }) {
  if (!active) return null;
  return (
    <div className="lumen-heartbeat" style={{
      position: 'absolute', inset: 0, zIndex: 5, pointerEvents: 'none',
      boxShadow: 'inset 0 0 60px 12px rgba(254,44,85,.35), inset 0 0 18px 4px rgba(254,44,85,.5)',
    }}/>
  );
}

// ─── SpeakerToggle — breathing icon (sound is muted by default §12.7.2) ─
function SpeakerToggle({ muted = true, onToggle }) {
  return (
    <button onClick={onToggle} style={{
      width: 32, height: 32, borderRadius: 16, border: 'none',
      background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(8px)',
      color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
      cursor: 'pointer', position: 'relative',
    }}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="M2 5h2l3-2v8L4 9H2z" fill="currentColor"/>
        {muted ? (
          <>
            <line x1="9.5" y1="4" x2="13" y2="10" strokeLinecap="round"/>
            <line x1="13" y1="4" x2="9.5" y2="10" strokeLinecap="round"/>
          </>
        ) : (
          <>
            <path d="M9.5 4.5C10.5 5.5 10.5 8.5 9.5 9.5" strokeLinecap="round"/>
            <path d="M11 3C12.5 4.5 12.5 9.5 11 11" strokeLinecap="round"/>
          </>
        )}
      </svg>
      {muted && (
        <span className="lumen-speaker-breath" style={{
          position: 'absolute', inset: -2, borderRadius: 18,
          border: '1.5px solid var(--douyin-cyan)',
          pointerEvents: 'none',
        }}/>
      )}
    </button>
  );
}


// ─── SandHourglass — final-10s tension prop ─────────────────────
function SandHourglass({ remainingMs = 10000, totalMs = 10000 }) {
  const ratio = Math.max(0, Math.min(1, remainingMs / totalMs));
  const topH = 13 * ratio;
  const botH = 13 * (1 - ratio);
  return (
    <div className="lumen-glass-tilt" style={{
      position: 'relative', width: 22, height: 36, flexShrink: 0,
    }}>
      <svg viewBox="0 0 22 36" width="22" height="36" style={{ position: 'absolute', inset: 0 }}>
        <defs>
          <linearGradient id="hg-frame" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--solemn-gold)"/>
            <stop offset="100%" stopColor="var(--bridge-rose-gold)"/>
          </linearGradient>
        </defs>
        <rect x="2" y="0" width="18" height="2" rx="1" fill="url(#hg-frame)"/>
        <rect x="2" y="34" width="18" height="2" rx="1" fill="url(#hg-frame)"/>
        <path d="M3 2 L19 2 L19 4 L13 17 L19 32 L19 34 L3 34 L3 32 L9 17 L3 4 Z"
          fill="rgba(255,255,255,.04)" stroke="rgba(201,169,97,.4)" strokeWidth=".5"/>
        {topH > 0.4 && (
          <path d={`M${4 - topH * 0.1} 4 L${18 + topH * 0.1} 4 L${17 - topH * 0.5} ${4 + topH * 0.9} L${5 + topH * 0.5} ${4 + topH * 0.9} Z`}
            fill="var(--solemn-gold)" opacity=".95"/>
        )}
        {botH > 0.4 && (
          <path d={`M${5 + botH * 0.4} ${32 - botH} L${17 - botH * 0.4} ${32 - botH} L19 32 L3 32 Z`}
            fill="var(--solemn-gold)" opacity=".95"/>
        )}
      </svg>
      <div style={{
        position: 'absolute', left: '50%', top: 16, width: 1, height: 16,
        transform: 'translateX(-50%)', overflow: 'hidden',
      }}>
        {[0, 0.3, 0.6, 0.9].map((d, i) => (
          <div key={i} className="lumen-sand-fall" style={{
            position: 'absolute', width: 1, height: 5,
            background: 'linear-gradient(180deg, var(--solemn-gold-soft), var(--solemn-gold))',
            animationDelay: `${d}s`,
          }}/>
        ))}
      </div>
    </div>
  );
}

// ─── PulseWaves — concentric rings from the price card during final 10s ──
function PulseWaves({ active }) {
  if (!active) return null;
  return (
    <div style={{
      position: 'absolute', left: 0, right: 0, top: '46%', height: 220, zIndex: 1,
      pointerEvents: 'none',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {[0, 0.7, 1.4].map((d, i) => (
        <div key={i} className="lumen-pulse-wave" style={{
          position: 'absolute', width: 180, height: 180, borderRadius: 90,
          border: '1.5px solid rgba(254,44,85,.5)',
          animationDelay: `${d}s`,
        }}/>
      ))}
    </div>
  );
}

// ─── LongPressBidWheel — radial picker (F25) ──────────────────────
function LongPressBidWheel({ visible, currentCents, stepCents = '500000', onPick, onClose }) {
  if (!visible) return null;
  const tiers = [
    { mult: 1,  label: '+1', cents: stepCents,                                desc: '最低加价' },
    { mult: 2,  label: '+2', cents: (BigInt(stepCents) * 2n).toString(),      desc: '稳进' },
    { mult: 5,  label: '+5', cents: (BigInt(stepCents) * 5n).toString(),      desc: '强势' },
    { mult: 10, label: '+10', cents: (BigInt(stepCents) * 10n).toString(),    desc: '黑马', warn: true },
  ];
  return (
    <div onClick={onClose} style={{
      position: 'absolute', inset: 0, zIndex: 70,
      background: 'rgba(10,10,16,.7)', backdropFilter: 'blur(14px)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      paddingBottom: 110, fontFamily: 'var(--font-sans)',
    }}>
      <div className="lumen-wheel-in" onClick={(e) => e.stopPropagation()}
        style={{
          width: 290, padding: '20px 18px', borderRadius: 20,
          background: 'rgba(31,35,51,.95)',
          border: '1px solid rgba(201,169,97,.3)',
          boxShadow: '0 20px 60px rgba(0,0,0,.6), 0 0 0 4px rgba(201,169,97,.08)',
        }}>
        <div style={{
          textAlign: 'center', fontSize: 10, color: 'var(--douyin-ink-muted)',
          letterSpacing: '.1em', marginBottom: 4,
        }}>长按选择加价阶梯 · BID TIER</div>
        <div className="mono" style={{
          textAlign: 'center', fontSize: 12, color: 'var(--solemn-gold)', marginBottom: 14,
        }}>
          基线 {formatCentsCNY(currentCents)} · 阶梯 {formatCentsCNY(stepCents)}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {tiers.map(t => {
            const next = addCentsStr(currentCents, t.cents);
            return (
              <button key={t.mult} onClick={() => { onPick && onPick(next, t); onClose && onClose(); }}
                style={{
                  padding: '12px 10px', borderRadius: 12, border: 'none', cursor: 'pointer',
                  background: t.warn
                    ? 'linear-gradient(135deg, var(--state-extended), var(--bridge-rose-gold))'
                    : t.mult === 1
                      ? 'rgba(255,255,255,.06)'
                      : 'linear-gradient(135deg, var(--douyin-red), var(--douyin-red-soft))',
                  color: '#fff', fontFamily: 'inherit',
                  display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2,
                }}>
                <span className="mono" style={{ fontSize: 16, fontWeight: 700 }}>{t.label}×</span>
                <span style={{ fontSize: 10, opacity: .85 }}>{t.desc}</span>
                <span className="mono" style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>
                  → {formatCentsCNY(next)}
                </span>
              </button>
            );
          })}
        </div>
        <div style={{ textAlign: 'center', fontSize: 10, color: 'var(--douyin-ink-dim)', marginTop: 12 }}>
          松手 = 出价 · 上滑取消
        </div>
      </div>
    </div>
  );
}

// ─── BlackHorseBanner — F13 jump-bid marquee ──────────────────────
function BlackHorseBanner({ visible, name = '夜航星', jumpCents = '5000000', byMultiple = 10 }) {
  if (!visible) return null;
  return (
    <div className="lumen-black-horse-in" style={{
      position: 'absolute', top: 134, left: 0, right: 0, zIndex: 12,
      height: 28, overflow: 'hidden', pointerEvents: 'none',
      background: 'linear-gradient(90deg, rgba(255,176,32,.1), var(--state-extended) 25%, var(--bridge-rose-gold) 50%, var(--state-extended) 75%, rgba(255,176,32,.1))',
      borderTop: '1px solid var(--state-extended)',
      borderBottom: '1px solid var(--state-extended)',
      boxShadow: '0 0 18px rgba(255,176,32,.4)',
      display: 'flex', alignItems: 'center',
    }}>
      <div className="lumen-marquee" style={{
        display: 'flex', alignItems: 'center', gap: 18, whiteSpace: 'nowrap',
        color: '#0a0a14', fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 700,
        letterSpacing: '.04em',
      }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13 }}>⚡</span>
            <span>黑马出价</span>
            <span>· {name}</span>
            <span className="mono">+{formatCentsCNY(jumpCents)} · {byMultiple}× 阶梯</span>
            <span>·</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── ComboFlame — leaderboard streak indicator ────────────────────
function ComboFlame({ count }) {
  if (count < 2) return null;
  return (
    <span className="lumen-flame-flicker" style={{
      display: 'inline-flex', alignItems: 'center', gap: 2,
      padding: '1px 5px', borderRadius: 4,
      background: 'linear-gradient(135deg, var(--state-extended), var(--douyin-red))',
      color: '#fff', fontSize: 9, fontWeight: 700, fontFamily: 'var(--font-mono)',
    }}>
      🔥 ×{count}
    </span>
  );
}

// ─── HammerTransition — A→B crossfade with veil drop ──────────────
function HammerTransition({ active, amountCents = '12880000' }) {
  if (!active) return null;
  return (
    <div className="lumen-veil-bridge" style={{
      position: 'absolute', inset: 0, zIndex: 80, pointerEvents: 'none',
      overflow: 'hidden',
    }}>
      <div style={{
        position: 'absolute', inset: 0,
        background: 'radial-gradient(ellipse at center 38%, var(--bridge-plum-1) 0%, var(--solemn-deep) 60%)',
      }}/>
      <div className="lumen-veil-drop" style={{
        position: 'absolute', top: 0, left: -10, right: -10, height: '120%',
        background:
          'linear-gradient(180deg,' +
          ' rgba(201,169,97,.95) 0%,' +
          ' rgba(220,191,127,.85) 35%,' +
          ' rgba(201,169,97,.45) 70%,' +
          ' rgba(10,31,68,.05) 100%)',
        boxShadow: '0 12px 36px rgba(201,169,97,.45)',
        transformOrigin: 'top',
      }}/>
      <div className="lumen-shockwave" style={{
        position: 'absolute', top: '38%', left: '50%',
        transform: 'translate(-50%,-50%)',
        width: 140, height: 140, borderRadius: 70,
        border: '3px solid var(--solemn-gold)',
        animationDelay: '.55s',
      }}/>
      <div className="lumen-shockwave" style={{
        position: 'absolute', top: '38%', left: '50%',
        transform: 'translate(-50%,-50%)',
        width: 80, height: 80, borderRadius: 40,
        border: '2px solid var(--solemn-gold-soft)',
        animationDelay: '.7s',
      }}/>
      <div className="lumen-hammer-reveal-up" style={{
        position: 'absolute', top: '34%', left: 0, right: 0,
        textAlign: 'center', color: 'var(--solemn-gold)',
        fontFamily: 'var(--font-serif)',
      }}>
        <div style={{ fontSize: 11, letterSpacing: '.2em', color: 'var(--solemn-cream-dim)', marginBottom: 4 }}>
          HAMMER · 落槌
        </div>
        <div className="mono" style={{
          fontSize: 42, fontWeight: 700, letterSpacing: '-.025em',
          textShadow: '0 4px 30px rgba(201,169,97,.5)',
        }}>
          {formatCentsCNY(amountCents)}
        </div>
      </div>
    </div>
  );
}

// ─── ChampagneShockwave — concentric gold rings ───────────────────
function ChampagneShockwave({ visible }) {
  if (!visible) return null;
  return (
    <div style={{
      position: 'absolute', top: '38%', left: '50%',
      transform: 'translate(-50%,-50%)', zIndex: 30,
      pointerEvents: 'none',
    }}>
      {[0, .25, .5].map((d, i) => (
        <div key={i} className="lumen-shockwave" style={{
          position: 'absolute', left: '50%', top: '50%',
          transform: 'translate(-50%,-50%)',
          width: 100 + i * 30, height: 100 + i * 30,
          borderRadius: '50%', border: '2px solid var(--solemn-gold)',
          animationDelay: `${d}s`,
        }}/>
      ))}
    </div>
  );
}

export {
  LeadingToast,
  OvertakenSlam,
  MyPositionGap,
  BidTickerStream,
  HeartbeatVignette,
  SpeakerToggle,
  SandHourglass,
  PulseWaves,
  LongPressBidWheel,
  BlackHorseBanner,
  ComboFlame,
  HammerTransition,
  ChampagneShockwave
};
