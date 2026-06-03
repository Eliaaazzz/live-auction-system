import React from 'react';
import { formatCentsCNY, addCentsStr, bidRejectCopy,
  PriceDisplay, Countdown, StatusBadge, ExtendBadge,
  AIBubble, Leaderboard, BidButton, QuickBidChips, HeatMeter,
  ConnectionBar, ClockDriftIndicator } from './primitives.jsx';
import { LeadingToast, OvertakenSlam, MyPositionGap,
  BidTickerStream, HeartbeatVignette, SpeakerToggle,
  SandHourglass, PulseWaves, LongPressBidWheel,
  BlackHorseBanner, HammerTransition } from './atmosphere.jsx';

// lumen-mobile.jsx
// Mobile H5 screens: Room (LIVE + final-10s), Hammer overlay, Evidence.
// Inside an IOSDevice (402×874). Safe-area: top 47 status, bottom 34 home.

// Demo data — 5-figure luxury watch (the brief says high-value singles)
const DEMO_LEADERS = [
  { userId: 'u1', displayName: '海风_2024',    cents: '12880000', avatarBg: 'linear-gradient(135deg,#FE2C55,#cb203f)' },
  { userId: 'u2', displayName: '听雨人',       cents: '12750000', avatarBg: 'linear-gradient(135deg,#25F4EE,#0ea5e9)' },
  { userId: 'u3', displayName: '陆_LU',        cents: '12500000', avatarBg: 'linear-gradient(135deg,#a855f7,#7c3aed)', isYou: true },
  { userId: 'u4', displayName: '盐渍生活',     cents: '12380000', avatarBg: 'linear-gradient(135deg,#f59e0b,#d97706)' },
  { userId: 'u5', displayName: 'Echo🌙',        cents: '12200000', avatarBg: 'linear-gradient(135deg,#10b981,#059669)' },
];

// ─── Mobile · Room ─────────────────────────────────────────────
function MobileRoom({
  remainingMs = 30000,
  status = 'LIVE',
  currentCents = '12880000',
  stepCents = '500000',
  capCents = null,
  extendCount = 2,
  extendSweep = false,
  isYouLeading = false,
  overtakeBanner = false,
  rejectShake = false,
  rejectCode = null,
  flashPrice = false,
  aiStatus = 'live',
  aiTrigger = 'open',
  aiText = '当前价 ¥128,800 · 还有 30 秒，机会留给最果断的人。',
  aiStreaming = false,
  connStatus = 'ok',
  showColorRamp = false,
  expressive = true,
  showOwnFlash = false,
  showLeadingToast = false,
  ticker = [],
  yourRank = 3,
  yourGapCents = '380000',
  screenShake = false,
  showHourglass = false,
  showPulseWaves = false,
  showBlackHorse = false,
  showLongPress = false,
  showHammerTransition = false,
  combos = {},  // userId -> streak count
  // F-new (post-Elia round-2 review):
  bidsPerSec = 0,          // for the HeatMeter
  bidsPerSecPeak = 6,      // scale ceiling — calibrate from observed peak
  leaders: leadersProp,    // optional override; falls back to DEMO_LEADERS
  onBid,                   // chip-driven bid callback; LiveRoomRoute passes placeBid
}) {
  // Background color-temp ramp on the last 10s — only if asked, anchored to urgency (§9.2)
  const warn = remainingMs <= 10000 && status === 'LIVE';
  const bg = warn && showColorRamp
    ? 'radial-gradient(ellipse at top, rgba(254,44,85,.18) 0%, var(--douyin-ink) 55%)'
    : 'var(--douyin-ink)';

  const baseLeaders = (leadersProp && leadersProp.length) ? leadersProp : DEMO_LEADERS;
  const leaders = baseLeaders.map((u, i) => ({
    ...u,
    cents: i === 0 ? currentCents : u.cents,
    combo: combos[u.userId] || 0,
  }));

  // F23 / Elia round-2 #3: screen-shake on hammer. One-shot — flips back
  // to false ~700ms after status enters SOLD so the keyframe doesn't loop.
  const [hammerShake, setHammerShake] = React.useState(false);
  const lastStatusRef = React.useRef(status);
  React.useEffect(() => {
    if (status === 'SOLD' && lastStatusRef.current !== 'SOLD') {
      setHammerShake(true);
      const t = setTimeout(() => setHammerShake(false), 700);
      lastStatusRef.current = status;
      return () => clearTimeout(t);
    }
    lastStatusRef.current = status;
  }, [status]);
  const shakeNow = screenShake || hammerShake;

  // Bid reject toast — CN copy from bidRejectCopy[code] (§4.3 wire)
  const rejectMsg = rejectCode ? (bidRejectCopy[rejectCode] || rejectCode) : null;

  return (
    <div className={shakeNow ? 'lumen-screen-shake' : ''} style={{
      position: 'relative', width: '100%', height: '100%',
      background: bg, color: 'var(--douyin-ink-text)',
      fontFamily: 'var(--font-sans)', overflow: 'hidden',
      transition: 'background .6s ease',
    }}>
      {/* Final-10s heartbeat vignette */}
      <HeartbeatVignette active={warn && expressive}/>

      {/* Pulse waves from price card */}
      <PulseWaves active={warn && showPulseWaves && expressive}/>

      {/* Conn bar */}
      <ConnectionBar status={connStatus} />

      {/* Bid ticker stream */}
      {expressive && ticker.length > 0 && <BidTickerStream items={ticker}/>}

      {/* Black horse banner — F13 */}
      <BlackHorseBanner visible={showBlackHorse && expressive}/>

      {/* Leading celebration toast — F06 */}
      <LeadingToast visible={showLeadingToast} gainCents="500000"/>

      {/* Reject toast — CN copy from bidRejectCopy[code] */}
      {rejectMsg && (
        <div className="lumen-slam-in" style={{
          position: 'absolute', top: 100, left: '50%', transform: 'translateX(-50%)', zIndex: 65,
          padding: '8px 14px', borderRadius: 8,
          background: 'rgba(255,77,112,.95)', color: '#fff', backdropFilter: 'blur(8px)',
          fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-sans)',
          display: 'flex', alignItems: 'center', gap: 8,
          boxShadow: '0 10px 28px rgba(255,77,112,.4)',
        }}>
          <span>✗</span>
          <span>{rejectMsg}</span>
          <span className="mono" style={{ fontSize: 10, opacity: .8 }}>{rejectCode}</span>
        </div>
      )}

      {/* Long-press bid wheel — F25 */}
      <LongPressBidWheel
        visible={showLongPress}
        currentCents={currentCents}
        stepCents="500000"
        onPick={() => {}}
        onClose={() => {}}
      />

      {/* Hammer transition (A→B) overlay — covers the room during the flip */}
      <HammerTransition active={showHammerTransition} amountCents={currentCents}/>

      {/* ── Video / streamer area ── */}
      <div style={{
        position: 'absolute', inset: 0, height: '46%', overflow: 'hidden',
      }}>
        {/* placeholder streamer surface — gradient + faux items */}
        <div style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(160deg, #2a1f2e 0%, #1a1320 30%, #0a0e1a 100%)',
        }}>
          {/* item: a watch (SVG silhouette as placeholder) */}
          <svg viewBox="0 0 200 200" style={{
            position: 'absolute', top: '20%', left: '50%', transform: 'translateX(-50%)',
            width: 150, height: 150, opacity: .55,
          }}>
            <defs>
              <radialGradient id="watchGrad" cx="50%" cy="35%" r="60%">
                <stop offset="0%" stopColor="#3a3340"/>
                <stop offset="100%" stopColor="#0a0a10"/>
              </radialGradient>
            </defs>
            {/* strap */}
            <rect x="86" y="20" width="28" height="38" rx="4" fill="#1a1a22"/>
            <rect x="86" y="142" width="28" height="40" rx="4" fill="#1a1a22"/>
            {/* case */}
            <circle cx="100" cy="100" r="48" fill="url(#watchGrad)" stroke="#C9A961" strokeWidth="1.5" opacity=".9"/>
            <circle cx="100" cy="100" r="42" fill="#0d0d14" stroke="rgba(255,255,255,.06)"/>
            {/* hands */}
            <line x1="100" y1="100" x2="100" y2="68" stroke="#C9A961" strokeWidth="2" strokeLinecap="round"/>
            <line x1="100" y1="100" x2="125" y2="100" stroke="#dcbf7f" strokeWidth="1.5" strokeLinecap="round"/>
            <circle cx="100" cy="100" r="2" fill="#C9A961"/>
            {/* hour ticks */}
            {[0,1,2,3,4,5,6,7,8,9,10,11].map(h => {
              const a = h * Math.PI / 6;
              const x1 = 100 + Math.sin(a) * 38;
              const y1 = 100 - Math.cos(a) * 38;
              const x2 = 100 + Math.sin(a) * 41;
              const y2 = 100 - Math.cos(a) * 41;
              return <line key={h} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#9aa0b4" strokeWidth="0.8"/>;
            })}
          </svg>

          {/* very-faint noise overlay */}
          <div style={{
            position: 'absolute', inset: 0, opacity: .15,
            backgroundImage: 'radial-gradient(rgba(255,255,255,.06) 1px, transparent 1.5px)',
            backgroundSize: '8px 8px',
          }}/>
        </div>

        {/* Top chrome over video */}
        <div style={{
          position: 'absolute', top: 56, left: 16, right: 16,
          display: 'flex', alignItems: 'center', gap: 8, zIndex: 5,
        }}>
          {/* host pill */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '4px 10px 4px 4px', borderRadius: 999,
            background: 'rgba(0,0,0,.5)', backdropFilter: 'blur(8px)',
          }}>
            <div style={{
              width: 26, height: 26, borderRadius: 13,
              background: 'linear-gradient(135deg,#FE2C55,#a855f7)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontSize: 11, fontWeight: 600,
            }}>琉</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <span style={{ fontSize: 11, fontWeight: 600 }}>琉森拍卖行</span>
              <span style={{ fontSize: 9, color: 'var(--douyin-ink-muted)' }}>1.2万 在线</span>
            </div>
            <button style={{
              padding: '3px 10px', borderRadius: 999, border: 'none',
              background: 'var(--douyin-red)', color: '#fff', fontSize: 10, fontWeight: 600,
              marginLeft: 4,
            }}>+ 关注</button>
          </div>
          <div style={{ flex: 1 }}/>
          <StatusBadge status={status} size="sm" />
          {/* speaker (muted per §12.7.2) — breathing icon */}
          <SpeakerToggle muted/>
        </div>

        {/* item meta strip */}
        <div style={{
          position: 'absolute', top: 100, left: 16, right: 16, zIndex: 5,
          display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          <div style={{ fontSize: 11, color: 'var(--douyin-ink-muted)', letterSpacing: '.04em' }}>
            LOT 2024-0142 · 二手腕表 · 已认证
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-.01em' }}>
            百达翡丽 5711/1A 鹦鹉螺 · 蓝面
          </div>
        </div>

        {/* Overtake slam — F07 */}
        {overtakeBanner && (
          <OvertakenSlam visible byName="海风_2024" gapCents="130000"/>
        )}
      </div>

      {/* ── Detail sheet — bottom 54% ── */}
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 0, top: '46%',
        background: 'linear-gradient(180deg, transparent 0%, var(--douyin-ink) 8%, var(--douyin-ink) 100%)',
        display: 'flex', flexDirection: 'column',
        padding: '12px 14px 50px',
        gap: 10, overflow: 'hidden',
      }}>
        {/* Drag handle */}
        <div style={{
          alignSelf: 'center', width: 36, height: 4, borderRadius: 2,
          background: 'rgba(255,255,255,.18)', marginBottom: -4,
        }}/>

        {/* Price + countdown row */}
        <div className={showOwnFlash ? 'lumen-gold-flash' : ''} style={{
          display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
          padding: '6px 4px 0', borderRadius: 8,
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 10, color: 'var(--douyin-ink-muted)', letterSpacing: '.06em' }}>
              当前价 · CURRENT
            </span>
            <PriceDisplay cents={currentCents} size={36} tone="ink" flash={flashPrice} withUnderline/>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: 'var(--douyin-ink-muted)', letterSpacing: '.06em' }}>
                {warn ? '即将落槌' : '距落槌'}
              </span>
              <ClockDriftIndicator offsetMs={42}/>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {showHourglass && warn && (
                <SandHourglass remainingMs={remainingMs} totalMs={10000}/>
              )}
              <Countdown remainingMs={remainingMs} size="lg"/>
            </div>
          </div>
        </div>

        {/* Anti-snipe badge row — F02 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px' }}>
          <ExtendBadge count={extendCount} sweep={extendSweep}/>
          <span style={{ fontSize: 10, color: 'var(--douyin-ink-muted)' }}>
            末 10s 出价自动延时
          </span>
          <div style={{ flex: 1 }}/>
          <span className="mono" style={{ fontSize: 10, color: 'var(--douyin-ink-dim)' }}>
            seq #14921
          </span>
        </div>

        {/* Leaderboard */}
        <div style={{ marginTop: 4 }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '0 4px 6px',
          }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--douyin-ink-muted)', letterSpacing: '.04em' }}>
              出价榜 · TOP 3
            </span>
            <HeatMeter bidsPerSec={bidsPerSec} peak={bidsPerSecPeak}/>
          </div>
          <Leaderboard leaders={leaders.slice(0, 3)} mode="podium"/>
          {/* My position gap — always visible to user (anti-disengagement) */}
          <div style={{ marginTop: 8 }}>
            <MyPositionGap
              rank={yourRank}
              gapCents={yourGapCents}
              isLeading={isYouLeading}
            />
          </div>
        </div>

        {/* AI bubble */}
        <AIBubble status={aiStatus} trigger={aiTrigger} text={aiText} streaming={aiStreaming}/>

        {/* Bid CTA — chips replacing the single number-input (Elia #49 round-2 #2).
            onBid is called with the absolute cents string the chip computed;
            LiveRoomRoute wires it to placeBid. */}
        <div style={{ marginTop: 'auto' }}>
          <QuickBidChips
            currentCents={currentCents}
            stepCents={stepCents}
            capCents={capCents}
            disabled={status !== 'LIVE'}
            isLeading={isYouLeading}
            shake={rejectShake}
            onBid={(c) => { if (onBid) onBid(c); }}
          />
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            padding: '6px 4px 0', fontSize: 10, color: 'var(--douyin-ink-dim)',
          }}>
            <span>最低加价 {formatCentsCNY(stepCents)}</span>
            <span className="mono">末10s 出价 → +30s 反狙击</span>
          </div>
        </div>
      </div>

      {/* Terminal overlay — Elia round-2 H2 (#54). NO_BID and CANCELLED
          previously had no full-screen treatment, so a buyer who's still
          looking at the room when the timer fires saw only the StatusBadge
          flip with no clear "this ended" signal. SOLD has its own
          HammerTransition above; this fills the gap for the two quiet
          terminal states. */}
      <TerminalOverlay status={status}/>
    </div>
  );
}

// One-shot full-screen overlay for NO_BID + CANCELLED terminal states.
// Renders nothing for LIVE / SCHEDULED / DRAFT / SOLD / ORDER_CREATED.
// SOLD has its own A→B HammerTransition crossfade so we explicitly skip it.
function TerminalOverlay({ status }) {
  if (status !== 'NO_BID' && status !== 'CANCELLED') return null;
  const isNoBid = status === 'NO_BID';
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 80,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      // semi-transparent so the room hash + final price stay visible underneath
      background: isNoBid
        ? 'radial-gradient(ellipse at center, rgba(20,20,30,.92) 0%, rgba(10,10,18,.96) 70%)'
        : 'radial-gradient(ellipse at center, rgba(40,8,18,.92) 0%, rgba(10,10,18,.96) 70%)',
      backdropFilter: 'blur(2px)',
      fontFamily: 'var(--font-sans)',
      animation: 'lumen-veil-bridge-fade .4s ease-in 1 both',
    }}>
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14,
        padding: '28px 36px', borderRadius: 18,
        background: 'rgba(0,0,0,.35)',
        border: isNoBid
          ? '1px solid rgba(154,160,180,.25)'
          : '1px solid rgba(254,44,85,.4)',
        textAlign: 'center', maxWidth: 280,
      }}>
        <div style={{
          width: 52, height: 52, borderRadius: 26,
          background: 'rgba(0,0,0,.4)',
          border: `2px solid ${isNoBid ? 'var(--state-no-bid)' : 'var(--state-rejected)'}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 22,
          color: isNoBid ? 'var(--state-no-bid)' : 'var(--state-rejected)',
        }}>
          {isNoBid ? '∅' : '×'}
        </div>
        <div className="serif" style={{
          fontSize: 22, fontWeight: 600,
          color: isNoBid ? 'var(--douyin-ink-text)' : 'var(--state-rejected)',
          letterSpacing: '.02em',
        }}>
          {isNoBid ? '本场无人出价' : '本场已取消'}
        </div>
        <div style={{
          fontSize: 11, color: 'var(--douyin-ink-muted)', lineHeight: 1.5,
        }}>
          {isNoBid
            ? '流拍 · NO_BID · 序列号已上链 · 可查看证据卡'
            : '卖家终止 · CANCELLED · 序列号已上链 · 出价记录保留'}
        </div>
      </div>
    </div>
  );
}

// ─── Mobile · Hammer overlay (A→B accent flip) ─────────────────
function MobileHammer({ amountCents = '12880000', winnerName = '海风_2024', expressive = true }) {
  return (
    <div style={{
      position: 'relative', width: '100%', height: '100%',
      background: 'radial-gradient(ellipse at center 35%, var(--solemn-deep-card) 0%, var(--solemn-deep) 60%)',
      color: 'var(--solemn-cream)', overflow: 'hidden',
      fontFamily: 'var(--font-serif)',
    }}>
      {/* Subtle gold dust */}
      {expressive && Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="lumen-dust" style={{
          position: 'absolute', left: `${(i * 73 + 15) % 90}%`, bottom: -20,
          width: 4, height: 4, borderRadius: 2,
          background: i % 3 === 0 ? 'var(--solemn-gold-soft)' : 'var(--solemn-gold)',
          boxShadow: '0 0 8px rgba(201,169,97,.6)',
          animationDelay: `${(i * 0.23) % 2.8}s`,
        }}/>
      ))}

      {/* Top: status flip */}
      <div style={{
        position: 'absolute', top: 60, left: 0, right: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
      }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: '6px 14px', borderRadius: 999,
          background: 'rgba(201,169,97,.12)', border: '1px solid rgba(201,169,97,.4)',
        }}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M3 6l2.5 2.5L9 4" stroke="var(--solemn-gold)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span className="sans" style={{
            fontSize: 11, fontWeight: 600, color: 'var(--solemn-gold)',
            letterSpacing: '.08em',
          }}>SOLD · 已成交</span>
        </div>
        <div className="sans" style={{ fontSize: 11, color: 'var(--solemn-cream-dim)', letterSpacing: '.08em' }}>
          LOT 2024-0142 · 百达翡丽 5711/1A
        </div>
      </div>

      {/* Centerpiece: serif gold price */}
      <div style={{
        position: 'absolute', top: '34%', left: 0, right: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
      }}>
        <div className="sans" style={{
          fontSize: 11, color: 'var(--solemn-cream-dim)', letterSpacing: '.16em',
        }}>HAMMER PRICE</div>
        <div className="mono" style={{
          fontSize: 56, fontWeight: 700, color: 'var(--solemn-gold)',
          letterSpacing: '-.025em', lineHeight: 1,
          textShadow: '0 4px 30px rgba(201,169,97,.35)',
        }}>
          {formatCentsCNY(amountCents)}
        </div>
        <div style={{
          width: 80, height: 1, marginTop: 14,
          background: 'linear-gradient(90deg, transparent, var(--solemn-gold), transparent)',
        }}/>
        <div className="serif" style={{
          marginTop: 16, fontSize: 22, fontWeight: 500, color: 'var(--solemn-cream)',
          letterSpacing: '.02em',
        }}>{winnerName}</div>
        <div className="sans" style={{ fontSize: 11, color: 'var(--solemn-cream-dim)' }}>
          最终竞得 · WINNING BIDDER
        </div>
      </div>

      {/* Bottom: evidence CTA + meta */}
      <div style={{
        position: 'absolute', left: 16, right: 16, bottom: 50,
        display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          padding: '10px 14px', borderRadius: 10,
          background: 'rgba(245,237,221,.04)', border: '1px solid rgba(201,169,97,.18)',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span className="sans" style={{ fontSize: 9, color: 'var(--solemn-cream-dim)', letterSpacing: '.08em' }}>HAMMER SEQ</span>
            <span className="mono" style={{ fontSize: 13, color: 'var(--solemn-cream)' }}>#14998</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
            <span className="sans" style={{ fontSize: 9, color: 'var(--solemn-cream-dim)', letterSpacing: '.08em' }}>CHAIN HEAD</span>
            <span className="mono" style={{ fontSize: 13, color: 'var(--solemn-gold)' }}>0x9c4f…b318</span>
          </div>
        </div>

        <button style={{
          width: '100%', padding: '14px', borderRadius: 12,
          background: 'linear-gradient(135deg, var(--solemn-gold) 0%, var(--solemn-gold-soft) 100%)',
          color: 'var(--solemn-ink)', border: 'none',
          fontFamily: 'var(--font-sans)', fontSize: 15, fontWeight: 600,
          letterSpacing: '.02em', cursor: 'pointer',
          boxShadow: '0 8px 28px rgba(201,169,97,.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        }}>
          查看证据卡
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M3 7h8M8 3l4 4-4 4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>

        <div className="sans" style={{
          fontSize: 10, color: 'var(--solemn-cream-dim)', textAlign: 'center',
          letterSpacing: '.04em',
        }}>
          时间 21:48:33 · 服务器时序已确认 · 证据已上链
        </div>
      </div>
    </div>
  );
}

// ─── Mobile · Evidence ─────────────────────────────────────────
const EVIDENCE_EVENTS = [
  { type: 'AUCTION_SCHEDULED', seq: 14002, time: '21:30:00.012', amount: null,
    prev: '0000000000000000', hash: '7e2a4c91d83b15f0' },
  { type: 'AUCTION_STARTED',   seq: 14003, time: '21:30:00.483', amount: '12000000',
    prev: '7e2a4c91d83b15f0', hash: 'a14b2f87e3091ccd' },
  { type: 'BID_ACCEPTED',      seq: 14201, time: '21:35:12.144', amount: '12200000',
    prev: 'a14b2f87e3091ccd', hash: 'c3f8d12a4b9e5601' },
  { type: 'BID_ACCEPTED',      seq: 14592, time: '21:46:08.802', amount: '12500000',
    prev: 'c3f8d12a4b9e5601', hash: '5b9e017dc4a23f88' },
  { type: 'AUCTION_EXTENDED',  seq: 14834, time: '21:47:51.601', amount: null,
    prev: '5b9e017dc4a23f88', hash: '8d24a7c91e5b0394', extendCount: 1 },
  { type: 'BID_ACCEPTED',      seq: 14912, time: '21:48:14.221', amount: '12750000',
    prev: '8d24a7c91e5b0394', hash: 'f019b4c7283d6e5a' },
  { type: 'AUCTION_EXTENDED',  seq: 14945, time: '21:48:24.110', amount: null,
    prev: 'f019b4c7283d6e5a', hash: '2c87e91a4f5b0d34', extendCount: 2 },
  { type: 'BID_ACCEPTED',      seq: 14991, time: '21:48:31.418', amount: '12880000',
    prev: '2c87e91a4f5b0d34', hash: 'b419f37c80512aed' },
  { type: 'AUCTION_SOLD',      seq: 14998, time: '21:48:33.002', amount: '12880000',
    prev: 'b419f37c80512aed', hash: '9c4f8a1027bd5b18', winner: '海风_2024' },
];

const TYPE_META = {
  AUCTION_SCHEDULED: { label: '排期已生成', color: 'var(--solemn-cream-dim)', icon: '◷' },
  AUCTION_STARTED:   { label: '开拍',         color: 'var(--state-live)',     icon: '▶' },
  BID_ACCEPTED:      { label: '出价采纳',     color: 'var(--solemn-cream)',   icon: '↑' },
  AUCTION_EXTENDED:  { label: '反狙击延时',   color: 'var(--state-extended)', icon: '⟳' },
  AUCTION_SOLD:      { label: '落槌成交',     color: 'var(--solemn-gold)',    icon: '✦' },
  AUCTION_NO_BID:    { label: '本场无人出价', color: 'var(--state-no-bid)',   icon: '·' },
  AUCTION_CANCELLED: { label: '已取消',       color: 'var(--state-cancelled)', icon: '×' },
};

// MobileEvidence — props mode-aware:
//
//  • No `evidence` prop given: renders the inline demo data (used by
//    /preview/evidence and /preview/evidence/broken). `chainBreak` and
//    `breakAtSeq` switch the demo to the broken-chain variant.
//
//  • `evidence` prop provided: renders the real evidence card from
//    GET /api/auctions/:id/evidence (see EvidenceRoute.jsx). The
//    component maps backend's timeline event shape to its own row shape
//    inside the render below — no external mapping required.
function MobileEvidence({ chainBreak = false, breakAtSeq = null, evidence = null }) {
  const isWired = evidence != null;
  const [actionHint, setActionHint] = React.useState('');
  const actionHintTimerRef = React.useRef(null);

  // Map backend timeline → component event rows. Each row needs the same
  // fields the demo array provides: { type, seq, time, amount, prev, hash,
  // extendCount?, winner? }. Backend ships { seq, eventType, payload (JSON
  // string), eventHash, prevHash }. We parse payload lazily for the per-row
  // amount / time / winner / extendCount.
  const events = isWired
    ? (evidence.timeline || []).map((e) => {
        let p = {};
        try { p = typeof e.payload === 'string' ? JSON.parse(e.payload) : (e.payload || {}); } catch {}
        const ts = typeof p.serverTimeMs === 'number' ? p.serverTimeMs : null;
        return {
          type: e.eventType,
          seq: e.seq,
          time: ts ? formatHMS(ts) : '',
          amount: p.amountCents ?? null,
          prev: e.prevHash || '0000000000000000',
          hash: e.eventHash || '',
          extendCount: p.extendCount ?? undefined,
          winner: p.displayName ?? p.winnerId ?? undefined,
        };
      })
    : EVIDENCE_EVENTS;

  // M5 (Elia review on #51): explicit `=== false` check, NOT `!chainVerified`.
  // The latter false-positives a CHAIN BROKEN visual when the response is
  // missing the field entirely (old backend / fetch error / schema drift /
  // partial degradation) — `!undefined === true`. We only want the red
  // alarm UI when the backend has actively reported a broken chain;
  // missing field stays neutral (no badge either way).
  const chainBroken = isWired ? (evidence.chainVerified === false) : chainBreak;
  const effectiveBreakAtSeq = chainBroken ? (isWired ? (evidence.hashBreakAtSeq ?? null) : breakAtSeq) : null;
  const breakIdx = chainBroken
    ? events.findIndex((e) => e.seq === effectiveBreakAtSeq)
    : -1;

  const headerPrice = isWired
    ? (evidence.currentPriceCents ?? '0')
    : '12880000';
  const chainHead = isWired ? (evidence.eventsHash || '') : '0x9c4f8a1027bd5b189c4f8a1027bd5b189c4f8a1027bd5b18';
  // Top-level winner display is currently not shown in the evidence card;
  // per-row winner comes from the AUCTION_SOLD event's payload.displayName.
  // Keeping the prop computed so future variants can use it.
  const lotTitle = isWired ? (evidence.auctionId || '—') : '百达翡丽 5711/1A · 蓝面';
  const lotId = isWired ? `AID ${(evidence.auctionId || '').slice(0, 12)}` : 'LOT 2024-0142';

  const showHint = (msg) => {
    if (actionHintTimerRef.current) clearTimeout(actionHintTimerRef.current);
    setActionHint(msg);
    actionHintTimerRef.current = setTimeout(() => setActionHint(''), 1800);
  };

  const copyEvidenceJson = async () => {
    if (!isWired || !evidence) return;
    try {
      const payload = {
        auctionId: evidence.auctionId,
        chainVerified: evidence.chainVerified,
        eventsHash: evidence.eventsHash,
        hashBreakAtSeq: evidence.hashBreakAtSeq ?? null,
        timeline: evidence.timeline,
      };
      const text = JSON.stringify(payload, null, 2);
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        showHint('证据 JSON 已复制');
      } else {
        showHint('当前环境不支持剪贴板复制');
      }
    } catch {
      showHint('复制失败，请手动长按选择内容');
    }
  };

  React.useEffect(() => {
    return () => {
      if (actionHintTimerRef.current) {
        clearTimeout(actionHintTimerRef.current);
      }
    };
  }, []);

  const shareEvidence = async () => {
    if (!isWired) return;
    const shareUrl = typeof location !== 'undefined' ? location.href : '';
    const sharePayload = {
      title: `拍卖证据卡 · ${lotTitle}`,
      text: `拍卖 ${lotTitle} 的链式证据卡 · 最新链头 ${chainHead.slice(0, 18)}…`,
      url: shareUrl,
    };
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share(sharePayload);
        return;
      } catch {
        // user canceled or share unsupported -> fallback to copy URL
      }
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(shareUrl);
      showHint('证据链接已复制');
      return;
    }
    showHint('当前环境不支持一键分享');
  };

  // helper for mono time string from epoch-ms
  function formatHMS(ms) {
    const d = new Date(ms);
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    const ms3 = String(d.getMilliseconds()).padStart(3, '0');
    return `${h}:${m}:${s}.${ms3}`;
  }

  // chainHead / lotTitle / lotId / headerPrice / events are wired below:
  // hardcoded literals in the JSX were replaced with these refs so
  // /preview/evidence still renders demo data, while EvidenceRoute
  // injects real backend data.
  return (
    <div style={{
      position: 'relative', width: '100%', height: '100%',
      background: 'var(--solemn-deep)', color: 'var(--solemn-cream)',
      fontFamily: 'var(--font-sans)', overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '52px 18px 14px',
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <button style={{
          width: 30, height: 30, borderRadius: 15, border: 'none',
          background: 'rgba(245,237,221,.06)', color: 'var(--solemn-cream)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M9 3L4 7l5 4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span className="serif" style={{ fontSize: 18, fontWeight: 500 }}>证据卡</span>
          <span style={{ fontSize: 10, color: 'var(--solemn-cream-dim)', letterSpacing: '.04em' }}>
            EVIDENCE · 哈希链可验证
          </span>
        </div>
        <div style={{ flex: 1 }}/>
        {/* Chain verified — or BREAK flag */}
        {chainBroken ? (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 10px', borderRadius: 999,
            background: 'rgba(254,44,85,.12)', border: '1px solid var(--state-rejected)',
          }}>
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <path d="M5.5 1L9 3v3c0 2-1.6 3.6-3.5 4C3.6 9.6 2 8 2 6V3l3.5-2z" stroke="var(--state-rejected)" strokeWidth="1.2" fill="rgba(254,44,85,.15)"/>
              <path d="M4 4.5L7 7.5M7 4.5L4 7.5" stroke="var(--state-rejected)" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
            <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--state-rejected)', letterSpacing: '.04em' }}>
              CHAIN BROKEN
            </span>
          </div>
        ) : (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 10px', borderRadius: 999,
            background: 'rgba(201,169,97,.12)', border: '1px solid rgba(201,169,97,.4)',
          }}>
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <path d="M5.5 1L9 3v3c0 2-1.6 3.6-3.5 4C3.6 9.6 2 8 2 6V3l3.5-2z" stroke="var(--solemn-gold)" strokeWidth="1.2" fill="rgba(201,169,97,.15)"/>
              <path d="M4 5.5l1.2 1.2L7.5 4.5" stroke="var(--solemn-gold)" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
            <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--solemn-gold)', letterSpacing: '.04em' }}>
              CHAIN VERIFIED
            </span>
          </div>
        )}
      </div>

      {chainBroken && (
        <div style={{
          margin: '0 16px 12px', padding: '10px 12px', borderRadius: 8,
          background: 'rgba(254,44,85,.08)', border: '1px solid rgba(254,44,85,.35)',
          display: 'flex', gap: 10, alignItems: 'flex-start',
        }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0, marginTop: 2 }}>
            <path d="M7 1l6 11H1L7 1zM7 5v4M7 11v.5" stroke="var(--state-rejected)" strokeWidth="1.3" strokeLinejoin="round"/>
          </svg>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--state-rejected)' }}>
              检测到哈希链断裂 · seq #{breakAtSeq}
            </div>
            <div style={{ fontSize: 11, color: 'var(--solemn-cream-dim)', lineHeight: 1.5, marginTop: 4 }}>
              prev_hash 与上一条 event_hash 不匹配。该记录及之后所有事件不可信，需 Replay Verifier 复核。
            </div>
          </div>
        </div>
      )}

      {/* Summary card */}
      <div style={{
        margin: '0 16px 14px',
        padding: '14px 16px', borderRadius: 12,
        background: 'rgba(245,237,221,.04)', border: '1px solid rgba(201,169,97,.18)',
      }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
        }}>
          <div>
            <div className="serif" style={{ fontSize: 13, color: 'var(--solemn-cream)', marginBottom: 2 }}>
              {lotTitle}
            </div>
            <div className="mono" style={{ fontSize: 10, color: 'var(--solemn-cream-dim)' }}>
              {lotId}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="mono" style={{
              fontSize: 22, fontWeight: 700, color: 'var(--solemn-gold)',
              lineHeight: 1, letterSpacing: '-.02em',
            }}>
              {formatCentsCNY(headerPrice)}
            </div>
            <div style={{ fontSize: 10, color: 'var(--solemn-cream-dim)', marginTop: 2 }}>
              落槌价 · HAMMER
            </div>
          </div>
        </div>
      </div>

      {/* Timeline / ledger */}
      <div style={{
        margin: '0 16px', padding: '6px 0',
        flex: 1, overflowY: 'auto',
      }} className="no-scrollbar">
        <div style={{
          fontSize: 10, color: 'var(--solemn-cream-dim)', letterSpacing: '.08em',
          padding: '0 4px 8px',
        }}>
          时间线 · {events.length} 条记录
        </div>
        <div style={{ position: 'relative' }}>
          {/* vertical chain line */}
          <div style={{
            position: 'absolute', left: 9, top: 14, bottom: 14, width: 1,
            background: 'linear-gradient(180deg, rgba(201,169,97,.6), rgba(201,169,97,.18))',
          }}/>
          {events.map((ev, i) => {
            const meta = TYPE_META[ev.type];
            const isBreakRow = i === breakIdx;
            const afterBreak = breakIdx >= 0 && i > breakIdx;
            return (
              <div key={ev.seq} style={{
                display: 'flex', gap: 10, position: 'relative',
                opacity: afterBreak ? 0.4 : 1,
                background: isBreakRow ? 'rgba(254,44,85,.06)' : 'transparent',
                borderRadius: isBreakRow ? 6 : 0,
                margin: isBreakRow ? '0 -8px' : 0,
                padding: isBreakRow ? '8px 8px' : '8px 0',
                border: isBreakRow ? '1px solid rgba(254,44,85,.3)' : 'none',
              }}>
                {/* node */}
                <div style={{
                  flexShrink: 0, width: 19, height: 19, borderRadius: 10,
                  background: 'var(--solemn-deep)',
                  border: `1.5px solid ${meta.color}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 9, color: meta.color, marginTop: 1,
                }}>
                  {meta.icon}
                </div>
                {/* details */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    display: 'flex', justifyContent: 'space-between',
                    alignItems: 'baseline', gap: 8,
                  }}>
                    <span style={{
                      fontSize: 12, fontWeight: 600, color: meta.color, letterSpacing: '.02em',
                    }}>
                      {meta.label}
                      {ev.extendCount && (
                        <span className="mono" style={{ marginLeft: 6, fontSize: 10, opacity: .8 }}>
                          ×{ev.extendCount}
                        </span>
                      )}
                    </span>
                    <span className="mono" style={{ fontSize: 10, color: 'var(--solemn-cream-dim)' }}>
                      seq #{ev.seq}
                    </span>
                  </div>
                  <div className="mono" style={{ fontSize: 10, color: 'var(--solemn-cream-dim)', marginTop: 1 }}>
                    {ev.time}
                    {ev.amount && <span style={{ marginLeft: 8, color: 'var(--solemn-cream)' }}>
                      {formatCentsCNY(ev.amount)}
                    </span>}
                    {ev.winner && <span style={{ marginLeft: 8, color: 'var(--solemn-cream)' }}>
                      → {ev.winner}
                    </span>}
                  </div>
                  <div style={{
                    marginTop: 4, padding: '5px 8px', borderRadius: 4,
                    background: 'rgba(0,0,0,.25)', display: 'flex',
                    alignItems: 'center', gap: 6, flexWrap: 'wrap',
                  }}>
                    <span className="mono" style={{ fontSize: 9, color: 'var(--solemn-cream-dim)' }}>prev</span>
                    <span className="mono" style={{ fontSize: 10, color: 'var(--solemn-cream-dim)' }}>0x{ev.prev.slice(0,8)}</span>
                    <span style={{ color: 'var(--solemn-gold)', fontSize: 10 }}>→</span>
                    <span className="mono" style={{ fontSize: 9, color: 'var(--solemn-cream-dim)' }}>hash</span>
                    <span className="mono" style={{ fontSize: 10, color: 'var(--solemn-gold)' }}>0x{ev.hash.slice(0,8)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Chain head footer */}
        <div style={{
          margin: '12px 0 50px', padding: '12px',
          borderRadius: 10, background: 'rgba(201,169,97,.06)',
          border: '1px solid rgba(201,169,97,.3)',
        }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginBottom: 6,
          }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--solemn-gold)', letterSpacing: '.06em' }}>
              CHAIN HEAD
            </span>
            <span style={{ fontSize: 9, color: 'var(--solemn-cream-dim)' }}>SHA-256</span>
          </div>
          <div className="mono" style={{
            fontSize: 11, color: 'var(--solemn-cream)', wordBreak: 'break-all',
            lineHeight: 1.5,
          }}>
            {chainHead || '—'}
          </div>
          <div style={{
            fontSize: 10, color: 'var(--solemn-cream-dim)', marginTop: 4,
            display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
          }}>
            <button
              onClick={copyEvidenceJson}
              disabled={!isWired}
              style={{
                border: '1px solid rgba(201,169,97,.35)',
                background: 'transparent',
                color: 'var(--solemn-cream)',
                padding: '3px 8px',
                borderRadius: 7,
                fontSize: 10,
              }}
            >
              复制证据 JSON
            </button>
            <button
              onClick={shareEvidence}
              disabled={!isWired}
              style={{
                border: '1px solid rgba(201,169,97,.35)',
                background: 'transparent',
                color: 'var(--solemn-cream)',
                padding: '3px 8px',
                borderRadius: 7,
                fontSize: 10,
              }}
            >
              分享证据链接
            </button>
            <span style={{ opacity: actionHint ? 1 : 0.75 }}>
              {actionHint || '点击复制 · 长按导出 JSON'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export {
  MobileRoom,
  MobileHammer,
  MobileEvidence,
  DEMO_LEADERS,
  EVIDENCE_EVENTS
};
