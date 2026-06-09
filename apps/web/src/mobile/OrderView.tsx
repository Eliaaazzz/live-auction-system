// Login-free, shareable order/result page for the mobile H5.
// Reached via #/m?order=<auctionId> — a seller/winner copies the link (ShareModal
// / win overlay) and sends it over any IM; the friend opens it WITHOUT logging in
// and sees the public auction result (same data the admin 订单详情 shows).
// Uses the public GET /api/auctions snapshot (no winner-only fields required).

import { useEffect, useState } from 'react';
import { api } from '../backend/lib/api.js';
import { auctionToLot, type BackendAuction } from '../lib/mapBackend';
import { fmtYuan } from '../lib/format';
import { ProductImg } from './components';
import { Icon } from './icons';

const STATUS_TEXT: Record<string, { t: string; sub: string; tone: string }> = {
  LIVE: { t: '正在竞拍中', sub: '点击进入直播间实时出价', tone: '#fe2c55' },
  SCHEDULED: { t: '即将开拍', sub: '关注直播间，开拍提醒', tone: '#ffce54' },
  SOLD: { t: '已成交', sub: '恭喜买家拍得此拍品', tone: '#2fd6a8' },
  ORDER_CREATED: { t: '已成交 · 待付款', sub: '订单已生成，等待买家付款', tone: '#2fd6a8' },
  NO_BID: { t: '已流拍', sub: '本场无人出价', tone: '#9aa0b4' },
  CANCELLED: { t: '已取消', sub: '该场竞拍已取消，保证金解冻', tone: '#9aa0b4' },
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

  if (state === 'loading') return <Centered title="正在加载订单…" sub="ORDER" />;
  if (state === 'missing' || !a) return <Centered title="未找到该订单" sub="链接可能已失效，或拍品已下架" action={{ label: '进入直播间', onClick: enterRoom }} />;

  const lot = auctionToLot(a);
  const meta = STATUS_TEXT[a.status || ''] || STATUS_TEXT.LIVE;
  const price = lot && a.currentPriceCents ? Math.round(Number(BigInt(a.currentPriceCents)) / 100) : 0;
  const sold = a.status === 'SOLD' || a.status === 'ORDER_CREATED';

  return (
    <div className="ov-page">
      <div className="ov-top">
        <span className="ov-brand">🔨 实时竞拍大师</span>
        <span className="ov-free">免登录查看 · 可转发好友</span>
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
            <div className="ov-lot-cat">{lot.category} · 0 元起拍 · 服务端裁决</div>
          </div>
        </div>
        <div className="ov-pricebox">
          <div>
            <div className="k">{sold ? '成交价' : '当前价'}</div>
            <div className="v" style={{ color: meta.tone }}>{price > 0 ? fmtYuan(price) : '0 元起'}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="k">封顶价</div>
            <div className="v2">{lot.capPrice > 0 ? fmtYuan(lot.capPrice) : '不封顶'}</div>
          </div>
        </div>
        {sold && (
          <div className="ov-steps">
            <span className="on">拍下成交</span><i />
            <span className={a.status === 'ORDER_CREATED' ? '' : 'on'}>买家付款</span><i />
            <span>卖家发货</span><i /><span>交易完成</span>
          </div>
        )}
        <button className="ov-cta" onClick={enterRoom}>进入直播间 · 查看更多拍品</button>
        <div className="ov-note">订单与后台「订单管理」实时同源；本页可直接转发给好友，无需登录即可查看。</div>
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
