import { useEffect, useRef, useState } from 'react';
import { App as AntdApp, Button } from 'antd';
import { ThunderboltOutlined, StopOutlined } from '@ant-design/icons';
import { api } from '../../backend/lib/api.js';
import { ensureSession } from '../../backend/lib/auth.js';
import { auctionToLot, type BackendAuction } from '../../lib/mapBackend';
import { PROD } from '../../lib/assets';
import { useAuctionEngine } from '../../lib/useAuctionEngine';
import type { Lot } from '../../lib/types';
import { fmtMoney, fmtCompact } from '../../lib/format';

// The ten-thousand-user concurrency demo (its own page): this moves the server-side crowd simulator
// out of the live room. The room now has it off by default (LUMEN_DEMO_CROWD=0, so simulated bids no
// longer run the price away); this page turns demoCrowd on for one dedicated load-test lot on demand
// and shows the concurrency and server metrics live. Bids still go through the real Lua adjudication.
const toAbs = (u: string): string => (u.startsWith('http') ? u : new URL(u, location.href).toString());
const yuanToCents = (y: number): string => String(Math.round(Number(y || 0) * 100));
const num = (x: unknown): number | null => (typeof x === 'number' && isFinite(x) ? x : null);
const kpiTone = (v: number | null, limit: number): string => (v == null ? '' : v <= limit ? 'green' : 'red');

export default function Concurrency() {
  const { message } = AntdApp.useApp();
  const [phase, setPhase] = useState<'idle' | 'starting' | 'running'>('idle');
  const [lot, setLot] = useState<Lot | null>(null);
  const [aid, setAid] = useState<string | null>(null);

  const start = async () => {
    if (phase === 'starting') return;
    setPhase('starting');
    try {
      await ensureSession('seller-demo');
      const { productId } = await api.createProduct({
        name: 'Concurrency load-test lot',
        imageUrl: toAbs(PROD.watch),
        description: 'For the admin concurrency demo only · the server-side crowd simulator injects ten thousand concurrent viewers and high-frequency bids',
      });
      const durationSec = 600;
      const { auctionId } = await api.createDraft({
        productId,
        factsConfirmed: true,
        confirmedFacts: { description: 'Concurrency load-test demo', category: 'Watches' },
        rules: {
          mode: 'ENGLISH',
          startPriceCents: '0',
          incrementCents: yuanToCents(50),
          capPriceCents: yuanToCents(99_999_999), // A very high cap: the demo must never cap out and settle early
          durationSec,
          extendWindowSec: 10,
          extendSec: 0,
          maxExtensions: 0,
        },
      });
      await api.freeze(auctionId, { factsConfirmed: true });
      // demoCrowd:true explicitly enables the crowd simulator (overriding the global LUMEN_DEMO_CROWD=0),
      // so only this one session gets the ten-thousand-user injection.
      await api.startLive(auctionId, { durationMs: durationSec * 1000, demoCrowd: true });
      const a = (await api.getAuction(auctionId)) as BackendAuction;
      setLot(auctionToLot(a));
      setAid(auctionId);
      setPhase('running');
      message.success('The concurrency demo is running · the crowd simulator is injecting');
    } catch (e: any) {
      setPhase('idle');
      message.error('Failed to start: ' + (e?.message || String(e)));
    }
  };

  const stop = async () => {
    const id = aid;
    setPhase('idle');
    setLot(null);
    setAid(null);
    if (id) {
      try { await ensureSession('seller-demo'); await api.cancel(id, {}); } catch { /* any terminal state will do; ignore */ }
    }
  };

  return (
    <div className="conc-wrap">
      <div className="conc-head">
        <div className="conc-head-text">
          <div className="conc-title"><ThunderboltOutlined style={{ color: '#fe2c55' }} /> Ten-thousand-user concurrency demo</div>
          <div className="conc-sub">
            The server-side crowd simulator injects roughly <b>10,000</b> simulated concurrent viewers into one session, plus thousands of <b>rule-driven random bids</b> (down exactly the same Redis Lua atomic adjudication path a real person takes, with no faked seq or evidence chain).
            The live room has this off by default (so the price is no longer run away with); this page demonstrates the concurrency on its own, on demand.
          </div>
        </div>
        <div className="conc-actions">
          {phase !== 'running' ? (
            <Button type="primary" size="large" icon={<ThunderboltOutlined />} loading={phase === 'starting'} onClick={start}>
              Start the concurrency demo
            </Button>
          ) : (
            <Button danger size="large" icon={<StopOutlined />} onClick={stop}>End the demo</Button>
          )}
        </div>
      </div>

      {phase === 'running' && lot ? (
        <ConcDash key={aid ?? 'run'} lot={lot} />
      ) : (
        <div className="conc-empty">
          "Start the concurrency demo" creates a dedicated load-test lot and injects ten thousand concurrent users into it; the concurrency and server metrics below then tick live.
        </div>
      )}
    </div>
  );
}

type Hist = { p95?: number; P95?: number; count?: number; Count?: number };
type MetricsSnap = {
  ackLatencyMs?: Hist;
  broadcastLatencyMs?: Hist;
  activeConns?: number;
};

function ConcDash({ lot }: { lot: Lot }) {
  const { state, ready } = useAuctionEngine(lot, { running: true, nickname: 'seller-demo' });
  const [m, setM] = useState<MetricsSnap | null>(null);
  const [rate, setRate] = useState(0);
  const prev = useRef<{ t: number; bids: number } | null>(null);

  // The server's /metrics (the root route, public): ack/broadcast p95, active connections, accepted bids.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch('/metrics', { cache: 'no-store' });
        if (alive && r.ok) setM(await r.json());
      } catch { /* ignore a transient failure; the next tick retries */ }
    };
    tick();
    const id = setInterval(tick, 1500);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // The live bid rate: the derivative of the room's cumulative bid count over time (bids/s).
  useEffect(() => {
    const now = Date.now();
    const bids = state.bidCount ?? 0;
    if (prev.current) {
      const dt = (now - prev.current.t) / 1000;
      if (dt >= 0.4) {
        setRate(Math.max(0, (bids - prev.current.bids) / dt));
        prev.current = { t: now, bids };
      }
    } else {
      prev.current = { t: now, bids };
    }
  }, [state.bidCount]);

  // ack/broadcast p95 render only once there are samples (a count of 0 means no such request yet, so we
  // show a dash rather than a misleading 0). Simulated bids adjudicate straight through the store rather
  // than the HTTP/WS handler, so ack samples come from real bids; every broadcast frame is a sample.
  const ackCount = num(m?.ackLatencyMs?.count ?? m?.ackLatencyMs?.Count) ?? 0;
  const bcCount = num(m?.broadcastLatencyMs?.count ?? m?.broadcastLatencyMs?.Count) ?? 0;
  const ackP95 = ackCount > 0 ? num(m?.ackLatencyMs?.p95 ?? m?.ackLatencyMs?.P95) : null;
  const bcP95 = bcCount > 0 ? num(m?.broadcastLatencyMs?.p95 ?? m?.broadcastLatencyMs?.P95) : null;
  const conns = num(m?.activeConns);

  const cards: { k: string; v: string; s: string; tone: string }[] = [
    { k: 'Simulated concurrent viewers', v: fmtCompact(state.simViewers || 0), s: 'injected by the crowd simulator', tone: 'pink' },
    { k: 'Live bid rate', v: Math.round(rate).toLocaleString('en-US'), s: 'bids/s', tone: 'pink' },
    { k: 'Bids this session', v: (state.bidCount || 0).toLocaleString('en-US'), s: 'bids · adjudicated by Lua', tone: '' },
    { k: 'Current price', v: '¥' + fmtMoney(state.currentPrice || 0), s: 'starts at zero · live', tone: 'gold' },
    { k: 'Broadcast latency p95', v: bcP95 != null ? bcP95.toFixed(1) : '—', s: 'ms · target < 150', tone: kpiTone(bcP95, 150) },
    { k: 'Bid ack p95', v: ackP95 != null ? ackP95.toFixed(1) : '—', s: ackP95 != null ? 'ms · target < 80' : 'ms · awaiting a real bid', tone: kpiTone(ackP95, 80) },
    { k: 'Active WS connections', v: conns != null ? conns.toLocaleString('en-US') : '—', s: 'real long-lived connections (not simulated)', tone: '' },
    { k: 'Live likes', v: fmtCompact(state.likes || 0), s: 'viewer interactions', tone: '' },
  ];

  return (
    <>
      {!ready && <div className="conc-syncing">Syncing the auction snapshot and the concurrency frames…</div>}
      <div className="conc-grid">
        {cards.map((c) => (
          <div key={c.k} className={'conc-card' + (c.tone ? ' ' + c.tone : '')}>
            <div className="conc-card-k">{c.k}</div>
            <div className="conc-card-v tnum">{c.v}</div>
            <div className="conc-card-s">{c.s}</div>
          </div>
        ))}
      </div>
      <div className="conc-note">
        The simulated concurrency, the bids, and the price come from the room's live WebSocket frames; ack/broadcast p95, active connections, and accepted bids come from the server's <code>/metrics</code>.
        Every bid goes through real Redis Lua atomic adjudication — nothing is written in as a fake.
      </div>
    </>
  );
}
