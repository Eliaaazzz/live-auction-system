import { useEffect, useState, useCallback } from 'react';
import { Card, Statistic, Steps, Button, Popconfirm, Tabs, Tag, Avatar, Progress, Spin, Select, App as AntdApp } from 'antd';
import { ThunderboltOutlined, StopOutlined, CrownOutlined, TeamOutlined, FireOutlined, ReloadOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { useAuctionEngine } from '../../lib/useAuctionEngine';
import { auctionToLot, type BackendAuction } from '../../lib/mapBackend';
import { api } from '../../backend/lib/api.js';
import { ensureSession } from '../../backend/lib/auth.js';
import type { Lot } from '../../lib/types';
import { fmtMoney, fmtClock, fmtCompact } from '../../lib/format';
import EmptyLive from '../EmptyLive';

const STEP_INDEX: Record<string, number> = { upcoming: 0, live: 1, ending: 2, sold: 3, unsold: 3 };
const POLL_MS = 10_000;

export default function LiveMonitor({ onGo }: { onGo?: (p: string) => void } = {}) {
  const [liveList, setLiveList] = useState<BackendAuction[]>([]);
  const [allList, setAllList] = useState<BackendAuction[]>([]); // #261-13 publish history (any status)
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Keep the full list of LIVE auctions so the seller can pick WHICH one to
  // monitor (selector below); default to the first LIVE and keep the current
  // pick across polls while it's still live.
  const refresh = useCallback(async () => {
    try {
      const { auctions = [] } = await api.listAuctions({ limit: 500 } as any);
      const arr = (auctions || []) as BackendAuction[];
      setAllList(arr);
      const live = arr.filter((a) => a.auctionId && a.status === 'LIVE');
      setLiveList(live);
      setSelectedId((cur) => (cur && live.some((a: BackendAuction) => a.auctionId === cur) ? cur : (live[0]?.auctionId ?? null)));
    } catch {
      /* keep last good list */
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const poll = setInterval(refresh, POLL_MS);
    return () => clearInterval(poll);
  }, [refresh]);

  if (loading) {
    return (
      <div style={{ margin: 18 }}>
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 40, color: '#999' }}>
            <Spin /> Loading live sessions...
          </div>
        </Card>
      </div>
    );
  }

  const selected = liveList.find((a) => a.auctionId === selectedId) || null;

  return (
    <div style={{ margin: 18 }}>
      <div style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <VideoCameraOutlined style={{ color: '#fe2c55' }} />
        <span style={{ color: '#444', fontWeight: 600 }}>Monitored lot</span>
        <Select
          value={selectedId}
          placeholder="Choose a live lot to monitor"
          style={{ minWidth: 340 }}
          onChange={setSelectedId}
          options={liveList.map((a) => ({ value: a.auctionId, label: a.productName || a.auctionId }))}
          notFoundContent="Publish an auction to get started"
        />
        <Tag color="red">{liveList.length} lot(s) live</Tag>
      </div>

      <div className="mon-layout">
        {/* #261-13 publish history on the left while live: the host can see what they published, and tapping a LIVE item switches the monitor to it */}
        <PublishHistory
          items={allList}
          selectedId={selectedId}
          onPick={(a) => { if (a.status === 'LIVE') setSelectedId(a.auctionId); }}
        />
        <div className="mon-main">
          {selected ? (
            // key by id so switching pick remounts the engine cleanly.
            <MonitorView key={selected.auctionId} lot={auctionToLot(selected)} onCancelled={refresh} />
          ) : (
            <Card styles={{ body: { padding: 0 } }}><EmptyLive onGo={() => onGo?.('publish')} title="Go live" hint="Once you start streaming a lot, bids and popularity update here live" cta="Go to Publish auction" /></Card>
          )}
        </div>
      </div>
    </div>
  );
}

const STATUS_TAG: Record<string, { label: string; color: string }> = {
  LIVE: { label: 'Live', color: 'red' },
  SCHEDULED: { label: 'Scheduled', color: 'gold' },
  SOLD: { label: 'Sold', color: 'green' },
  UNSOLD: { label: 'No bid', color: 'default' },
  CANCELLED: { label: 'Cancelled', color: 'default' },
};

/** #261-13 publish-history rail: shows this merchant's published lots (drafts excluded); tapping a LIVE item switches the monitor. */
function PublishHistory({ items, selectedId, onPick }: { items: BackendAuction[]; selectedId: string | null; onPick: (a: BackendAuction) => void }) {
  const published = items.filter((a) => a.status && a.status !== 'DRAFT');
  return (
    <aside className="mon-history">
      <div className="mon-history-hd">Publish history <span>{published.length}</span></div>
      <div className="mon-history-list">
        {published.length === 0 && <div className="mon-history-empty">No publish records yet</div>}
        {published.map((a) => {
          const t = STATUS_TAG[a.status || ''] || { label: a.status || '—', color: 'default' };
          const live = a.status === 'LIVE';
          return (
            <button
              key={a.auctionId}
              type="button"
              className={'mon-history-item' + (live ? ' live' : '') + (a.auctionId === selectedId ? ' active' : '')}
              onClick={() => onPick(a)}
              title={live ? 'Tap to monitor this session' : a.productName}
            >
              <Avatar shape="square" size={34} src={a.imageUrl} style={{ flexShrink: 0 }} />
              <div className="mon-history-meta">
                <div className="mon-history-name">{a.productName || 'Live lot'}</div>
                <Tag color={t.color} style={{ marginInlineEnd: 0, width: 'fit-content' }}>{t.label}</Tag>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function MonitorView({ lot, onCancelled }: { lot: Lot; onCancelled: () => void }) {
  const { message } = AntdApp.useApp();
  // Monitor as the seller/owner (seller-demo) so cancelling a faulty auction is authorized.
  const { state, nextMinBid, restart } = useAuctionEngine(lot, { running: true, nickname: 'seller-demo' });
  const [cancelling, setCancelling] = useState(false);

  // Real cancel — owner session + backend CANCELLED (was a toast-only stub).
  const doCancel = async () => {
    setCancelling(true);
    try {
      await ensureSession('seller-demo');
      await api.cancel(lot.id, {});
      message.warning(`Cancelled "${lot.title.slice(0, 8)}..." - deposits released immediately`);
      onCancelled();
    } catch (e: any) {
      message.error('Cancel failed: ' + (e?.message || e));
    } finally {
      setCancelling(false);
    }
  };

  const now = Date.now();
  const ago = (ts: number) => {
    const s = Math.max(0, Math.round((now - ts) / 1000));
    return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
  };
  const capPct = lot.capPrice > 0 ? Math.min(100, Math.round((state.currentPrice / lot.capPrice) * 100)) : 0;

  const feed = state.bids.length
    ? state.bids
    : state.ranking.map((r, i) => ({ id: r.userId + '-' + i, userId: r.userId, userName: r.userName, avatar: r.avatar, amount: r.amount, self: r.self, ts: now - i * 1000 }));
  const feedCount = state.bidCount > 0 ? state.bidCount : feed.length;

  return (
    <div className="mon-grid">
      <Card
        title={<span style={{ display: 'inline-flex', alignItems: 'center' }}><Avatar shape="square" size={40} src={lot.image} style={{ marginRight: 10 }} />{lot.title}</span>}
        extra={<Tag color="red">Live</Tag>}
      >
        <Steps
          size="small"
          current={STEP_INDEX[state.status]}
          status={state.status === 'unsold' ? 'error' : 'process'}
          items={[{ title: 'Listed' }, { title: 'Bidding' }, { title: 'Closing' }, { title: state.status === 'unsold' ? 'No bid' : 'Sold' }]}
          style={{ marginBottom: 22 }}
        />

        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, marginBottom: 6 }}>
          <div>
            <div style={{ fontSize: 12, color: '#999' }}>Current highest bid</div>
            <div className="mon-price">¥{fmtMoney(state.currentPrice)}</div>
          </div>
          <div style={{ paddingBottom: 8 }}>
            {state.leader ? <Tag icon={<CrownOutlined />} color="gold">{state.leader.userName} leading</Tag> : <Tag>No bids yet</Tag>}
          </div>
        </div>

        <div style={{ marginBottom: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#999', marginBottom: 4 }}>
            <span>{lot.capPrice > 0 ? `Cap price ¥${fmtMoney(lot.capPrice)}` : 'No cap (highest bid wins)'}</span>
            <span>{lot.capPrice > 0 ? `${capPct}%` : ''}</span>
          </div>
          <Progress percent={capPct} showInfo={false} strokeColor={{ from: '#ff5f7e', to: '#fe2c55' }} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
          <Statistic title="Ends in" value={fmtClock(state.remainingMs)} valueStyle={{ color: state.status === 'ending' ? '#fe2c55' : undefined, fontSize: 20 }} prefix={<FireOutlined />} />
          <Statistic title="Bids" value={feedCount} valueStyle={{ fontSize: 20 }} prefix={<ThunderboltOutlined />} />
          <Statistic title={state.simViewers > 0 ? 'Participants (incl. simulated crowd)' : 'Participants'} value={state.participants} valueStyle={{ fontSize: 20 }} prefix={<TeamOutlined />} suffix={state.simViewers > 0 ? <Tag color="orange" style={{ marginInlineStart: 6, fontSize: 11 }}>demo</Tag> : undefined} />
          <Statistic title="Next minimum bid" value={nextMinBid} prefix="¥" valueStyle={{ fontSize: 20 }} />
        </div>

        <div style={{ marginTop: 22, display: 'flex', gap: 10 }}>
          <Popconfirm title="Cancel a faulty auction" description="This ends the session immediately and releases every deposit. Continue?" okText="Cancel the auction" cancelText="Go back" okButtonProps={{ danger: true }} onConfirm={doCancel}>
            <Button danger icon={<StopOutlined />} loading={cancelling}>Cancel faulty auction</Button>
          </Popconfirm>
          <Button icon={<ReloadOutlined />} onClick={() => { restart(); message.success('Session data re-synced'); }}>Reset / refresh</Button>
        </div>
      </Card>

      <Card styles={{ body: { paddingTop: 8 } }}>
        <Tabs
          items={[
            {
              key: 'feed',
              label: `Live bid feed (${feedCount})`,
              children: (
                <div className="mon-feed">
                  {feed.length === 0 && <div style={{ color: '#bbb', padding: 20, textAlign: 'center' }}>Waiting for the first bid...</div>}
                  {feed.slice(0, 40).map((b, i) => (
                    <div key={b.id} className={'mon-bid' + (i === 0 ? ' lead' : b.self ? ' self' : '')}>
                      <Avatar size={26} src={b.avatar} style={{ flexShrink: 0 }} />
                      {/* #261-2: buyer names stay on one line (.mon-name nowrap) instead of wrapping one character per row */}
                      <span className="mon-name">{b.self ? 'Me' : b.userName}</span>
                      {String(b.userId || '').startsWith('user_sim') && <Tag style={{ marginInlineStart: 2, flexShrink: 0, fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>sim</Tag>}
                      {i === 0 && <Tag color="gold" style={{ marginInlineStart: 4, flexShrink: 0 }}>leading</Tag>}
                      <span className="mon-time">{ago(b.ts)}</span>
                      <span className="mon-amt" style={{ color: i === 0 ? '#fe2c55' : '#333' }}>¥{fmtMoney(b.amount)}</span>
                    </div>
                  ))}
                </div>
              ),
            },
            {
              key: 'rank',
              label: 'Live leaderboard',
              children: (
                <div className="mon-feed">
                  {state.ranking.slice(0, 10).map((r, i) => (
                    <div key={r.userId} className={'mon-bid' + (i === 0 ? ' lead' : r.self ? ' self' : '')}>
                      <span style={{ width: 22, textAlign: 'center', fontWeight: 800, color: i === 0 ? '#f6a609' : i === 1 ? '#8c8c8c' : '#bbb', flexShrink: 0 }}>
                        {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}
                      </span>
                      <Avatar size={26} src={r.avatar} style={{ flexShrink: 0 }} />
                      <span className="mon-name">{r.self ? 'Me' : r.userName}</span>
                      {String(r.userId || '').startsWith('user_sim') && <Tag style={{ marginInlineStart: 2, flexShrink: 0, fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>sim</Tag>}
                      <span className="mon-amt">¥{fmtCompact(r.amount)}</span>
                    </div>
                  ))}
                </div>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
