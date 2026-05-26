// components.jsx — Lumen auction UI primitives (split from room.jsx for Babel-standalone fetch reliability)
const { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } = React;
// Pulled from effects.jsx (loaded earlier)
const { useRollingNumber, CountdownRing, HeatMeter, BidParticle, ConfettiBurst } = window;

// ─────────────────── AUCTION RULES (mock) ───────────────────
const RULES = {
  startCents: 3_880_000,   // ¥38,800
  incrementCents: 10_000,  // ¥100
  capCents: 50_000_000,    // ¥500,000
  durationMs: 60_000,
  extendWindowMs: 10_000,
  extendMs: 10_000,
  maxExtensions: 5,
};

const fmtYen = (cents) => '¥' + Math.round(cents / 100).toLocaleString('zh-CN');
const fmtYenSmall = (cents) => Math.round(cents/100).toLocaleString('zh-CN');

const BOTS = [
  { id: 'usr_ami',  name: 'Ami',   color: 'oklch(0.80 0.14 165)' },
  { id: 'usr_leo',  name: 'Leo',   color: 'oklch(0.74 0.18 285)' },
  { id: 'usr_noa',  name: 'Noa',   color: 'oklch(0.84 0.14 86)' },
  { id: 'usr_yuu',  name: 'Yuu',   color: 'oklch(0.72 0.18 36)' },
  { id: 'usr_kai',  name: 'Kai',   color: 'oklch(0.70 0.16 320)' },
  { id: 'usr_min',  name: 'Min',   color: 'oklch(0.78 0.12 220)' },
];
const ME = { id: 'me', name: '我', color: 'var(--ink-1)' };
const userById = (id) => BOTS.find(b => b.id === id) || (id === 'me' ? ME : { id, name: id.slice(-3), color: 'var(--ink-3)' });

// Quick-bid amount selector
function nextAmount(currentCents, mode, key) {
  const inc = RULES.incrementCents;
  const ceilToInc = (n) => Math.ceil(n / inc) * inc;
  let target;
  if (mode === 'percent') {
    const p = { p1: 1.01, p5: 1.05, p10: 1.10 }[key];
    target = ceilToInc(currentCents * p);
    if (target <= currentCents) target = currentCents + inc;
  } else if (mode === 'absolute') {
    const add = { p1: 1_00_00, p5: 5_00_00, p10: 50_00_00 }[key]; // ¥100, ¥500, ¥5000 (in cents)
    target = currentCents + add;
  } else { // 'increment'
    const k = { p1: 1, p5: 5, p10: 10 }[key];
    target = currentCents + inc * k;
  }
  return Math.min(target, RULES.capCents);
}
const QUICK_LABELS = {
  percent:   { p1: '+1%',  p5: '+5%',  p10: '+10%' },
  absolute:  { p1: '+¥100',p5: '+¥500',p10: '+¥5K' },
  increment: { p1: '+1档', p5: '+5档', p10: '+10档' },
};

// ─────────────────── VIDEO STAGE (placeholder) ───────────────────
function VideoStage({ show, productName, terminal }) {
  return (
    <div style={{
      position:'relative', height: show ? 220 : 56, transition:'height .4s ease',
      background: show
        ? 'linear-gradient(135deg, #1d1530 0%, #2a1a3d 40%, #4a2238 100%)'
        : 'linear-gradient(180deg, #15101e, #0c0a14)',
      overflow:'hidden',
    }}>
      {/* slow shimmer to fake video */}
      {show && (
        <>
          <div style={{
            position:'absolute', inset:0,
            background: 'radial-gradient(ellipse 60% 60% at 30% 40%, oklch(0.6 0.15 36 / .35), transparent 60%), radial-gradient(ellipse 50% 60% at 75% 70%, oklch(0.5 0.15 280 / .3), transparent 60%)',
            animation: 'beam 9s ease-in-out infinite alternate',
          }} />
          {/* product silhouette placeholder */}
          <div style={{
            position:'absolute', left:'50%', top:'52%', transform:'translate(-50%,-50%)',
            width: 124, height: 124, borderRadius: '50%',
            background: 'repeating-linear-gradient(45deg, rgba(255,255,255,.04) 0 6px, rgba(255,255,255,.08) 6px 12px)',
            border:'1px dashed rgba(255,255,255,.18)',
            display:'grid', placeItems:'center',
            color:'rgba(255,255,255,.55)', fontFamily:'var(--mono)', fontSize:10, letterSpacing:'.12em',
          }}>VIDEO FEED</div>
        </>
      )}
      {/* top bar — LIVE badge, viewers, hearts */}
      <div style={{
        position:'absolute', left:14, top:14, right:14,
        display:'flex', alignItems:'center', justifyContent:'space-between', gap:8,
      }}>
        <div style={{display:'flex', gap:8, alignItems:'center'}}>
          <span style={{
            display:'inline-flex', alignItems:'center', gap:6,
            padding:'4px 8px 4px 8px', borderRadius: 999,
            background: terminal ? 'rgba(245,241,234,.1)' : 'oklch(0.66 0.22 28)',
            color: terminal ? 'var(--ink-2)' : '#fff',
            fontFamily:'var(--mono)', fontSize:10, fontWeight:600, letterSpacing:'.14em',
          }}>
            <span style={{
              width:6, height:6, borderRadius:'50%',
              background:'#fff',
              boxShadow: terminal ? 'none' : '0 0 8px rgba(255,255,255,.8)',
              animation: terminal ? 'none' : 'liveBlink 1.4s ease-in-out infinite',
            }} />
            {terminal ? 'ENDED' : 'LIVE'}
          </span>
          <span style={{
            fontFamily:'var(--mono)', fontSize:10, color:'var(--ink-2)', letterSpacing:'.08em',
          }}>1,247 watching</span>
        </div>
        <div style={{
          fontFamily:'var(--mono)', fontSize:10, color:'var(--ink-3)', letterSpacing:'.08em',
        }}>auc_demo · seq —</div>
      </div>
      {/* product chip */}
      <div style={{
        position:'absolute', left:14, bottom:14, right:14,
        display:'flex', alignItems:'center', gap:10,
        background:'rgba(12,10,20,.65)', backdropFilter:'blur(20px)',
        border:'1px solid var(--line-2)', borderRadius:14, padding:'8px 12px',
      }}>
        <div style={{
          width:36, height:36, borderRadius:8,
          background:'repeating-linear-gradient(135deg, rgba(255,255,255,.05) 0 4px, rgba(255,255,255,.12) 4px 8px)',
          border:'1px solid var(--line-2)',
        }} />
        <div style={{flex:1, minWidth:0}}>
          <div style={{
            fontFamily:'var(--display)', fontSize:14, fontWeight:600, color:'var(--ink-1)',
            whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis',
          }}>{productName}</div>
          <div style={{
            display:'flex', gap:6, marginTop:3, flexWrap:'wrap',
          }}>
            <FactChip>1995 vintage</FactChip>
            <FactChip>已认证 ✓</FactChip>
            <FactChip>含原盒</FactChip>
          </div>
        </div>
      </div>
      <style>{`
        @keyframes liveBlink { 0%,100%{opacity:1} 50%{opacity:.4} }
        @keyframes beam { from{transform:translate(-3%,-2%)} to{transform:translate(3%,2%)} }
      `}</style>
    </div>
  );
}
function FactChip({ children }) {
  return (
    <span style={{
      fontFamily:'var(--mono)', fontSize:9, letterSpacing:'.04em',
      padding:'2px 6px', borderRadius:4,
      background:'rgba(245,241,234,.06)', color:'var(--ink-2)',
      border:'1px solid var(--line-2)',
      whiteSpace:'nowrap', flexShrink:0,
    }}>{children}</span>
  );
}

// ─────────────────── PRICE CORE ───────────────────
function PriceCore({ priceCents, prevCents, leaderId, remainMs, totalMs, extendCount, lastBidId, hot, ringRef }) {
  // Display priceCents directly. The keyed flash on lastBidId gives the visual
  // beat per bid; rolling-digit animation was unreliable in throttled / hidden
  // iframes (browsers throttle setInterval AND rAF), so we lean on CSS instead.
  const shown = priceCents;
  const youAreLeader = leaderId === 'me';
  const leader = leaderId ? userById(leaderId) : null;
  const went = priceCents - prevCents;

  // glow pulse on bid (keyed by lastBidId)
  return (
    <div style={{
      position:'relative', padding:'24px 20px 18px',
      display:'grid', gridTemplateColumns:'1fr auto', gap:18, alignItems:'center',
      borderBottom:'1px solid var(--line)',
    }}>
      <div ref={ringRef} style={{position:'relative'}}>
        <div style={{
          fontFamily:'var(--mono)', fontSize:10, letterSpacing:'.18em',
          color:'var(--ink-3)', textTransform:'uppercase', marginBottom:6,
        }}>当前价 · CURRENT</div>
        <div key={lastBidId} style={{
          position:'relative', display:'flex', alignItems:'baseline', gap:4,
          animation: lastBidId ? 'priceFlash 0.6s ease-out' : 'none',
        }}>
          <span style={{
            fontFamily:'var(--display)', fontSize:28, fontWeight:500,
            color:'var(--ink-2)', lineHeight:1,
          }}>¥</span>
          <span style={{
            fontFamily:'var(--display)', fontSize:44, fontWeight:700,
            letterSpacing:'-0.02em',
            color: hot ? 'var(--hot)' : 'var(--ink-1)',
            fontVariantNumeric:'tabular-nums',
            lineHeight:1,
            transition:'color .25s',
          }}>{Math.round(shown/100).toLocaleString('zh-CN')}</span>
          {went > 0 && (
            <span key={lastBidId + 'd'} style={{
              fontFamily:'var(--mono)', fontSize:11, color:'var(--jade)',
              marginLeft:6, opacity:0,
              animation:'deltaFloat 1.2s ease-out forwards',
            }}>+{fmtYenSmall(went)}</span>
          )}
        </div>
        <div style={{marginTop:8, display:'flex', alignItems:'center', gap:8}}>
          {leader ? (
            <>
              <span style={{
                width:18, height:18, borderRadius:'50%',
                background: leader.color, flexShrink:0,
                border:'1px solid rgba(255,255,255,.18)',
                boxShadow: youAreLeader ? '0 0 0 2px var(--jade), 0 0 16px var(--jade)' : 'none',
              }} />
              <span style={{
                fontSize:12, color: youAreLeader ? 'var(--jade)' : 'var(--ink-2)',
                fontWeight: youAreLeader ? 600 : 500,
              }}>
                {youAreLeader ? '你领先 · YOU LEAD' : `${leader.name} 领先`}
              </span>
            </>
          ) : (
            <span style={{fontSize:12, color:'var(--ink-3)'}}>等待首个出价…</span>
          )}
          {extendCount > 0 && (
            <span style={{
              marginLeft:'auto',
              display:'inline-flex', alignItems:'center', gap:4,
              padding:'2px 7px', borderRadius:999,
              background:'oklch(0.74 0.19 36 / .12)',
              border:'1px solid oklch(0.74 0.19 36 / .35)',
              fontFamily:'var(--mono)', fontSize:10,
              color:'var(--hot)', letterSpacing:'.06em',
              whiteSpace:'nowrap',
            }}>延长 ×{extendCount}</span>
          )}
        </div>
      </div>
      <CountdownRing remainMs={remainMs} totalMs={totalMs} />
      <style>{`
        @keyframes priceFlash {
          0%   { filter: brightness(2.4) drop-shadow(0 0 18px var(--hot-glow)); transform: scale(1.04); }
          40%  { filter: brightness(1.4) drop-shadow(0 0 8px var(--hot-glow)); transform: scale(1.01); }
          100% { filter: brightness(1) drop-shadow(0 0 0 transparent); transform: scale(1); }
        }
        @keyframes deltaFloat { 0%{opacity:0; transform:translateY(0)} 20%{opacity:1} 100%{opacity:0; transform:translateY(-22px)} }
      `}</style>
    </div>
  );
}

// ─────────────────── TOP 3 PODIUM ───────────────────
function TopThree({ ranked, leaderId }) {
  // ranked: array sorted desc by amount, already de-duped per user
  const podium = ranked.slice(0, 3);
  while (podium.length < 3) podium.push(null);
  const order = [1, 0, 2]; // visually: 2nd, 1st, 3rd
  const HEIGHTS = [82, 110, 64];
  const MEDALS = ['var(--gold)','var(--silver)','var(--bronze)'];
  return (
    <div style={{
      padding:'18px 20px 14px',
      borderBottom:'1px solid var(--line)',
    }}>
      <div style={{
        display:'flex', alignItems:'center', justifyContent:'space-between',
        marginBottom:10,
      }}>
        <span style={{
          fontFamily:'var(--mono)', fontSize:10, letterSpacing:'.18em',
          color:'var(--ink-3)', textTransform:'uppercase',
        }}>TOP 3 · 竞拍榜</span>
        <span style={{ fontFamily:'var(--mono)', fontSize:10, color:'var(--ink-4)' }}>
          {ranked.length} bidders
        </span>
      </div>
      <div style={{
        display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:10,
        alignItems:'end', height: 132,
      }}>
        {order.map((rIdx, col) => {
          const entry = podium[rIdx];
          const u = entry ? userById(entry.userId) : null;
          const isMe = entry && entry.userId === 'me';
          const h = HEIGHTS[rIdx];
          return (
            <div key={col} style={{display:'flex', flexDirection:'column', alignItems:'center', gap:6}}>
              {entry ? (
                <>
                  <div style={{
                    width:32, height:32, borderRadius:'50%',
                    background: u.color,
                    display:'grid', placeItems:'center',
                    fontFamily:'var(--display)', fontSize:13, fontWeight:700,
                    color:'#0c0a14',
                    boxShadow: isMe ? `0 0 0 2px var(--jade), 0 0 18px var(--jade)` : `0 0 0 2px ${MEDALS[rIdx]}`,
                    position:'relative',
                  }}>
                    {u.name[0]}
                    <span style={{
                      position:'absolute', top:-6, right:-8,
                      fontFamily:'var(--display)', fontSize:11, fontWeight:700,
                      width:18, height:18, borderRadius:'50%',
                      background: MEDALS[rIdx], color:'#0c0a14',
                      display:'grid', placeItems:'center',
                      border:'1.5px solid var(--bg-room)',
                    }}>{rIdx + 1}</span>
                  </div>
                  <div style={{
                    fontSize:11, color: isMe ? 'var(--jade)' : 'var(--ink-2)',
                    fontWeight: isMe ? 600 : 500,
                  }}>{isMe ? '我' : u.name}</div>
                  <div style={{
                    height: h,
                    width: '100%',
                    borderRadius:'8px 8px 4px 4px',
                    background: rIdx === 0
                      ? 'linear-gradient(180deg, oklch(0.86 0.14 86 / .55), oklch(0.5 0.13 86 / .3))'
                      : rIdx === 1
                      ? 'linear-gradient(180deg, rgba(245,241,234,.25), rgba(245,241,234,.08))'
                      : 'linear-gradient(180deg, oklch(0.68 0.10 50 / .4), oklch(0.4 0.08 50 / .15))',
                    border:'1px solid var(--line-2)',
                    display:'flex', flexDirection:'column', justifyContent:'center', alignItems:'center', gap:2,
                    transition: 'height .4s ease',
                  }}>
                    <span style={{
                      fontFamily:'var(--display)', fontSize:13, fontWeight:700,
                      color: 'var(--ink-1)', fontVariantNumeric:'tabular-nums',
                    }}>{fmtYen(entry.amountCents)}</span>
                    <span style={{
                      fontFamily:'var(--mono)', fontSize:9, color:'var(--ink-3)',
                      letterSpacing:'.04em',
                    }}>seq {entry.seq}</span>
                  </div>
                </>
              ) : (
                <>
                  <div style={{
                    width:32, height:32, borderRadius:'50%',
                    border:'1px dashed var(--line-2)',
                  }} />
                  <div style={{fontSize:11, color:'var(--ink-4)'}}>—</div>
                  <div style={{
                    height: h, width:'100%',
                    borderRadius:'8px 8px 4px 4px',
                    border:'1px dashed var(--line-2)',
                  }} />
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────── LIVE FEED ───────────────────
function LiveFeed({ events }) {
  return (
    <div style={{
      padding:'10px 20px 4px',
      maxHeight: 96, overflow:'hidden',
      position:'relative',
      WebkitMaskImage: 'linear-gradient(180deg, transparent 0%, #000 22%, #000 100%)',
      maskImage: 'linear-gradient(180deg, transparent 0%, #000 22%, #000 100%)',
    }}>
      <div style={{display:'flex', flexDirection:'column', gap:4}}>
        {events.slice(0, 6).map((e, i) => (
          <FeedRow key={e.id} e={e} fresh={i === 0} />
        ))}
      </div>
    </div>
  );
}
function FeedRow({ e, fresh }) {
  const u = e.userId ? userById(e.userId) : null;
  return (
    <div style={{
      display:'flex', alignItems:'center', gap:8,
      fontFamily:'var(--body)', fontSize:12, color:'var(--ink-2)',
      animation: fresh ? 'feedIn .35s ease-out' : 'none',
    }}>
      {u ? (
        <span style={{
          width:14, height:14, borderRadius:'50%', background:u.color,
          border:'1px solid rgba(255,255,255,.18)', flexShrink:0,
        }} />
      ) : (
        <span style={{
          width:14, height:14, borderRadius:3,
          background:'var(--line-2)', color:'var(--ink-3)',
          fontFamily:'var(--mono)', fontSize:9, display:'grid', placeItems:'center',
        }}>i</span>
      )}
      <span style={{flex:1, minWidth:0, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>
        {e.kind === 'bid' && (
          <>
            <b style={{color: u?.id === 'me' ? 'var(--jade)' : 'var(--ink-1)', fontWeight:600}}>
              {u?.id === 'me' ? '你' : u?.name}
            </b>
            <span> 出价 </span>
            <span style={{fontFamily:'var(--mono)', color:'var(--ink-1)'}}>{fmtYen(e.amount)}</span>
          </>
        )}
        {e.kind === 'extend' && <span style={{color:'var(--hot)'}}>⏱ 延长 +{e.sec}s · auction extended</span>}
        {e.kind === 'sold' && <span style={{color:'var(--gold)', fontWeight:600}}>🔨 落锤 · sold to {userById(e.userId).name} @ {fmtYen(e.amount)}</span>}
        {e.kind === 'reject' && <span style={{color:'var(--ink-3)'}}>{e.text}</span>}
      </span>
      <span style={{fontFamily:'var(--mono)', fontSize:10, color:'var(--ink-4)'}}>seq {e.seq}</span>
      <style>{`
        @keyframes feedIn { from{opacity:0; transform:translateY(6px)} to{opacity:1; transform:translateY(0)} }
      `}</style>
    </div>
  );
}

// ─────────────────── BID BUTTONS ───────────────────
function BidButtons({ onBid, current, mode, disabled, registerRef, audience, openCustom, hotBeat }) {
  const labels = QUICK_LABELS[mode];
  const computeNext = (key) => nextAmount(current, mode, key);
  const cap = RULES.capCents;
  return (
    <div style={{
      padding:'14px 20px 20px',
      display:'flex', flexDirection:'column', gap:10,
      background:'linear-gradient(180deg, var(--bg-room) 0%, #0a0813 100%)',
    }}>
      {audience === 'seller' ? (
        <SellerControls disabled={disabled} />
      ) : (
        <>
          <div style={{display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:8}}>
            {['p1','p5','p10'].map((k) => {
              const next = computeNext(k);
              const willHitCap = next >= cap && current < cap;
              return (
                <BidChip
                  key={k}
                  ref={(el) => registerRef(k, el)}
                  label={labels[k]}
                  sub={fmtYen(next)}
                  disabled={disabled || current >= cap}
                  emphasis={willHitCap ? 'cap' : (k === 'p10' ? 'strong' : 'normal')}
                  onClick={() => onBid(next, k)}
                />
              );
            })}
          </div>
          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:8}}>
            <BidChip
              ref={(el) => registerRef('max', el)}
              label="MAX 封顶"
              sub={fmtYen(cap)}
              disabled={disabled || current >= cap}
              emphasis="max"
              onClick={() => onBid(cap, 'max')}
            />
            <BidChip
              ref={(el) => registerRef('custom', el)}
              label="自定义 ▾"
              sub="custom"
              emphasis="ghost"
              disabled={disabled}
              onClick={openCustom}
            />
          </div>
          <HammerHint hotBeat={hotBeat} disabled={disabled} />
        </>
      )}
    </div>
  );
}
function HammerHint({ hotBeat, disabled }) {
  if (disabled) return null;
  return (
    <div style={{
      display:'flex', alignItems:'center', justifyContent:'center', gap:8,
      fontFamily:'var(--mono)', fontSize:10, color:'var(--ink-3)',
      letterSpacing:'.1em',
    }}>
      <span style={{
        width:6, height:6, borderRadius:'50%', background:'var(--hot)',
        animation: hotBeat ? 'hotBeat 0.6s ease-out' : 'none',
        boxShadow:'0 0 10px var(--hot-glow)',
      }} />
      <span>BACKEND IS AUTHORITATIVE · 最终价以服务端 seq 为准</span>
      <style>{`@keyframes hotBeat { 0%{transform:scale(.6)} 50%{transform:scale(1.6)} 100%{transform:scale(1)} }`}</style>
    </div>
  );
}
const BidChip = React.forwardRef(function BidChip({ label, sub, disabled, emphasis, onClick }, ref) {
  const [press, setPress] = useState(false);
  const styles = {
    normal: {
      bg: 'rgba(245,241,234,.05)', bord: 'var(--line-2)',
      labelColor: 'var(--ink-1)', subColor: 'var(--ink-3)',
    },
    strong: {
      bg: 'linear-gradient(180deg, oklch(0.74 0.19 36 / .9), oklch(0.62 0.21 28 / .85))',
      bord: 'oklch(0.74 0.19 36)',
      labelColor: '#fff', subColor: 'rgba(255,255,255,.85)',
    },
    cap: {
      bg: 'linear-gradient(180deg, oklch(0.86 0.14 86 / .25), oklch(0.6 0.13 86 / .15))',
      bord: 'var(--gold)',
      labelColor: 'var(--gold)', subColor: 'rgba(245,241,234,.7)',
    },
    max: {
      bg: 'linear-gradient(180deg, oklch(0.86 0.14 86 / .9), oklch(0.7 0.16 70 / .8))',
      bord: 'var(--gold)',
      labelColor: '#0c0a14', subColor: 'rgba(12,10,20,.7)',
    },
    ghost: {
      bg: 'transparent', bord: 'var(--line-2)',
      labelColor: 'var(--ink-2)', subColor: 'var(--ink-4)',
    },
  }[emphasis] || {};
  return (
    <button
      ref={ref}
      onClick={onClick}
      onPointerDown={() => setPress(true)}
      onPointerUp={() => setPress(false)}
      onPointerLeave={() => setPress(false)}
      disabled={disabled}
      style={{
        appearance:'none', border:`1px solid ${styles.bord}`,
        background: styles.bg,
        borderRadius:12,
        padding:'10px 12px',
        display:'flex', flexDirection:'column', alignItems:'flex-start', gap:2,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? .45 : 1,
        transform: press && !disabled ? 'scale(.96)' : 'scale(1)',
        transition: 'transform .12s ease, box-shadow .15s ease',
        boxShadow: emphasis === 'strong' || emphasis === 'max'
          ? '0 8px 22px -8px oklch(0.66 0.22 28 / .6)'
          : 'none',
      }}>
      <span style={{
        fontFamily:'var(--display)', fontSize:15, fontWeight:700,
        color: styles.labelColor, lineHeight:1,
      }}>{label}</span>
      <span style={{
        fontFamily:'var(--mono)', fontSize:10, color: styles.subColor,
        letterSpacing:'.04em',
      }}>{sub}</span>
    </button>
  );
});
function SellerControls({ disabled }) {
  return (
    <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:8}}>
      <button style={btnGhost} disabled={disabled}>
        <span style={{fontFamily:'var(--display)', fontWeight:600}}>提前落锤</span>
        <span style={{fontFamily:'var(--mono)', fontSize:10, color:'var(--ink-3)'}}>Hammer now</span>
      </button>
      <button style={{...btnGhost, borderColor:'var(--hot)', color:'var(--hot)'}} disabled={disabled}>
        <span style={{fontFamily:'var(--display)', fontWeight:600}}>取消竞拍</span>
        <span style={{fontFamily:'var(--mono)', fontSize:10, color:'var(--hot)', opacity:.7}}>Cancel auction</span>
      </button>
    </div>
  );
}
const btnGhost = {
  appearance:'none', border:'1px solid var(--line-2)',
  background:'transparent', color:'var(--ink-1)',
  borderRadius:12, padding:'12px',
  display:'flex', flexDirection:'column', alignItems:'flex-start', gap:2,
  cursor:'pointer',
};

// ─────────────────── EXTEND PILL OVERLAY ───────────────────
function ExtendPill({ trigger }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!trigger) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 1400);
    return () => clearTimeout(t);
  }, [trigger]);
  if (!visible) return null;
  return (
    <div style={{
      position:'absolute', top: 80, left:'50%',
      transform:'translateX(-50%)',
      zIndex: 60,
      padding:'8px 16px', borderRadius: 999,
      background:'linear-gradient(135deg, oklch(0.74 0.19 36), oklch(0.6 0.21 24))',
      color:'#fff',
      fontFamily:'var(--display)', fontWeight:700, fontSize:14,
      boxShadow:'0 12px 36px oklch(0.6 0.22 28 / .5)',
      display:'flex', alignItems:'center', gap:8,
      animation: 'extendIn .9s cubic-bezier(.18,.89,.32,1.28)',
    }}>
      <span style={{fontSize:16}}>⏱</span>
      <span>+{RULES.extendMs/1000}s · 反狙击延长</span>
      <style>{`
        @keyframes extendIn {
          0%{opacity:0; transform:translateX(-50%) translateY(-12px) scale(.6)}
          60%{opacity:1; transform:translateX(-50%) translateY(0) scale(1.08)}
          100%{transform:translateX(-50%) translateY(0) scale(1)}
        }
      `}</style>
    </div>
  );
}

// ─────────────────── TERMINAL OVERLAY ───────────────────
function TerminalOverlay({ terminal, winner, amount }) {
  if (!terminal) return null;
  const u = winner ? userById(winner) : null;
  const labelByKind = {
    SOLD: { big: '已售出', sub: 'SOLD', tint: 'var(--gold)' },
    NO_BID: { big: '流拍', sub: 'NO BID', tint: 'var(--ink-3)' },
    CANCELLED: { big: '已取消', sub: 'CANCELLED', tint: 'var(--hot)' },
  };
  const cfg = labelByKind[terminal];
  return (
    <div style={{
      position:'absolute', inset:0, zIndex:40,
      background:'radial-gradient(ellipse 80% 60% at 50% 35%, rgba(12,10,20,.4) 0%, rgba(12,10,20,.85) 60%)',
      backdropFilter:'blur(2px)',
      display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
      animation:'fadeUp .6s ease-out',
      pointerEvents:'none',
    }}>
      <div style={{
        fontFamily:'var(--mono)', fontSize:11, letterSpacing:'.32em',
        color: cfg.tint,
        marginBottom:6,
      }}>{cfg.sub}</div>
      <div style={{
        fontFamily:'var(--display)', fontWeight:700, fontSize:64,
        color: cfg.tint, lineHeight:1, letterSpacing:'-0.02em',
        textShadow: `0 0 40px ${cfg.tint}`,
      }}>{cfg.big}</div>
      {terminal === 'SOLD' && u && (
        <div style={{
          marginTop:18, display:'flex', alignItems:'center', gap:10,
          background:'rgba(12,10,20,.7)', border:'1px solid var(--line-2)',
          borderRadius:14, padding:'10px 16px',
        }}>
          <span style={{
            width:28, height:28, borderRadius:'50%', background: u.color,
            display:'grid', placeItems:'center',
            fontFamily:'var(--display)', fontWeight:700, color:'#0c0a14',
          }}>{u.name[0]}</span>
          <div style={{display:'flex', flexDirection:'column'}}>
            <span style={{fontFamily:'var(--display)', fontWeight:600, fontSize:14, color:'var(--ink-1)'}}>
              {winner === 'me' ? '你赢了！' : `${u.name} 拿下`}
            </span>
            <span style={{fontFamily:'var(--mono)', fontSize:11, color:'var(--gold)'}}>
              @ {fmtYen(amount)}
            </span>
          </div>
        </div>
      )}
      <style>{`@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}`}</style>
    </div>
  );
}

// ─────────────────── CUSTOM AMOUNT DRAWER ───────────────────
function CustomDrawer({ open, current, onSubmit, onClose }) {
  const [val, setVal] = useState('');
  useEffect(() => { if (open) setVal(''); }, [open]);
  if (!open) return null;
  const numericCents = Math.max(0, parseInt((val || '0').replace(/\D/g, ''), 10)) * 100;
  const valid = numericCents > current && numericCents <= RULES.capCents;
  return (
    <div onClick={onClose} style={{
      position:'absolute', inset:0, zIndex:70,
      background:'rgba(7,6,10,.6)', backdropFilter:'blur(8px)',
      display:'flex', alignItems:'flex-end',
      animation:'fadeUp .25s ease-out',
    }}>
      <div onClick={(e)=>e.stopPropagation()} style={{
        width:'100%',
        background:'var(--bg-room)',
        borderTop:'1px solid var(--line-2)',
        borderRadius:'24px 24px 0 0',
        padding:'18px 20px 20px',
        animation:'sheetIn .35s cubic-bezier(.18,.89,.32,1.28)',
      }}>
        <div style={{
          width:40, height:4, borderRadius:2,
          background:'var(--line-2)', margin:'0 auto 14px',
        }} />
        <div style={{fontFamily:'var(--display)', fontWeight:600, fontSize:16, marginBottom:4}}>自定义出价</div>
        <div style={{fontFamily:'var(--mono)', fontSize:11, color:'var(--ink-3)', marginBottom:14}}>
          须高于 {fmtYen(current)} · 不得超过 {fmtYen(RULES.capCents)}
        </div>
        <div style={{
          display:'flex', alignItems:'center', gap:8,
          background:'rgba(245,241,234,.04)', border:'1px solid var(--line-2)',
          borderRadius:14, padding:'12px 14px',
        }}>
          <span style={{fontFamily:'var(--display)', fontSize:22, fontWeight:500, color:'var(--ink-2)'}}>¥</span>
          <input
            inputMode="numeric" pattern="[0-9]*"
            autoFocus
            value={val}
            onChange={(e) => setVal(e.target.value.replace(/[^\d]/g, ''))}
            placeholder={Math.round(current/100 + 100).toLocaleString('zh-CN')}
            style={{
              flex:1, background:'transparent', border:0, outline:'none', color:'var(--ink-1)',
              fontFamily:'var(--display)', fontSize:22, fontWeight:600,
              fontVariantNumeric:'tabular-nums',
            }}
          />
        </div>
        <div style={{display:'grid', gridTemplateColumns:'1fr 2fr', gap:10, marginTop:14}}>
          <button style={btnGhost} onClick={onClose}>
            <span style={{fontFamily:'var(--display)', fontWeight:600}}>取消</span>
          </button>
          <button
            disabled={!valid}
            onClick={() => onSubmit(numericCents)}
            style={{
              ...btnGhost,
              background: valid
                ? 'linear-gradient(180deg, oklch(0.74 0.19 36), oklch(0.62 0.21 28))'
                : 'rgba(245,241,234,.06)',
              borderColor: valid ? 'oklch(0.74 0.19 36)' : 'var(--line-2)',
              color: valid ? '#fff' : 'var(--ink-3)',
              alignItems:'center', flexDirection:'row', justifyContent:'center',
              opacity: valid ? 1 : .55,
            }}>
            <span style={{fontFamily:'var(--display)', fontWeight:700}}>
              出价 {valid ? fmtYen(numericCents) : ''}
            </span>
          </button>
        </div>
        <style>{`
          @keyframes sheetIn { from{transform:translateY(100%)} to{transform:translateY(0)} }
        `}</style>
      </div>
    </div>
  );
}

// ─────────────────── PARTICLE LAYER ───────────────────
function ParticleLayer({ particles, onRetire }) {
  return (
    <>{particles.map(p => (
      <BidParticle
        key={p.id} fromRect={p.from} toRect={p.to}
        label={p.label} color={p.color}
        onDone={() => onRetire(p.id)} />
    ))}</>
  );
}


// Export to window for app.jsx
Object.assign(window, {
  RULES, fmtYen, fmtYenSmall, BOTS, ME, userById, nextAmount, QUICK_LABELS,
  VideoStage, FactChip, PriceCore, TopThree, LiveFeed, FeedRow, BidButtons, HammerHint,
  BidChip, SellerControls, btnGhost, ExtendPill, TerminalOverlay, CustomDrawer, ParticleLayer,
});
