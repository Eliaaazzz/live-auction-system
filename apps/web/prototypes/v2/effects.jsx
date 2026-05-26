// effects.jsx — Motion primitives for the auction room
// Exports to window:
//   useRollingNumber(value)   — returns the displayed value, eased toward target
//   <CountdownRing remainMs total />
//   <BidParticle from to amount onDone />
//   <ConfettiBurst onDone />
//   <ScreenShake on />     (applies a brief shake to the element it wraps)

const { useState, useEffect, useRef, useLayoutEffect } = React;

// ───────── easings ─────────
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeOutBack  = (t) => { const c = 1.70158; return 1 + c * Math.pow(t-1, 3) + c * Math.pow(t-1, 2); };

// ───────── rolling number ─────────
function useRollingNumber(target, ms = 520) {
  const [shown, setShown] = useState(target);
  const fromRef = useRef(target);
  const startRef = useRef(0);
  const rafRef = useRef(0);

  useEffect(() => {
    if (target === shown) return;
    fromRef.current = shown;
    startRef.current = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - startRef.current) / ms);
      const v = fromRef.current + (target - fromRef.current) * easeOutCubic(t);
      setShown(Math.round(v));
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  return shown;
}

// ───────── countdown ring ─────────
// Renders a circular progress ring with the seconds in the middle.
// remainMs < 10s → ring turns lava-orange and pulses.
function CountdownRing({ remainMs, totalMs, hot, size = 86, stroke = 5 }) {
  const pct = totalMs > 0 ? Math.max(0, Math.min(1, remainMs / totalMs)) : 0;
  const r = (size - stroke) / 2;
  const C = 2 * Math.PI * r;
  const offset = C * (1 - pct);
  const seconds = Math.max(0, remainMs / 1000);
  const danger = remainMs > 0 && remainMs < 10000;
  const color = danger || hot ? 'var(--hot)' : 'var(--ink-2)';
  return (
    <div style={{
      position:'relative', width:size, height:size,
      filter: danger ? `drop-shadow(0 0 12px var(--hot-glow))` : 'none',
      transition: 'filter .3s ease',
    }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}
           style={{ transform:'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r}
                fill="none" stroke="var(--line-2)" strokeWidth={stroke} />
        <circle cx={size/2} cy={size/2} r={r}
                fill="none" stroke={color} strokeWidth={stroke}
                strokeLinecap="round"
                strokeDasharray={C} strokeDashoffset={offset}
                style={{ transition: 'stroke-dashoffset .25s linear, stroke .25s linear' }} />
      </svg>
      <div style={{
        position:'absolute', inset:0,
        display:'flex', alignItems:'center', justifyContent:'center',
        flexDirection:'column', gap:0,
        animation: danger ? 'pulseSec 1s ease-in-out infinite' : 'none',
      }}>
        <span style={{
          fontFamily:'var(--display)', fontWeight:700,
          fontSize: 26, lineHeight:1,
          color: danger ? 'var(--hot)' : 'var(--ink-1)',
          fontVariantNumeric:'tabular-nums',
        }}>{seconds.toFixed(seconds < 10 ? 1 : 0)}</span>
        <span style={{
          fontFamily:'var(--mono)', fontSize:9, letterSpacing:'.12em',
          color:'var(--ink-3)', textTransform:'uppercase', marginTop:2,
        }}>{remainMs > 0 ? 'SEC LEFT' : 'ENDED'}</span>
      </div>
      <style>{`
        @keyframes pulseSec { 0%,100%{transform:scale(1)} 50%{transform:scale(1.08)} }
      `}</style>
    </div>
  );
}

// ───────── bid particle ─────────
// Floats a "+¥xx" label from `from` to `to` (both viewport-relative anchors).
function BidParticle({ fromRect, toRect, label, color, onDone }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !fromRect || !toRect) { onDone?.(); return; }
    const dx = (toRect.x + toRect.w/2) - (fromRect.x + fromRect.w/2);
    const dy = (toRect.y + toRect.h/2) - (fromRect.y + fromRect.h/2);
    const dur = 720 + Math.random() * 160;
    el.animate(
      [
        { transform:`translate(0,0) scale(.6)`, opacity: 0 },
        { transform:`translate(${dx*0.3}px, ${dy*0.3 - 24}px) scale(1.05)`, opacity: 1, offset: .25 },
        { transform:`translate(${dx*0.95}px, ${dy*0.95}px) scale(1)`, opacity: 1, offset: .85 },
        { transform:`translate(${dx}px, ${dy}px) scale(.4)`, opacity: 0 },
      ],
      { duration: dur, easing: 'cubic-bezier(.22,.61,.36,1)' }
    ).onfinish = () => onDone?.();
  }, []);
  if (!fromRect) return null;
  return (
    <div ref={ref} style={{
      position:'fixed', zIndex: 9000, pointerEvents:'none',
      left: fromRect.x + fromRect.w/2 - 28, top: fromRect.y + fromRect.h/2 - 14,
      fontFamily:'var(--display)', fontWeight:700, fontSize:18,
      color: color || 'var(--hot)',
      textShadow:'0 4px 24px rgba(0,0,0,.6)',
      width: 56, textAlign:'center',
    }}>{label}</div>
  );
}

// ───────── confetti burst ─────────
function ConfettiBurst({ on, anchor, onDone }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!on) return;
    const root = ref.current;
    if (!root) return;
    const N = 80;
    const colors = ['oklch(0.86 0.14 86)','oklch(0.74 0.19 36)','oklch(0.78 0.14 165)','#f5f1ea','oklch(0.66 0.2 320)'];
    for (let i = 0; i < N; i++) {
      const p = document.createElement('div');
      const sz = 6 + Math.random() * 6;
      const rot = Math.random() * 360;
      p.style.cssText = `
        position:absolute; left:50%; top:55%;
        width:${sz}px; height:${sz * (Math.random() < .5 ? .4 : 1)}px;
        background:${colors[i % colors.length]};
        border-radius:1px; transform:translate(-50%,-50%) rotate(${rot}deg);
      `;
      root.appendChild(p);
      const angle = -Math.PI/2 + (Math.random() - .5) * Math.PI * 1.2;
      const speed = 220 + Math.random() * 320;
      const dx = Math.cos(angle) * speed;
      const dy = Math.sin(angle) * speed;
      p.animate(
        [
          { transform: `translate(-50%,-50%) rotate(${rot}deg)`, opacity: 1 },
          { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy + 200}px)) rotate(${rot + 540}deg)`, opacity: 0 },
        ],
        { duration: 1400 + Math.random() * 600, easing: 'cubic-bezier(.16,.7,.3,1)' }
      ).onfinish = () => p.remove();
    }
    const t = setTimeout(() => onDone?.(), 2000);
    return () => clearTimeout(t);
  }, [on]);
  return (
    <div ref={ref} style={{
      position:'absolute', inset:0, pointerEvents:'none', zIndex:50, overflow:'hidden',
    }} />
  );
}

// ───────── heat meter ─────────
// Visualises bid intensity. `bps` = bids in trailing 5s.
function HeatMeter({ bps }) {
  const lvl = Math.min(1, bps / 8); // 8 bids/5s = max heat
  const segs = 12;
  const filled = Math.round(lvl * segs);
  return (
    <div style={{display:'flex', alignItems:'center', gap:8}}>
      <span style={{
        fontFamily:'var(--mono)', fontSize:10, color:'var(--ink-3)',
        textTransform:'uppercase', letterSpacing:'.14em',
      }}>HEAT</span>
      <div style={{display:'flex', gap:2}}>
        {Array.from({length: segs}).map((_, i) => {
          const lit = i < filled;
          const hueShift = i / segs; // 0 jade → 1 hot
          return (
            <div key={i} style={{
              width: 6, height: 14, borderRadius: 1.5,
              background: lit
                ? `oklch(${0.78 - hueShift*0.12} ${0.16 + hueShift*0.06} ${165 - hueShift*130})`
                : 'var(--line-2)',
              transition: 'background .25s',
            }} />
          );
        })}
      </div>
      <span style={{
        fontFamily:'var(--mono)', fontSize:10, color: lvl > .6 ? 'var(--hot)' : 'var(--ink-3)',
        fontVariantNumeric:'tabular-nums', minWidth: 28,
      }}>{bps.toFixed(1)}/s</span>
    </div>
  );
}

Object.assign(window, {
  useRollingNumber, CountdownRing, BidParticle, ConfettiBurst, HeatMeter,
});
