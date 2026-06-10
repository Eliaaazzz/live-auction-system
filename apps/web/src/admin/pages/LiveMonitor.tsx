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
  const [allList, setAllList] = useState<BackendAuction[]>([]); // #261-13 发布历史（任意状态）
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
            <Spin /> 正在加载直播场次…
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
        <span style={{ color: '#444', fontWeight: 600 }}>监控商品</span>
        <Select
          value={selectedId}
          placeholder="选择要监控的直播拍品"
          style={{ minWidth: 340 }}
          onChange={setSelectedId}
          options={liveList.map((a) => ({ value: a.auctionId, label: a.productName || a.auctionId }))}
          notFoundContent="快去竞拍发布开拍"
        />
        <Tag color="red">共 {liveList.length} 件在拍</Tag>
      </div>

      <div className="mon-layout">
        {/* #261-13 直播中左侧发布历史：让主播看到自己发布了什么，点 LIVE 项可切换监控 */}
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
            <Card styles={{ body: { padding: 0 } }}><EmptyLive onGo={() => onGo?.('publish')} title="快去直播吧" hint="开播带拍后，这里实时跳动出价与人气" cta="去竞拍发布开拍" /></Card>
          )}
        </div>
      </div>
    </div>
  );
}

const STATUS_TAG: Record<string, { label: string; color: string }> = {
  LIVE: { label: '直播中', color: 'red' },
  SCHEDULED: { label: '已排期', color: 'gold' },
  SOLD: { label: '已成交', color: 'green' },
  UNSOLD: { label: '流拍', color: 'default' },
  CANCELLED: { label: '已取消', color: 'default' },
};

/** #261-13 发布历史栏：展示本商家已发布的拍品（排除草稿），LIVE 项可点选监控。 */
function PublishHistory({ items, selectedId, onPick }: { items: BackendAuction[]; selectedId: string | null; onPick: (a: BackendAuction) => void }) {
  const published = items.filter((a) => a.status && a.status !== 'DRAFT');
  return (
    <aside className="mon-history">
      <div className="mon-history-hd">发布历史 <span>{published.length}</span></div>
      <div className="mon-history-list">
        {published.length === 0 && <div className="mon-history-empty">还没有发布记录</div>}
        {published.map((a) => {
          const t = STATUS_TAG[a.status || ''] || { label: a.status || '—', color: 'default' };
          const live = a.status === 'LIVE';
          return (
            <button
              key={a.auctionId}
              type="button"
              className={'mon-history-item' + (live ? ' live' : '') + (a.auctionId === selectedId ? ' active' : '')}
              onClick={() => onPick(a)}
              title={live ? '点击监控这场' : a.productName}
            >
              <Avatar shape="square" size={34} src={a.imageUrl} style={{ flexShrink: 0 }} />
              <div className="mon-history-meta">
                <div className="mon-history-name">{a.productName || '直播拍品'}</div>
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
  // Monitor as the seller/owner (seller-demo) so 取消异常竞拍 is authorized.
  const { state, nextMinBid, restart } = useAuctionEngine(lot, { running: true, nickname: 'seller-demo' });
  const [cancelling, setCancelling] = useState(false);

  // Real cancel — owner session + backend CANCELLED (was a toast-only stub).
  const doCancel = async () => {
    setCancelling(true);
    try {
      await ensureSession('seller-demo');
      await api.cancel(lot.id, {});
      message.warning(`已取消「${lot.title.slice(0, 8)}…」，保证金即时解冻`);
      onCancelled();
    } catch (e: any) {
      message.error('取消失败：' + (e?.message || e));
    } finally {
      setCancelling(false);
    }
  };

  const now = Date.now();
  const ago = (ts: number) => {
    const s = Math.max(0, Math.round((now - ts) / 1000));
    return s < 60 ? `${s}s前` : `${Math.floor(s / 60)}m前`;
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
        extra={<Tag color="red">直播中</Tag>}
      >
        <Steps
          size="small"
          current={STEP_INDEX[state.status]}
          status={state.status === 'unsold' ? 'error' : 'process'}
          items={[{ title: '已上架' }, { title: '竞拍中' }, { title: '截拍中' }, { title: state.status === 'unsold' ? '流拍' : '成交' }]}
          style={{ marginBottom: 22 }}
        />

        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, marginBottom: 6 }}>
          <div>
            <div style={{ fontSize: 12, color: '#999' }}>当前最高价</div>
            <div className="mon-price">¥{fmtMoney(state.currentPrice)}</div>
          </div>
          <div style={{ paddingBottom: 8 }}>
            {state.leader ? <Tag icon={<CrownOutlined />} color="gold">{state.leader.userName} 领先</Tag> : <Tag>暂无出价</Tag>}
          </div>
        </div>

        <div style={{ marginBottom: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#999', marginBottom: 4 }}>
            <span>{lot.capPrice > 0 ? `距封顶价 ¥${fmtMoney(lot.capPrice)}` : '不封顶（价高者得）'}</span>
            <span>{lot.capPrice > 0 ? `${capPct}%` : ''}</span>
          </div>
          <Progress percent={capPct} showInfo={false} strokeColor={{ from: '#ff5f7e', to: '#fe2c55' }} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
          <Statistic title="距结束" value={fmtClock(state.remainingMs)} valueStyle={{ color: state.status === 'ending' ? '#fe2c55' : undefined, fontSize: 20 }} prefix={<FireOutlined />} />
          <Statistic title="出价次数" value={feedCount} valueStyle={{ fontSize: 20 }} prefix={<ThunderboltOutlined />} />
          <Statistic title={state.simViewers > 0 ? '参与人数（含模拟人气）' : '参与人数'} value={state.participants} valueStyle={{ fontSize: 20 }} prefix={<TeamOutlined />} suffix={state.simViewers > 0 ? <Tag color="orange" style={{ marginInlineStart: 6, fontSize: 11 }}>演示</Tag> : undefined} />
          <Statistic title="下次最低出价" value={nextMinBid} prefix="¥" valueStyle={{ fontSize: 20 }} />
        </div>

        <div style={{ marginTop: 22, display: 'flex', gap: 10 }}>
          <Popconfirm title="取消异常竞拍" description="将立即结束本场竞拍并解冻所有保证金，确认？" okText="确认取消" cancelText="再想想" okButtonProps={{ danger: true }} onConfirm={doCancel}>
            <Button danger icon={<StopOutlined />} loading={cancelling}>取消异常竞拍</Button>
          </Popconfirm>
          <Button icon={<ReloadOutlined />} onClick={() => { restart(); message.success('已重新同步本场数据'); }}>重置 / 刷新</Button>
        </div>
      </Card>

      <Card styles={{ body: { paddingTop: 8 } }}>
        <Tabs
          items={[
            {
              key: 'feed',
              label: `实时出价流水 (${feedCount})`,
              children: (
                <div className="mon-feed">
                  {feed.length === 0 && <div style={{ color: '#bbb', padding: 20, textAlign: 'center' }}>等待第一笔出价…</div>}
                  {feed.slice(0, 40).map((b, i) => (
                    <div key={b.id} className={'mon-bid' + (i === 0 ? ' lead' : b.self ? ' self' : '')}>
                      <Avatar size={26} src={b.avatar} style={{ flexShrink: 0 }} />
                      {/* #261-2: 买家名横排（.mon-name nowrap）— 不再竖着一字一行 */}
                      <span className="mon-name">{b.self ? '我' : b.userName}</span>
                      {String(b.userId || '').startsWith('user_sim') && <Tag style={{ marginInlineStart: 2, flexShrink: 0, fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>模拟</Tag>}
                      {i === 0 && <Tag color="gold" style={{ marginInlineStart: 4, flexShrink: 0 }}>领先</Tag>}
                      <span className="mon-time">{ago(b.ts)}</span>
                      <span className="mon-amt" style={{ color: i === 0 ? '#fe2c55' : '#333' }}>¥{fmtMoney(b.amount)}</span>
                    </div>
                  ))}
                </div>
              ),
            },
            {
              key: 'rank',
              label: '实时排行榜',
              children: (
                <div className="mon-feed">
                  {state.ranking.slice(0, 10).map((r, i) => (
                    <div key={r.userId} className={'mon-bid' + (i === 0 ? ' lead' : r.self ? ' self' : '')}>
                      <span style={{ width: 22, textAlign: 'center', fontWeight: 800, color: i === 0 ? '#f6a609' : i === 1 ? '#8c8c8c' : '#bbb', flexShrink: 0 }}>
                        {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}
                      </span>
                      <Avatar size={26} src={r.avatar} style={{ flexShrink: 0 }} />
                      <span className="mon-name">{r.self ? '我' : r.userName}</span>
                      {String(r.userId || '').startsWith('user_sim') && <Tag style={{ marginInlineStart: 2, flexShrink: 0, fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>模拟</Tag>}
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
