import { useEffect, useState } from 'react';
import { Table, Tag, Button, Input, Space, Tabs, Dropdown, Checkbox, Tooltip, App as AntdApp } from 'antd';
import { ReloadOutlined, SearchOutlined, FilterOutlined, PlusOutlined, SoundOutlined, EllipsisOutlined, AppstoreOutlined, LinkOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { fmtMoney } from '../../lib/format';
import { PROD } from '../../lib/assets';

const PIMG: Record<string, string> = { '1': PROD.chocolate, '2': PROD.teapot, '3': PROD.jadePendant, '4': PROD.jadeBangle, '5': PROD.watch, '6': PROD.teapot, '7': PROD.goldNecklace, '8': PROD.diamond };

interface Prod { key: string; name: string; id: string; tags: string[]; start: number; step: number; cap: number; current: number; bids: number; status: 'live' | 'done' | 'waiting'; endTs?: number; }

const now = Date.now();
const PRODUCTS: Prod[] = [
  { key: '1', name: '爆款和风生巧福袋特价食品解馋食休闲小吃巧克力大福麻米糍...', id: '728103441', tags: ['晚发现金', '运费险'], start: 100, step: 10, cap: 1000, current: 240, bids: 13, status: 'live', endTs: now + 599_000 },
  { key: '2', name: '爆款和风生巧福袋特价食品解馋食休闲小吃巧克力大福麻米糍...', id: '728103442', tags: ['卖点信息'], start: 100, step: 10, cap: 1000, current: 960, bids: 30, status: 'done' },
  { key: '3', name: '金镶玉平安扣·和田玉吊坠项链首饰（附鉴定证书）', id: '910882001', tags: ['7天无理由', '运费险'], start: 0, step: 50, cap: 12000, current: 850, bids: 17, status: 'live', endTs: now + 92_000 },
  { key: '4', name: '天然冰糯种翡翠手镯 内径56mm A货起光起胶', id: '910882002', tags: ['专业质检'], start: 1000, step: 100, cap: 30000, current: 8800, bids: 24, status: 'live', endTs: now + 41_000 },
  { key: '5', name: '二手奢侈品腕表 钢款自动机械 95新原盒原证', id: '910882003', tags: ['正品保障', '运费险'], start: 5000, step: 500, cap: 88000, current: 0, bids: 0, status: 'waiting' },
  { key: '6', name: '紫砂壶名家手工全手工原矿底槽清茶壶', id: '910882004', tags: ['卖点信息'], start: 200, step: 50, cap: 8000, current: 3150, bids: 41, status: 'live', endTs: now + 213_000 },
  { key: '7', name: '清代老银元袁大头三年银币收藏（保真）', id: '910882005', tags: ['专业质检'], start: 300, step: 50, cap: 6000, current: 2600, bids: 28, status: 'done' },
  { key: '8', name: '日本艺术家良美智大尺幅版画《青春后藏刀》234×208cm', id: '910882006', tags: ['大额拍品', '验真'], start: 5_000_000, step: 100_000, cap: 50_000_000, current: 5_000_000, bids: 3, status: 'live', endTs: now + 880_000 },
];

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
  const [explaining, setExplaining] = useState<string | null>('3');
  const [search, setSearch] = useState('');
  const rows = PRODUCTS.filter((p) => (tab === 'live' ? p.status !== 'waiting' : p.status === 'waiting')).filter((p) => (search ? p.name.includes(search) || p.id.includes(search) : true));

  const columns: ColumnsType<Prod> = [
    {
      title: '商品', dataIndex: 'name', width: 360,
      render: (_, r) => (
        <div className="prod-cell">
          <img className="prod-thumb" src={PIMG[r.key]} alt="" loading="lazy" />
          <div className="prod-meta">
            <Tooltip title={r.name}><div className="name">{r.name}</div></Tooltip>
            <div className="id">ID: {r.id}</div>
            <Space size={4} wrap>
              {r.status === 'live' && <Tag color="red">竞拍中</Tag>}
              {r.status === 'done' && <Tag color="default">已成交</Tag>}
              {r.status === 'waiting' && <Tag color="gold">待开拍</Tag>}
              {r.tags.map((t) => (<Tag key={t} bordered={false} style={{ background: '#f5f5f5', color: '#666' }}>{t}</Tag>))}
            </Space>
          </div>
        </div>
      ),
    },
    { title: '起拍价', dataIndex: 'start', align: 'right', width: 100, render: (v: number) => <span className="num-strong">{v === 0 ? '0 元起' : '¥' + fmtMoney(v)}</span> },
    { title: '固定加价', dataIndex: 'step', align: 'right', width: 96, render: (v: number) => <span className="num-strong">¥{fmtMoney(v)}</span> },
    { title: '封顶价', dataIndex: 'cap', align: 'right', width: 110, render: (v: number) => <span className="num-strong">¥{fmtMoney(v)}</span> },
    { title: '当前出价', dataIndex: 'current', align: 'right', width: 120, render: (v: number, r) => (r.status === 'waiting' ? <span style={{ color: '#bbb' }}>—</span> : <span className="num-red">¥{fmtMoney(v)}</span>) },
    { title: '出价次数', dataIndex: 'bids', align: 'right', width: 96, render: (v: number) => (<a className="count-bar">{v} <LinkOutlined style={{ fontSize: 11 }} /></a>) },
    {
      title: '状态', key: 'status', width: 150,
      render: (_, r) => {
        if (r.status === 'live') return (<Space direction="vertical" size={0}><Tag color="red" style={{ marginInlineEnd: 0 }}>竞拍中</Tag>{r.endTs && (<span style={{ fontSize: 12 }}>倒计时 <LiveCountdown endTs={r.endTs} /></span>)}</Space>);
        if (r.status === 'done') return <Tag color="green">已成交</Tag>;
        return <Tag color="gold">待开拍</Tag>;
      },
    },
    {
      title: '操作', key: 'op', fixed: 'right', width: 220,
      render: (_, r) => (
        <Space size={4}>
          {r.status !== 'waiting' ? (<Button size="small" onClick={() => message.success(`已下架「${r.name.slice(0, 6)}…」`)}>下架</Button>) : (<Button size="small" type="primary" ghost onClick={() => message.success('已上架开拍')}>上架</Button>)}
          <Button size="small" type={explaining === r.key ? 'primary' : 'default'} icon={<SoundOutlined />} onClick={() => { setExplaining(explaining === r.key ? null : r.key); message.info(explaining === r.key ? '已取消讲解' : '开始讲解中'); }}>{explaining === r.key ? '取消讲解' : '讲解'}</Button>
          <Dropdown menu={{ items: [{ key: 'edit', label: '修改竞拍规则' }, { key: 'group', label: '加入商品分组' }, { type: 'divider' }, { key: 'cancel', label: <span style={{ color: '#fe2c55' }}>取消异常竞拍</span>, danger: true }], onClick: ({ key }) => { if (key === 'cancel') message.warning('已取消该异常竞拍，保证金即时解冻'); else message.info('操作已记录'); } }}>
            <Button size="small" icon={<EllipsisOutlined />} />
          </Dropdown>
        </Space>
      ),
    },
  ];

  return (
    <div className="admin-content">
      <Tabs activeKey={tab} onChange={setTab} items={[{ key: 'live', label: `直播商品 (${PRODUCTS.filter((p) => p.status !== 'waiting').length})` }, { key: 'waiting', label: `待上架商品 (${PRODUCTS.filter((p) => p.status === 'waiting').length})` }]} />
      <div className="admin-toolbar">
        <Checkbox>全选</Checkbox>
        <Input allowClear prefix={<SearchOutlined style={{ color: '#bbb' }} />} placeholder="请输入商品名称 / ID" style={{ width: 240 }} value={search} onChange={(e) => setSearch(e.target.value)} />
        <Button icon={<FilterOutlined />}>筛选</Button>
        <div className="spacer" />
        <Button icon={<ReloadOutlined />} onClick={() => message.success('列表已刷新')}>刷新列表</Button>
        <Button icon={<AppstoreOutlined />}>查看分组</Button>
        <Button>搭配管理</Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => message.info('请前往「竞拍发布」添加商品')}>添加商品</Button>
      </div>
      <Table<Prod> columns={columns} dataSource={rows} rowSelection={{ type: 'checkbox' }} pagination={{ pageSize: 6, showTotal: (t) => `共 ${t} 件拍品` }} scroll={{ x: 1280 }} size="middle" />
    </div>
  );
}
