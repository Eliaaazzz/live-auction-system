// Login-free, shareable order/result page for the mobile H5.
// Reached via #/m?order=<auctionId> — a seller/winner copies the link (ShareModal
// / win overlay) and sends it over any IM; the friend opens it WITHOUT logging in
// and sees the public auction result (the same data the admin order details show).
// Uses the public GET /api/auctions snapshot (no winner-only fields required).

import { useEffect, useState } from 'react';
import { api } from '../backend/lib/api.js';
import { auctionToLot, type BackendAuction } from '../lib/mapBackend';
import { fmtYuan } from '../lib/format';
import { ProductImg } from './components';
import { Icon } from './icons';

const STATUS_TEXT: Record<string, { t: string; sub: string; tone: string }> = {
  LIVE: { t: 'Bidding now', sub: 'Tap to enter the room and bid live', tone: '#fe2c55' },
  SCHEDULED: { t: 'Starting soon', sub: 'Follow the room to get a start reminder', tone: '#ffce54' },
  SOLD: { t: 'Sold', sub: 'Congratulations to the winning buyer', tone: '#2fd6a8' },
  ORDER_CREATED: { t: 'Sold - awaiting payment', sub: 'The order is created and waiting on the buyer', tone: '#2fd6a8' },
  NO_BID: { t: 'No bid', sub: 'Nobody bid in this session', tone: '#9aa0b4' },
  CANCELLED: { t: 'Cancelled', sub: 'This auction was cancelled and deposits released', tone: '#9aa0b4' },
};

export default function OrderView({ auctionId }: { auctionId: string }) {
  const [a, setA] = useState<BackendAuction | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'missing'>('loading');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { auctions = [] } = await api.listAuctions();
        const found = (auctions as BackendAuction[]).find((x) => x.auctionId === auctionId);
        if (!alive) return;
        if (found) { setA(found); setState('ok'); } else { setState('missing'); }
      } catch { if (alive) setState('missing'); }
    })();
    return () => { alive = false; };
  }, [auctionId]);

  const enterRoom = () => { window.location.hash = '#/m'; };

  if (state === 'loading') return <Centered title="Loading the order..." sub="ORDER" />;
  if (state === 'missing' || !a) return <Centered title="Order not found" sub="The link may have expired, or the lot was withdrawn" action={{ label: 'Enter the room', onClick: enterRoom }} />;

  const lot = auctionToLot(a);
  const meta = STATUS_TEXT[a.status || ''] || STATUS_TEXT.LIVE;
  const price = lot && a.currentPriceCents ? Math.round(Number(BigInt(a.currentPriceCents)) / 100) : 0;
  const sold = a.status === 'SOLD' || a.status === 'ORDER_CREATED';

  return (
    <div className="ov-page">
      <div className="ov-top">
        <span className="ov-brand">🔨 Real-Time Auction Master</span>
        <span className="ov-free">No login needed - share it with friends</span>
      </div>
      <div className="ov-card">
        <div className="ov-status" style={{ color: meta.tone }}>
          <Icon name={sold ? 'crown' : a.status === 'LIVE' ? 'flame' : 'shield'} size={18} fill={sold} /> {meta.t}
        </div>
        <div className="ov-sub">{meta.sub}</div>
        <div className="ov-lot">
          <ProductImg lot={lot} radius={14} className="ov-img" />
          <div className="ov-lot-meta">
            <div className="ov-lot-title">{lot.title}</div>
            <div className="ov-lot-cat">{lot.category} - starts at zero - adjudicated server-side</div>
          </div>
        </div>
        <div className="ov-pricebox">
          <div>
            <div className="k">{sold ? 'Final price' : 'Current price'}</div>
            <div className="v" style={{ color: meta.tone }}>{price > 0 ? fmtYuan(price) : 'From zero'}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="k">Cap price</div>
            <div className="v2">{lot.capPrice > 0 ? fmtYuan(lot.capPrice) : 'No cap'}</div>
          </div>
        </div>
        {sold && (
          <div className="ov-steps">
            <span className="on">Won at auction</span><i />
            <span className={a.status === 'ORDER_CREATED' ? '' : 'on'}>Buyer paid</span><i />
            <span>Seller shipped</span><i /><span>Transaction complete</span>
          </div>
        )}
        <button className="ov-cta" onClick={enterRoom}>Enter the room - see more lots</button>
        <div className="ov-note">This page shows the public auction result for the lot; it can be shared directly and viewed without logging in.</div>
      </div>
    </div>
  );
}

function Centered({ title, sub, action }: { title: string; sub?: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="ov-page" style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center', color: '#f5f5f7' }}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>{title}</div>
        {sub && <div style={{ fontSize: 12.5, color: '#9aa0b4', marginTop: 6 }}>{sub}</div>}
        {action && <button className="ov-cta" style={{ marginTop: 16, maxWidth: 240 }} onClick={action.onClick}>{action.label}</button>}
      </div>
    </div>
  );
}
