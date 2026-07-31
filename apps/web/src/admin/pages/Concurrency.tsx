import { useEffect, useRef, useState } from 'react';
import { App as AntdApp, Button } from 'antd';
import { ThunderboltOutlined, StopOutlined } from '@ant-design/icons';
import { api } from '../../backend/lib/api.js';
import { ensureSession } from '../../backend/lib/auth.js';
import { PROD } from '../../lib/assets';
import { fmtMoney, fmtCompact } from '../../lib/format';

// The ten-thousand-user concurrency demo (its own page): this moves the popularity-on-publish crowd
// simulator out of the live room. The room now has it off by default (LUMEN_DEMO_CROWD=0, so simulated
// bids no longer run the price away); this page turns demoCrowd:true on for one dedicated 60s load-test
// lot on demand (overriding the global switch) and shows the concurrency and server metrics live. Bids
// still go through real Lua atomic adjudication.
//
// The data comes from REST polling (not useAuctionEngine — its WS/ready is unstable on this one-shot lot):
//   GET /api/auctions/{id} hands back viewerCount (including the ~10k simulated) / currentPriceCents / seq / endAtMs;
//   root /metrics gives broadcast/ack p95 (note that simulated bids adjudicate straight through the store
//   and therefore do not count towards ack/bidsAccepted).
const DURATION_SEC = 60;
const toAbs = (u: string): string => (u.startsWith('http') ? u : new URL(u, location.href).toString());
const yuanToCents = (y: number): string => String(Math.round(Number(y || 0) * 100));
const num = (x: unknown): number | null => (typeof x === 'number' && isFinite(x) ? x : null);
const kpiTone = (v: number | null, limit: number): string => (v == null ? '' : v <= limit ? 'green' : 'red');
const TERMINAL = new Set(['SOLD', 'ORDER_CREATED', 'NO_BID', 'CANCELLED']);

export default function Concurrency() {
  const { message } = AntdApp.useApp();
  const [phase, setPhase] = useState<'idle' | 'starting' | 'running'>('idle');
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
      const { auctionId } = await api.createDraft({
        productId,
        factsConfirmed: true,
        confirmedFacts: { description: 'Concurrency load-test demo', category: 'Watches' },
        rules: {
          mode: 'ENGLISH',
          startPriceCents: '0',
          incrementCents: yuanToCents(50),
          capPriceCents: yuanToCents(99_999_999), // A very high cap: the demo must never cap out and settle early
          durationSec: DURATION_SEC,
          extendWindowSec: 10,
          extendSec: 0,
          maxExtensions: 0,
        },
      });
      await api.freeze(auctionId, { factsConfirmed: true });
      await api.startLive(auctionId, { durationMs: DURATION_SEC * 1000, demoCrowd: true });
      setAid(auctionId);
      setPhase('running');
      message.success('The concurrency demo is running · the crowd simulator is injecting (ten thousand within about 10s)');
    } catch (e: any) {
      setPhase('idle');
      message.error('Failed to start: ' + (e?.message || String(e)));
    }
  };

  const stop = async () => {
    const id = aid;
    setPhase('idle');
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
            The server-side crowd simulator injects roughly <b>10,000</b> simulated concurrent viewers into one session, plus thousands of <b>rule-driven random bids</b> (down
            exactly the same Redis Lua atomic adjudication path a real person takes, with no faked seq or evidence chain). The live room has this off by default (so the price is
            no longer run away with); this page demonstrates the concurrency on its own, on demand.
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

      {phase === 'running' && aid ? (
        <ConcDash key={aid} aid={aid} />
      ) : (
        <div className="conc-empty">
          "Start the concurrency demo" creates a dedicated {DURATION_SEC}s load-test lot and injects ten thousand concurrent users into it; the concurrency and server metrics below then tick live.
        </div>
      )}
    </div>
  );
}

type Hist = { p95?: number; P95?: number; count?: number; Count?: number };
type MetricsSnap = { ackLatencyMs?: Hist; broadcastLatencyMs?: Hist };
type Snap = {
  status?: string;
  viewerCount?: number;
  simViewerCount?: number;
  currentPriceCents?: string;
  likeCount?: number;
  endAtMs?: number;
  seq?: number;
};

function ConcDash({ aid }: { aid: string }) {
  const [snap, setSnap] = useState<Snap | null>(null);
  const [m, setM] = useState<MetricsSnap | null>(null);
  const [rate, setRate] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const prev = useRef<{ t: number; seq: number } | null>(null);

  // A 1s poll: the room snapshot (concurrency / price / seq / time left) plus root /metrics (p95).
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try { const a = (await api.getAuction(aid)) as Snap; if (alive) setSnap(a); } catch { /* retry on the next tick */ }
      try { const r = await fetch('/metrics', { cache: 'no-store' }); if (alive && r.ok) setM(await r.json()); } catch { /* ignore */ }
      if (alive) setNowMs(Date.now());
    };
    poll();
    const id = setInterval(poll, 1000);
    return () => { alive = false; clearInterval(id); };
  }, [aid]);

  // The bid rate: the derivative of seq over time (every bid/event is +1; stats frames carry no seq).
  useEffect(() => {
    const t = Date.now();
    const seq = snap?.seq ?? 0;
    if (prev.current) {
      const dt = (t - prev.current.t) / 1000;
      if (dt >= 0.6) { setRate(Math.max(0, (seq - prev.current.seq) / dt)); prev.current = { t, seq }; }
    } else {
      prev.current = { t, seq };
    }
  }, [snap?.seq]);

  const status = snap?.status;
  const ended = !!status && TERMINAL.has(status);
  const viewers = num(snap?.viewerCount) ?? 0;
  const price = snap?.currentPriceCents ? Math.round(Number(snap.currentPriceCents) / 100) : 0;
  const likes = num(snap?.likeCount) ?? 0;
  const seq = num(snap?.seq) ?? 0;
  const remainSec = snap?.endAtMs ? Math.max(0, Math.min(DURATION_SEC, Math.round((Number(snap.endAtMs) - nowMs) / 1000))) : DURATION_SEC;

  const ackCount = num(m?.ackLatencyMs?.count ?? m?.ackLatencyMs?.Count) ?? 0;
  const bcCount = num(m?.broadcastLatencyMs?.count ?? m?.broadcastLatencyMs?.Count) ?? 0;
  const ackP95 = ackCount > 0 ? num(m?.ackLatencyMs?.p95 ?? m?.ackLatencyMs?.P95) : null;
  const bcP95 = bcCount > 0 ? num(m?.broadcastLatencyMs?.p95 ?? m?.broadcastLatencyMs?.P95) : null;

  const cards: { k: string; v: string; s: string; tone: string }[] = [
    { k: 'Concurrent viewers online', v: fmtCompact(viewers), s: '~10k injected by the crowd simulator', tone: 'pink' },
    { k: 'Live bid rate', v: ended ? '0' : Math.round(rate).toLocaleString('en-US'), s: 'bids/s', tone: 'pink' },
    { k: 'Bids this session', v: seq.toLocaleString('en-US'), s: 'bids · atomically adjudicated by Lua', tone: '' },
    { k: 'Current price', v: '¥' + fmtMoney(price), s: 'starts at zero · live', tone: 'gold' },
    { k: 'Time left', v: ended ? 'Ended' : remainSec + 's', s: ended ? statusLabel(status) : `${DURATION_SEC}s per session`, tone: ended ? '' : 'gold' },
    { k: 'Broadcast latency p95', v: bcP95 != null ? bcP95.toFixed(1) : '—', s: 'ms · target < 150', tone: kpiTone(bcP95, 150) },
    { k: 'Bid ack p95', v: ackP95 != null ? ackP95.toFixed(1) : '—', s: ackP95 != null ? 'ms · target < 80' : 'ms · awaiting a real bid', tone: kpiTone(ackP95, 80) },
    { k: 'Live likes', v: fmtCompact(likes), s: 'viewer interactions', tone: '' },
  ];

  return (
    <>
      {!snap && <div className="conc-syncing">Creating the load-test lot and injecting concurrency…</div>}
      {ended && <div className="conc-ended">This session has ended ({statusLabel(status)}) · hit "Start the concurrency demo" above to run another</div>}
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
        The concurrency, the bids, and the price come from polling the room snapshot live; broadcast p95 and ack p95 come from the server's <code>/metrics</code> (simulated bids
        adjudicate straight through the store and do not count towards ack, so ack only gets samples once a real person bids). Every bid goes through real Redis Lua atomic
        adjudication — nothing is written in as a fake.
      </div>
    </>
  );
}

function statusLabel(s?: string): string {
  switch (s) {
    case 'SOLD':
    case 'ORDER_CREATED': return 'Sold';
    case 'NO_BID': return 'No bid';
    case 'CANCELLED': return 'Cancelled';
    default: return 'Ended';
  }
}
