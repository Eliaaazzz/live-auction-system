import { Card, Statistic, Steps, Button, Popconfirm, Tabs, Tag, Avatar, Progress, App as AntdApp } from 'antd';
import { ThunderboltOutlined, StopOutlined, CrownOutlined, TeamOutlined, FireOutlined, ReloadOutlined } from '@ant-design/icons';
import { useAuctionEngine } from '../../lib/useAuctionEngine';
import { ROOMS } from '../../lib/mockData';
import { fmtMoney, fmtClock, fmtCompact } from '../../lib/format';

const STEP_INDEX: Record<string, number> = { upcoming: 0, live: 1, ending: 2, sold: 3, unsold: 3 };

export default function LiveMonitor() {
  const { message } = AntdApp.useApp();
  const room = ROOMS[0];
  const lot = room.lot;
  const { state, nextMinBid, restart } = useAuctionEngine(lot, { seedToPrice: 850, running: true });

  const now = Date.now();
  const ago = (ts: number) => {
    const s = Math.max(0, Math.round((now - ts) / 1000));
    return s < 60 ? `${s}s前` : `${Math.floor(s / 60)}m前`;
  };
  const capPct = Math.min(100, Math.round((state.currentPrice / lot.capPrice) * 100));

  return (
    <div style={{ margin: 18 }}>
      <div className="mon-grid">
        {/* -------- left: state machine + key metrics -------- */}
        <Card
          title={
            <span style={{ display: 'inline-flex', alignItems: 'center' }}>
              <Avatar shape="square" size={40} src={lot.image} style={{ marginRight: 10 }} />
              {lot.title}
            </span>
          }
          extra={<Tag color="red">{room.anchorName} 直播中</Tag>}
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
              {state.leader ? (
                <Tag icon={<CrownOutlined />} color="gold">
                  {state.leader.userName} 领先
                </Tag>
              ) : (
                <Tag>暂无出价</Tag>
              )}
            </div>
          </div>

          <div style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#999', marginBottom: 4 }}>
              <span>距封顶价 ¥{fmtMoney(lot.capPrice)}</span>
              <span>{capPct}%</span>
            </div>
            <Progress percent={capPct} showInfo={false} strokeColor={{ from: '#ff5f7e', to: '#fe2c55' }} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
            <Statistic title="距结束" value={fmtClock(state.remainingMs)} valueStyle={{ color: state.status === 'ending' ? '#fe2c55' : undefined, fontSize: 20 }} prefix={<FireOutlined />} />
            <Statistic title="出价次数" value={state.bidCount} valueStyle={{ fontSize: 20 }} prefix={<ThunderboltOutlined />} />
            <Statistic title="参与人数" value={state.participants} valueStyle={{ fontSize: 20 }} prefix={<TeamOutlined />} />
            <Statistic title="下次最低出价" value={nextMinBid} prefix="¥" valueStyle={{ fontSize: 20 }} />
          </div>

          <div style={{ marginTop: 22, display: 'flex', gap: 10 }}>
            <Popconfirm
              title="取消异常竞拍"
              description="将立即结束本场竞拍并解冻所有保证金，确认？"
              okText="确认取消"
              cancelText="再想想"
              okButtonProps={{ danger: true }}
              onConfirm={() => message.warning('已取消异常竞拍，保证金已解冻')}
            >
              <Button danger icon={<StopOutlined />}>
                取消异常竞拍
              </Button>
            </Popconfirm>
            <Button icon={<ReloadOutlined />} onClick={() => { restart(); message.success('已重置为新一轮竞拍'); }}>
              重置 / 下一件
            </Button>
          </div>
        </Card>

        {/* -------- right: realtime feed + leaderboard -------- */}
        <Card styles={{ body: { paddingTop: 8 } }}>
          <Tabs
            items={[
              {
                key: 'feed',
                label: `实时出价流水 (${state.bidCount})`,
                children: (
                  <div className="mon-feed">
                    {state.bids.length === 0 && <div style={{ color: '#bbb', padding: 20, textAlign: 'center' }}>等待第一笔出价…</div>}
                    {state.bids.slice(0, 40).map((b, i) => (
                      <div key={b.id} className={'mon-bid' + (i === 0 ? ' lead' : b.self ? ' self' : '')}>
                        <Avatar size={26} src={b.avatar} style={{ flexShrink: 0 }} />
                        <span style={{ fontWeight: 600 }}>{b.self ? '我' : b.userName}</span>
                        {i === 0 && <Tag color="gold" style={{ marginInlineStart: 4 }}>领先</Tag>}
                        <span style={{ color: '#bbb', fontSize: 12 }}>{ago(b.ts)}</span>
                        <span className="mon-amt" style={{ color: i === 0 ? '#fe2c55' : '#333' }}>
                          ¥{fmtMoney(b.amount)}
                        </span>
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
                        <span style={{ width: 22, textAlign: 'center', fontWeight: 800, color: i === 0 ? '#f6a609' : i === 1 ? '#8c8c8c' : '#bbb' }}>
                          {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}
                        </span>
                        <Avatar size={26} src={r.avatar} style={{ flexShrink: 0 }} />
                        <span style={{ fontWeight: 600 }}>{r.self ? '我' : r.userName}</span>
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
    </div>
  );
}
