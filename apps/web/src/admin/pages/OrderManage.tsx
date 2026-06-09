import { useMemo, useState } from 'react';
import { Table, Tag, Segmented, Input, Space, Button, Avatar, App as AntdApp } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { fmtMoney } from '../../lib/format';
import { PROD } from '../../lib/assets';

const OIMG: Record<string, string> = { '1': PROD.jadePendant, '2': PROD.jadeBangle, '3': PROD.watch, '4': PROD.teapot, '5': PROD.goldNecklace, '6': PROD.diamond, '7': PROD.jadePendant, '8': PROD.diamond };

type OStatus = 'pending' | 'paid' | 'shipped' | 'done' | 'refunded';
interface Order { key: string; no: string; item: string; price: number; buyer: string; deposit: number; status: OStatus; time: string; }

const STATUS_META: Record<OStatus, { text: string; color: string }> = {
  pending: { text: '待支付', color: 'red' },
  paid: { text: '已支付', color: 'blue' },
  shipped: { text: '已发货', color: 'cyan' },
  done: { text: '已完成', color: 'green' },
  refunded: { text: '已退保证金', color: 'default' },
};

const ORDERS: Order[] = [
  { key: '1', no: 'AUC20260608001', item: '金镶玉平安扣·和田玉吊坠项链', price: 9000, buyer: '黄***', deposit: 200, status: 'pending', time: '06-08 14:32' },
  { key: '2', no: 'AUC20260608002', item: '天然冰糯种翡翠手镯 56mm', price: 21600, buyer: '张***', deposit: 500, status: 'paid', time: '06-08 14:10' },
  { key: '3', no: 'AUC20260608003', item: '二手奢侈品腕表 钢款机械', price: 70000, buyer: '李***', deposit: 2000, status: 'shipped', time: '06-08 13:48' },
  { key: '4', no: 'AUC20260607021', item: '紫砂壶名家全手工原矿', price: 5400, buyer: '王***', deposit: 100, status: 'done', time: '06-07 21:05' },
  { key: '5', no: 'AUC20260607019', item: '清代老银元袁大头三年', price: 2600, buyer: '陈***', deposit: 100, status: 'done', time: '06-07 20:33' },
  { key: '6', no: 'AUC20260607012', item: '奈良美智版画《青春后藏刀》', price: 7000000, buyer: '周***', deposit: 50000, status: 'paid', time: '06-07 19:20' },
  { key: '7', no: 'AUC20260607008', item: '和田玉籽料手串 12mm', price: 0, buyer: '—（流拍）', deposit: 200, status: 'refunded', time: '06-07 18:02' },
  { key: '8', no: 'AUC20260606044', item: '18K金钻石戒指 30分', price: 4300, buyer: '赵***', deposit: 300, status: 'done', time: '06-06 22:14' },
];

export default function OrderManage() {
  const { message } = AntdApp.useApp();
  const [seg, setSeg] = useState<OStatus | 'all'>('all');
  const [kw, setKw] = useState('');
  const rows = useMemo(() => ORDERS.filter((o) => (seg === 'all' ? true : o.status === seg)).filter((o) => (kw ? o.no.includes(kw) || o.buyer.includes(kw) || o.item.includes(kw) : true)), [seg, kw]);

  const columns: ColumnsType<Order> = [
    { title: '订单号', dataIndex: 'no', width: 168, render: (t) => <span style={{ fontVariantNumeric: 'tabular-nums', color: '#555' }}>{t}</span> },
    {
      title: '拍品', dataIndex: 'item', width: 280,
      render: (_, r) => (
        <Space>
          <Avatar shape="square" size={40} src={OIMG[r.key]} />
          <span style={{ maxWidth: 210, display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>{r.item}</span>
        </Space>
      ),
    },
    { title: '成交价', dataIndex: 'price', align: 'right', width: 130, render: (v: number) => (v === 0 ? <span style={{ color: '#bbb' }}>流拍</span> : <span className="num-red">¥{fmtMoney(v)}</span>) },
    { title: '买家', dataIndex: 'buyer', width: 120 },
    { title: '保证金', dataIndex: 'deposit', align: 'right', width: 100, render: (v: number) => <span className="num-strong">¥{fmtMoney(v)}</span> },
    { title: '状态', dataIndex: 'status', width: 120, render: (s: OStatus) => <Tag color={STATUS_META[s].color}>{STATUS_META[s].text}</Tag> },
    { title: '成交时间', dataIndex: 'time', width: 130, render: (t) => <span style={{ color: '#888' }}>{t}</span> },
    {
      title: '操作', key: 'op', fixed: 'right', width: 160,
      render: (_, r) => (
        <Space size={4}>
          <Button size="small" type="link" onClick={() => message.info(`查看订单 ${r.no}`)}>详情</Button>
          {r.status === 'pending' && <Button size="small" type="link" onClick={() => message.success('已发送付款提醒')}>提醒付款</Button>}
          {r.status === 'paid' && <Button size="small" type="link" onClick={() => message.success('已标记发货')}>发货</Button>}
        </Space>
      ),
    },
  ];

  return (
    <div className="admin-content">
      <div className="admin-toolbar">
        <Segmented value={seg} onChange={(val) => setSeg(val as OStatus | 'all')} options={[{ label: '全部', value: 'all' }, { label: '待支付', value: 'pending' }, { label: '已支付', value: 'paid' }, { label: '已发货', value: 'shipped' }, { label: '已完成', value: 'done' }, { label: '已退保证金', value: 'refunded' }]} />
        <div className="spacer" />
        <Input allowClear prefix={<SearchOutlined style={{ color: '#bbb' }} />} placeholder="订单号 / 买家 / 拍品" style={{ width: 240 }} value={kw} onChange={(e) => setKw(e.target.value)} />
      </div>
      <Table<Order> columns={columns} dataSource={rows} scroll={{ x: 1180 }} pagination={{ pageSize: 8, showTotal: (t) => `共 ${t} 笔订单` }} size="middle" />
    </div>
  );
}
