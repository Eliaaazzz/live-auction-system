// src/components/TweaksPanel.jsx
//
// Dev-only state/tuning panel. Activated by `?tweaks=1` query param on
// any route. Lets us force-trigger demo states (final-10s pulse, anti-
// snipe sweep, terminal overlays, reconnecting banner) without running
// a real auction — useful for screenshot capture, demo rehearsals, and
// catching regressions in UI states that backend won't naturally hit
// during a 30s smoke run.
//
// Per #56 ratify (PDGGK 2026-05-27): port only the `?tweaks=1` pattern
// from the C round-2 prototype. Aesthetic stays neutral mono — does not
// adopt Space Grotesk / lava-orange from the C prototype.
//
// Mounted at root in App.jsx with a query-param check. Never bundles
// into the user-facing flow because the gate is checked at mount.

import React from 'react';
import { useAuctionStore } from '../store/auction.js';
import { ConnStatus } from '../lib/types.js';

/** Reads the `tweaks` query param. Memoizes on first call. */
let _enabled = null;
export function tweaksEnabled() {
  if (_enabled !== null) return _enabled;
  if (typeof window === 'undefined') return false;
  _enabled = new URLSearchParams(window.location.search).get('tweaks') === '1';
  return _enabled;
}

/** Reset the memoized enabled flag — used by tests. */
export function _resetTweaksEnabledForTests() {
  _enabled = null;
}

const STATUSES = ['LIVE', 'SOLD', 'NO_BID', 'CANCELLED', 'SCHEDULED', 'DRAFT'];
const CONN_STATES = [
  ConnStatus.OPEN,
  ConnStatus.CONNECTING,
  ConnStatus.RECONNECTING,
  ConnStatus.SYNCING,
  ConnStatus.SCHEMA,
];
const TIME_PRESETS = [
  { label: '5min',       ms: 300_000 },
  { label: 'final-30s',  ms: 28_400 },
  { label: 'final-10s',  ms: 8_210 },
  { label: 'final-3s',   ms: 2_900 },
  { label: 'expired',    ms: 0 },
];

export function TweaksPanel() {
  // Hooks always run — visibility gated by the early return below so the
  // panel only ever renders when the query flag is set. The store
  // subscription is cheap (single slice).
  const status = useAuctionStore((s) => s.status);
  const connStatus = useAuctionStore((s) => s.connStatus);
  const extendCount = useAuctionStore((s) => s.extendCount);
  const currentCents = useAuctionStore((s) => s.currentCents);

  const [collapsed, setCollapsed] = React.useState(false);

  if (!tweaksEnabled()) return null;

  // Mutators — write directly to the store. These shortcut around the
  // applyEvent reducer because the panel's goal is "force this UI state
  // for demo capture," not "simulate the wire event." For wire-event
  // simulation see scripts/smoke-*.mjs.
  const setStatus = (s) => useAuctionStore.setState({ status: s });
  const setConn = (c) => useAuctionStore.setState({ connStatus: c });
  const setRemaining = (ms) => useAuctionStore.setState({ remainingMs: ms });
  const bumpExtend = () => useAuctionStore.setState((prev) => ({ extendCount: prev.extendCount + 1 }));
  const setCents = (c) => useAuctionStore.setState({ currentCents: c });

  return (
    <div
      role="region"
      aria-label="Dev tweaks panel"
      data-testid="tweaks-panel"
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 9999,
        width: collapsed ? 'auto' : 260,
        background: 'rgba(14, 16, 24, 0.96)',
        color: '#f5f5f7',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 10,
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        fontSize: 11,
        boxShadow: '0 10px 32px rgba(0,0,0,0.5)',
        padding: collapsed ? '8px 12px' : '12px 14px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: collapsed ? 0 : 10 }}>
        <span style={{ color: 'var(--douyin-cyan, #25F4EE)', fontWeight: 600, letterSpacing: '0.06em' }}>
          ⚙ TWEAKS
        </span>
        <span style={{ opacity: 0.5, fontSize: 10 }}>?tweaks=1</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          data-testid="tweaks-toggle"
          style={{
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.12)',
            color: 'inherit',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 10,
            padding: '2px 6px',
            borderRadius: 4,
          }}
        >
          {collapsed ? 'open' : 'fold'}
        </button>
      </div>

      {collapsed ? null : (
        <>
          {/* Status — flip terminal overlays / SCHEDULED / DRAFT */}
          <div style={{ marginBottom: 10 }}>
            <div style={tweakLabelStyle}>status · current: {status}</div>
            <div style={tweakRowStyle}>
              {STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  style={chipStyle(status === s)}
                  data-testid={`tweaks-status-${s}`}
                >{s}</button>
              ))}
            </div>
          </div>

          {/* remainingMs — force final-10s pulse, anti-snipe sweep, expired */}
          <div style={{ marginBottom: 10 }}>
            <div style={tweakLabelStyle}>remainingMs</div>
            <div style={tweakRowStyle}>
              {TIME_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setRemaining(p.ms)}
                  style={chipStyle(false)}
                >{p.label}</button>
              ))}
            </div>
          </div>

          {/* connStatus — demo reconnecting banner / schema mismatch */}
          <div style={{ marginBottom: 10 }}>
            <div style={tweakLabelStyle}>connStatus · current: {connStatus}</div>
            <div style={tweakRowStyle}>
              {CONN_STATES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setConn(c)}
                  style={chipStyle(connStatus === c)}
                >{c}</button>
              ))}
            </div>
          </div>

          {/* extendCount — demo "已延时 ×N" badge growth */}
          <div style={{ marginBottom: 10 }}>
            <div style={tweakLabelStyle}>extendCount · {extendCount}</div>
            <div style={tweakRowStyle}>
              <button type="button" onClick={bumpExtend} style={chipStyle(false)}>+1</button>
              <button type="button" onClick={() => useAuctionStore.setState({ extendCount: 0 })} style={chipStyle(false)}>reset</button>
            </div>
          </div>

          {/* currentCents — force the price for screenshot framing */}
          <div>
            <div style={tweakLabelStyle}>currentCents · {currentCents}</div>
            <div style={tweakRowStyle}>
              <button type="button" onClick={() => setCents('100')} style={chipStyle(false)}>¥1</button>
              <button type="button" onClick={() => setCents('12880000')} style={chipStyle(false)}>¥128,800</button>
              <button type="button" onClick={() => setCents('9000000000000000')} style={chipStyle(false)}>9e15 (max)</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const tweakLabelStyle = {
  color: 'rgba(245,245,247,0.55)',
  marginBottom: 4,
  fontSize: 10,
  letterSpacing: '0.04em',
};

const tweakRowStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
};

const chipStyle = (active) => ({
  background: active ? 'var(--douyin-cyan, #25F4EE)' : 'rgba(255,255,255,0.06)',
  color: active ? '#0a0a14' : '#f5f5f7',
  border: active ? '1px solid var(--douyin-cyan, #25F4EE)' : '1px solid rgba(255,255,255,0.1)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 10,
  padding: '3px 7px',
  borderRadius: 4,
});

export default TweaksPanel;
