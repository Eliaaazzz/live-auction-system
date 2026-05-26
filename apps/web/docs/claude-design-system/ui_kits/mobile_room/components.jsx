/* global React */
const { useState, useEffect, useRef } = React;

/* ============ Small primitives ============ */

function MoneyMono({ value, currency = "¥", className = "", style }) {
  const formatted = value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return <span className={"t-mono-money " + className} style={style}>{currency}{formatted}</span>;
}

function SeqMono({ value, className = "" }) {
  return <span className={"t-mono-seq " + className}>#{value}</span>;
}

function Chip({ kind = "live", children }) {
  return <span className={"chip chip--" + kind}>{children}</span>;
}

/* ============ Phone status bar (iOS-ish) ============ */
function PhoneStatusBar({ dark = true }) {
  const color = dark ? "#fff" : "#0A1F44";
  return (
    <div className="status-bar" style={{ color }}>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>20:48</span>
      <span className="sb-right">
        <svg width="16" height="11" viewBox="0 0 16 11" fill={color}><path d="M0 8h2v3H0V8zm4-2h2v5H4V6zm4-2h2v7H8V4zm4-2h2v9h-2V2z"/></svg>
        <svg width="14" height="11" viewBox="0 0 14 11" fill="none" stroke={color} strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"><path d="M1 5a8 8 0 0 1 12 0M3 7a5 5 0 0 1 8 0M7 9.5l.01 0"/></svg>
        <svg width="26" height="12" viewBox="0 0 26 12" fill="none"><rect x="0.5" y="0.5" width="22" height="11" rx="3" stroke={color}/><rect x="23.5" y="3.5" width="2" height="5" rx="1" fill={color}/><rect x="2" y="2" width="18" height="8" rx="1.5" fill={color}/></svg>
      </span>
    </div>
  );
}

/* ============ Hourglass / status icons ============ */
function HourglassIcon({ size = 18, color = "currentColor", spinning = false }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={spinning ? { animation: "hourglass-flip 1s steps(2, end) infinite", transformOrigin: "center" } : null}>
      <path d="M6 2h12"/><path d="M6 22h12"/>
      <path d="M6 2v4a6 6 0 0 0 12 0V2"/>
      <path d="M6 22v-4a6 6 0 0 1 12 0v4"/>
    </svg>
  );
}

function HammerIcon({ size = 24, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 4.5l5 5"/>
      <path d="M12.5 6.5l-8 8a1.5 1.5 0 0 0 0 2.12l1.38 1.38a1.5 1.5 0 0 0 2.12 0l8-8"/>
      <path d="M9 11l4 4"/>
      <path d="M4 21h12"/>
      <path d="M16.5 2.5l5 5"/>
    </svg>
  );
}

/* ============ Leaderboard row ============ */
function LeaderRow({ rank, name, sub, bid, av, variant }) {
  return (
    <div className={"lrow" + (variant ? " " + variant : "")}>
      <div className="rank">{rank}</div>
      <div className="av">{av}</div>
      <div className="nm">{name}{sub && <small>{sub}</small>}</div>
      <div className="bd">¥{bid.toLocaleString("en-US")}</div>
    </div>
  );
}

/* ============ In-room toast ============ */
function Toast({ kind = "rej", code, children }) {
  return (
    <div className={"in-toast " + kind}>
      <span className="code">{code}</span>
      <span>{children}</span>
    </div>
  );
}

/* ============ Connection strip ============ */
function ConnectionStrip({ state }) {
  if (state === "connected") {
    return <div className="conn-strip"><span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--sem-info)" }}></span><span className="lbl ok">CONNECTED</span><span style={{ color: "var(--ink-text-muted)" }}>seq #14998 · Δ 42ms</span><span className="meta">push</span></div>;
  }
  if (state === "reconnecting") {
    return <div className="conn-strip warn"><HourglassIcon size={14} color="var(--sem-extended)" spinning /><span className="lbl warn">RECONNECTING</span><span style={{ color: "var(--ink-text-muted)" }}>last #14998 · try 2/3</span><span className="meta">5s</span></div>;
  }
  if (state === "syncing") {
    return <div className="conn-strip sync"><HourglassIcon size={14} color="var(--sem-info)" spinning /><span className="lbl sync">SYNCING</span><span style={{ color: "var(--ink-text-muted)" }}>#14922 → #14998 · 76 ev</span><span className="meta">catchup</span></div>;
  }
  if (state === "schema") {
    return <div className="conn-strip sch"><span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--sem-live)" }}></span><span className="lbl sch">SCHEMA_MISMATCH</span><span style={{ color: "var(--ink-text-muted)" }}>v0.4 ≠ v0.5</span><span className="meta">REFRESH</span></div>;
  }
  if (state === "mini") {
    return <div className="conn-strip" style={{ background: "rgba(184,138,90,0.16)", borderColor: "rgba(184,138,90,0.5)" }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--solemn-gold-soft)" }}></span>
      <span className="lbl" style={{ color: "var(--solemn-gold-soft)", fontFamily: "var(--font-sans)", fontWeight: 700, letterSpacing: "0.16em", fontSize: 10 }}>MINI-PROGRAM</span>
      <span style={{ color: "var(--ink-text-muted)" }}>open in Douyin · H5 limited</span>
      <span className="meta">↗</span>
    </div>;
  }
  return null;
}

/* ============ Bid wheel overlay ============ */
function BidWheel({ selected = "x10", onClose }) {
  const steps = [
    { id: "x1", label: "+1×", delta: 100, cls: "t-x1" },
    { id: "x2", label: "+2×", delta: 200, cls: "t-x2" },
    { id: "x5", label: "+5×", delta: 500, cls: "t-x5" },
    { id: "x10", label: "+10×", delta: 1000, cls: "t-x10" },
  ];
  const sel = steps.find(s => s.id === selected);
  return (
    <div className="bid-wheel-overlay" onClick={onClose}>
      <div className="stage">
        <div className="ring"></div>
        {steps.map(s => (
          <span key={s.id} className={"tag " + s.cls + (s.id === selected ? " sel" : "")}>{s.label}</span>
        ))}
        <div className="core">
          <div className="price">¥{(12800 + sel.delta).toLocaleString("en-US")}</div>
          <div className="sub">RELEASE</div>
        </div>
        <div className="hint">drag to choose · release to bid</div>
      </div>
    </div>
  );
}

/* ============ Curtain wipe element ============ */
function CurtainWipe({ active }) {
  return <div className={"curtain-wipe" + (active ? " active" : "")}></div>;
}

Object.assign(window, { MoneyMono, SeqMono, Chip, PhoneStatusBar, HourglassIcon, HammerIcon, LeaderRow, Toast, ConnectionStrip, BidWheel, CurtainWipe });
