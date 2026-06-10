import { useEffect, useMemo, useState } from 'react';
import { Table, Tag, Segmented, Input, Space, Button, Avatar, Drawer, Descriptions, Steps, App as AntdApp } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { fmtMoney } from '../../lib/format';
import { PROD } from '../../lib/assets';
import { api } from '../../backend/lib/api.js';
import { isJunk } from '../../lib/mapBackend';

const OIMG: Record<string, string> = { '1': PROD.watch, '2': PROD.apparel, '3': PROD.bag, '4': PROD.shoes };

type OStatus = 'pending' | 'paid' | 'shipped' | 'done' | 'refunded';
interface Order { key: string; no: string; item: string; price: number; buyer: string; deposit: number; status: OStatus; time: string; img?: string; }

const yuanOf = (c?: string | number | null): number => {
  if (c == null || c === '') return 0;
  try { return Math.round(Number(BigInt(String(c))) / 100); } catch { return Math.round(Number(c) / 100) || 0; }
};

// Map a terminal auction (+ its settlement order, when SOLD) to an 订单 row.
// 成交→待支付/已支付（看 order.status），流拍/取消→已退保证金。
function mapAuctionToOrder(a: any, order: any | null): Order {
  const status: OStatus = a.status === 'CANCELLED' || a.status === 'NO_BID'
    ? 'refunded'
    : order?.status === 'paid' ? 'paid' : 'pending';
  const nick = String(a.winnerId || '').replace(/^user_/, '');
  const t = a.endAtMs || a.createdAtMs || 0;
  return {
    key: a.auctionId,
    no: a.auctionId,
    item: a.productName || '直播拍品',
    price: a.status === 'NO_BID' ? 0 : yuanOf(a.currentPriceCents),
    buyer: a.status === 'NO_BID' ? '—（流拍）' : (nick ? nick.slice(0, 1) + '***' : '匿名买家'),
    deposit: 0,
    status,
    time: t ? new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—',
    img: a.imageUrl || undefined,
  };
}

const STATUS_META: Record<OStatus, { text: string; color: string }> = {
  pending: { text: '待支付', color: 'red' },
  paid: { text: '已支付', color: 'blue' },
  shipped: { text: '已发货', color: 'cyan' },
  done: { text: '已完成', color: 'green' },
  refunded: { text: '已退保证金', color: 'default' },
};

const FLOW_STEPS = ['拍下成交', '买家付款', '卖家发货', '交易完成'];
const STEP_OF: Record<OStatus, number> = { pending: 0, paid: 1, shipped: 2, done: 3, refunded: 0 };

export default function OrderManage() {
  const { message } = AntdApp.useApp();
  const [seg, setSeg] = useState<OStatus | 'all'>('all');
  const [kw, setKw] = useState('');
  const [detail, setDetail] = useState<Order | null>(null);
  const [realOrders, setRealOrders] = useState<Order[] | null>(null);

  // Pull terminal auctions + their settlement orders from the backend. getOrder is
  // a public read; we only call it for SOLD/ORDER_CREATED to learn paid-vs-unpaid
  // (N is tiny in a demo). Polls so a fresh 成交 shows up without a manual refresh.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const { auctions = [] } = await api.listAuctions({ limit: 500 } as any);
        const terminal = (auctions as any[]).filter(
          (a) => a.auctionId && ['SOLD', 'ORDER_CREATED', 'CANCELLED', 'NO_BID'].includes(a.status) && !isJunk(a.productName),
        );
        const orders = await Promise.all(terminal.map(async (a) =>
          (a.status === 'SOLD' || a.status === 'ORDER_CREATED')
            ? api.getOrder(a.auctionId).catch(() => null)
            : null,
        ));
        if (!alive) return;
        setRealOrders(terminal.map((a, i) => mapAuctionToOrder(a, orders[i])).sort((x, y) => (y.no > x.no ? 1 : -1)));
      } catch { if (alive) setRealOrders(null); }
    };
    load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // #261-5/11: 真数据 only — 不再用迪奥等占位假订单垫底。没有成交就是空表 +
  // 引导文案，「成交订单 / 近期成交 / 订单管理」三处永远同源同步。
  const source = realOrders ?? [];
  const rows = useMemo(() => source.filter((o) => (seg === 'all' ? true : o.status === seg)).filter((o) => (kw ? o.no.includes(kw) || o.buyer.includes(kw) || o.item.includes(kw) : true)), [source, seg, kw]);

  const columns: ColumnsType<Order> = [
    { title: '订单号', dataIndex: 'no', width: 168, render: (t) => <span style={{ fontVariantNumeric: 'tabular-nums', color: '#555' }}>{t}</span> },
    {
      title: '拍品', dataIndex: 'item', width: 280,
      render: (_, r) => (
        <Space>
          <Avatar shape="square" size={40} src={r.img || OIMG[r.key]} />
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
          <Button size="small" type="link" onClick={() => setDetail(r)}>详情</Button>
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
        <Tag color={source.length ? 'green' : 'default'} style={{ marginLeft: 8 }}>{source.length ? `● 实时订单（${source.length}）` : '暂无成交订单 · 落锤后自动出现'}</Tag>
        <div className="spacer" />
        <Input allowClear prefix={<SearchOutlined style={{ color: '#bbb' }} />} placeholder="订单号 / 买家 / 拍品" style={{ width: 240 }} value={kw} onChange={(e) => setKw(e.target.value)} />
      </div>
      <Table<Order> columns={columns} dataSource={rows} scroll={{ x: 1180 }} locale={{ emptyText: '暂无订单 — 直播间落锤成交后，订单会实时出现在这里' }} pagination={{ pageSize: 8, showTotal: (t) => `共 ${t} 笔订单` }} size="middle" />

      <Drawer
        title="订单详情"
        width={480}
        open={detail !== null}
        onClose={() => setDetail(null)}
        footer={
          detail && (
            <Space>
              {detail.status === 'pending' && (
                <Button type="primary" onClick={() => message.success('已发送付款提醒')}>提醒付款</Button>
              )}
              {detail.status === 'paid' && (
                <Button type="primary" onClick={() => message.success('已标记发货')}>标记发货</Button>
              )}
              {detail.status === 'shipped' && (
                <Button type="primary" onClick={() => message.info('已查看物流')}>查看物流</Button>
              )}
              {detail.status === 'refunded' && (
                <Button onClick={() => message.info('该笔为流拍订单，保证金已原路退回')}>退款记录</Button>
              )}
              <Button onClick={() => setDetail(null)}>关闭</Button>
            </Space>
          )
        }
      >
        {detail && (
          <div>
            <Space align="start" style={{ marginBottom: 16 }}>
              <Avatar shape="square" size={56} src={detail.img || OIMG[detail.key]} />
              <div>
                <div style={{ fontWeight: 600, lineHeight: 1.4 }}>{detail.item}</div>
                <div style={{ color: '#888', fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>{detail.no}</div>
              </div>
            </Space>

            <Descriptions column={1} bordered size="small" style={{ marginBottom: 20 }}>
              <Descriptions.Item label="订单号">
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{detail.no}</span>
              </Descriptions.Item>
              <Descriptions.Item label="拍品">{detail.item}</Descriptions.Item>
              <Descriptions.Item label="成交价">
                {detail.price === 0 ? <span style={{ color: '#bbb' }}>流拍</span> : <span className="num-red">¥{fmtMoney(detail.price)}</span>}
              </Descriptions.Item>
              <Descriptions.Item label="买家">{detail.buyer}</Descriptions.Item>
              <Descriptions.Item label="保证金">
                <span className="num-strong">¥{fmtMoney(detail.deposit)}</span>
              </Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={STATUS_META[detail.status].color}>{STATUS_META[detail.status].text}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="成交时间">{detail.time}</Descriptions.Item>
            </Descriptions>

            <div style={{ fontWeight: 600, marginBottom: 12 }}>履约进度</div>
            {detail.status === 'refunded' ? (
              <div style={{ color: '#999', marginBottom: 20, fontSize: 13 }}>
                该拍品流拍，未产生成交，保证金 ¥{fmtMoney(detail.deposit)} 已原路退回买家，无履约流程。
              </div>
            ) : (
              <Steps
                direction="vertical"
                size="small"
                current={STEP_OF[detail.status]}
                style={{ marginBottom: 20 }}
                items={FLOW_STEPS.map((s) => ({ title: s }))}
              />
            )}

            <div style={{ fontWeight: 600, marginBottom: 8 }}>收货信息</div>
            <div style={{ color: '#555', fontSize: 13, lineHeight: 1.9, marginBottom: 4 }}>
              <div>收货人：{detail.buyer}（演示数据）</div>
              <div>电话：138****{detail.key.padStart(4, '0')}</div>
              <div>地址：北京市朝阳区 **** 街道 ** 号院（演示脱敏地址）</div>
            </div>
            <div style={{ color: '#bbb', fontSize: 12, marginBottom: 20 }}>* 收货信息为演示用模拟数据，实际以买家填写为准</div>

            {(detail.status === 'shipped' || detail.status === 'done') && (
              <>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>物流信息</div>
                <div style={{ color: '#555', fontSize: 13, lineHeight: 1.9, marginBottom: 20 }}>
                  <div>承运：顺丰速运</div>
                  <div>快递单号：<span style={{ fontVariantNumeric: 'tabular-nums' }}>SF{detail.no.slice(-10)}</span>（演示）</div>
                </div>
              </>
            )}

            <div style={{ color: '#999', fontSize: 12, background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 6, padding: '10px 12px', lineHeight: 1.7 }}>
              成交结果可分享至买家移动端 H5，买家通过链接
              <span style={{ fontVariantNumeric: 'tabular-nums', color: '#555' }}> #/m?order={detail.no} </span>
              免登录查看。
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
