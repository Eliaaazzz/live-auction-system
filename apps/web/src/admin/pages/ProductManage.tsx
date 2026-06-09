import { useCallback, useEffect, useState } from 'react';
import { Table, Tag, Button, Input, Space, Tabs, Dropdown, Checkbox, Tooltip, App as AntdApp } from 'antd';
import { ReloadOutlined, SearchOutlined, FilterOutlined, PlusOutlined, SoundOutlined, EllipsisOutlined, AppstoreOutlined, LinkOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { fmtMoney } from '../../lib/format';
import { PROD } from '../../lib/assets';
import { api } from '../../backend/lib/api.js';
import { ensureSession } from '../../backend/lib/auth.js';

interface Prod { key: string; name: string; id: string; image: string; tags: string[]; start: number; step: number; cap: number; current: number; bids: number; status: 'live' | 'done' | 'waiting'; endTs?: number; }

const yuan = (c?: string | number | null): number => {
  if (c == null || c === '') return 0;
  try { return Math.round(Number(BigInt(String(c))) / 100); } catch { return Math.round(Number(c) / 100) || 0; }
};
function mapStatus(s?: string): Prod['status'] {
  if (s === 'LIVE') return 'live';
  if (s === 'SOLD' || s === 'NO_BID' || s === 'CANCELLED' || s === 'ORDER_CREATED') return 'done';
  return 'waiting';
}
function toProd(a: any): Prod {
  return {
    key: a.auctionId,
    name: a.productName || '直播拍品',
    id: a.auctionId,
    image: a.imageUrl || PROD.watch,
    tags: a.mode && a.mode !== 'ENGLISH' ? [a.mode] : [],
    start: yuan(a.startPriceCents),
    step: yuan(a.incrementCents),
    cap: yuan(a.capPriceCents),
    current: yuan(a.currentPriceCents),
    bids: Number(a.bidCount) || 0,
    status: mapStatus(a.status),
    endTs: a.endAtMs || undefined,
  };
}

function LiveCountdown({ endTs }: { endTs: number }) {
  const [, force] = useState(0);
  useEffect(() => { const t = setInterval(() => force((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const ms = Math.max(0, endTs - Date.now());
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  const ending = ms < 60_000;
  return <span style={{ color: ending ? '#fe2c55' : '#fa8c16', fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{hh}:{mm}:{ss}</span>;
}

export default function ProductManage() {
  const { message } = AntdApp.useApp();
  const [tab, setTab] = useState('live');
  const [explaining, setExplaining] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [products, setProducts] = useState<Prod[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { auctions = [] } = await api.listAuctions();
      setProducts(auctions.map(toProd));
    } catch (e: any) {
      message.error('加载商品失败：' + (e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [message]);
  useEffect(() => { load(); const t = setInterval(load, 10_000); return () => clearInterval(t); }, [load]);

  const cancelAuction = async (id: string, name: string) => {
    try {
      await ensureSession('seller-demo');
      await api.cancel(id, {});
      message.warning(`已取消「${name.slice(0, 6)}…」，保证金即时解冻`);
      load();
    } catch (e: any) {
      message.error('取消失败：' + (e?.message || e));
    }
  };

  const rows = products
    .filter((p) => (tab === 'live' ? p.status !== 'waiting' : p.status === 'waiting'))
    .filter((p) => (search ? p.name.includes(search) || p.id.includes(search) : true));

  const columns: ColumnsType<Prod> = [
    {
      title: '商品', dataIndex: 'name', width: 360,
      render: (_, r) => (
        <div className="prod-cell">
          <img className="prod-thumb" src={r.image} alt="" loading="lazy" />
          <div className="prod-meta">
            <Tooltip title={r.name}><div className="name">{r.name}</div></Tooltip>
            <div className="id">ID: {r.id}</div>
            <Space size={4} wrap>
              {r.status === 'live' && <Tag color="red">竞拍中</Tag>}
              {r.status === 'done' && <Tag color="default">已结束</Tag>}
              {r.status === 'waiting' && <Tag color="gold">待开拍</Tag>}
              {r.tags.map((t) => (<Tag key={t} bordered={false} style={{ background: '#f5f5f5', color: '#666' }}>{t}</Tag>))}
            </Space>
          </div>
        </div>
      ),
    },
    { title: '起拍价', dataIndex: 'start', align: 'right', width: 100, render: (v: number) => <span className="num-strong">{v === 0 ? '0 元起' : '¥' + fmtMoney(v)}</span> },
    { title: '固定加价', dataIndex: 'step', align: 'right', width: 96, render: (v: number) => <span className="num-strong">¥{fmtMoney(v)}</span> },
    { title: '封顶价', dataIndex: 'cap', align: 'right', width: 110, render: (v: number) => <span className="num-strong">{v === 0 ? '不封顶' : '¥' + fmtMoney(v)}</span> },
    { title: '当前出价', dataIndex: 'current', align: 'right', width: 120, render: (v: number, r) => (r.status === 'waiting' ? <span style={{ color: '#bbb' }}>—</span> : <span className="num-red">¥{fmtMoney(v)}</span>) },
    { title: '出价次数', dataIndex: 'bids', align: 'right', width: 96, render: (v: number) => (<a className="count-bar">{v} <LinkOutlined style={{ fontSize: 11 }} /></a>) },
    {
      title: '状态', key: 'status', width: 150,
      render: (_, r) => {
        if (r.status === 'live') return (<Space direction="vertical" size={0}><Tag color="red" style={{ marginInlineEnd: 0 }}>竞拍中</Tag>{r.endTs && (<span style={{ fontSize: 12 }}>倒计时 <LiveCountdown endTs={r.endTs} /></span>)}</Space>);
        if (r.status === 'done') return <Tag color="green">已结束</Tag>;
        return <Tag color="gold">待开拍</Tag>;
      },
    },
    {
      title: '操作', key: 'op', fixed: 'right', width: 220,
      render: (_, r) => (
        <Space size={4}>
          <Button size="small" type={explaining === r.key ? 'primary' : 'default'} icon={<SoundOutlined />} onClick={() => { setExplaining(explaining === r.key ? null : r.key); message.info(explaining === r.key ? '已取消讲解' : '开始讲解中'); }}>{explaining === r.key ? '取消讲解' : '讲解'}</Button>
          <Dropdown menu={{ items: [{ key: 'cancel', label: <span style={{ color: '#fe2c55' }}>取消异常竞拍</span>, danger: true }], onClick: ({ key }) => { if (key === 'cancel') cancelAuction(r.id, r.name); } }}>
            <Button size="small" icon={<EllipsisOutlined />} />
          </Dropdown>
        </Space>
      ),
    },
  ];

  return (
    <div className="admin-content">
      <Tabs activeKey={tab} onChange={setTab} items={[{ key: 'live', label: `直播商品 (${products.filter((p) => p.status !== 'waiting').length})` }, { key: 'waiting', label: `待上架商品 (${products.filter((p) => p.status === 'waiting').length})` }]} />
      <div className="admin-toolbar">
        <Checkbox>全选</Checkbox>
        <Input allowClear prefix={<SearchOutlined style={{ color: '#bbb' }} />} placeholder="请输入商品名称 / ID" style={{ width: 240 }} value={search} onChange={(e) => setSearch(e.target.value)} />
        <Button icon={<FilterOutlined />}>筛选</Button>
        <div className="spacer" />
        <Button icon={<ReloadOutlined />} loading={loading} onClick={load}>刷新列表</Button>
        <Button icon={<AppstoreOutlined />}>查看分组</Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => message.info('请前往「竞拍发布」添加商品')}>添加商品</Button>
      </div>
      <Table<Prod> columns={columns} dataSource={rows} loading={loading} rowKey="key" rowSelection={{ type: 'checkbox' }} locale={{ emptyText: '暂无拍品 · 去「竞拍发布」开拍' }} pagination={{ pageSize: 6, showTotal: (t) => `共 ${t} 件拍品` }} scroll={{ x: 1280 }} size="middle" />
    </div>
  );
}
