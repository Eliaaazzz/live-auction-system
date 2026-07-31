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

// Map a terminal auction (plus its settlement order, when SOLD) to an order row.
// Sold -> awaiting payment / paid (per order.status); no bid or cancelled -> deposit refunded.
function mapAuctionToOrder(a: any, order: any | null): Order {
  const status: OStatus = a.status === 'CANCELLED' || a.status === 'NO_BID'
    ? 'refunded'
    : order?.status === 'paid' ? 'paid' : 'pending';
  const nick = String(a.winnerId || '').replace(/^user_/, '');
  const t = a.endAtMs || a.createdAtMs || 0;
  return {
    key: a.auctionId,
    no: a.auctionId,
    item: a.productName || 'Live lot',
    price: a.status === 'NO_BID' ? 0 : yuanOf(a.currentPriceCents),
    buyer: a.status === 'NO_BID' ? '- (no bid)' : (nick ? nick.slice(0, 1) + '***' : 'Anonymous buyer'),
    deposit: 0,
    status,
    time: t ? new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—',
    img: a.imageUrl || undefined,
  };
}

const STATUS_META: Record<OStatus, { text: string; color: string }> = {
  pending: { text: 'Awaiting payment', color: 'red' },
  paid: { text: 'Paid', color: 'blue' },
  shipped: { text: 'Shipped', color: 'cyan' },
  done: { text: 'Completed', color: 'green' },
  refunded: { text: 'Deposit refunded', color: 'default' },
};

const FLOW_STEPS = ['Won at auction', 'Buyer paid', 'Seller shipped', 'Transaction complete'];
const STEP_OF: Record<OStatus, number> = { pending: 0, paid: 1, shipped: 2, done: 3, refunded: 0 };

export default function OrderManage() {
  const { message } = AntdApp.useApp();
  const [seg, setSeg] = useState<OStatus | 'all'>('all');
  const [kw, setKw] = useState('');
  const [detail, setDetail] = useState<Order | null>(null);
  const [realOrders, setRealOrders] = useState<Order[] | null>(null);

  // Pull terminal auctions + their settlement orders from the backend. getOrder is
  // a public read; we only call it for SOLD/ORDER_CREATED to learn paid-vs-unpaid
  // (N is tiny in a demo). Polls so a fresh sale shows up without a manual refresh.
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

  // #261-5/11: real data only - no placeholder orders padding the list. With no sales it is an empty
  // table plus guidance copy, and the sold-orders count, recent sales, and order management always
  // share one source and stay in sync.
  const source = realOrders ?? [];
  const rows = useMemo(() => source.filter((o) => (seg === 'all' ? true : o.status === seg)).filter((o) => (kw ? o.no.includes(kw) || o.buyer.includes(kw) || o.item.includes(kw) : true)), [source, seg, kw]);

  const columns: ColumnsType<Order> = [
    { title: 'Order no.', dataIndex: 'no', width: 190, render: (t) => <span style={{ fontVariantNumeric: 'tabular-nums', color: '#555' }}>{t}</span> },
    {
      title: 'Lot', dataIndex: 'item', width: 280,
      render: (_, r) => (
        <Space>
          <Avatar shape="square" size={40} src={r.img || OIMG[r.key]} />
          <span style={{ maxWidth: 210, display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>{r.item}</span>
        </Space>
      ),
    },
    { title: 'Final price', dataIndex: 'price', align: 'right', width: 130, render: (v: number) => (v === 0 ? <span style={{ color: '#bbb' }}>No bid</span> : <span className="num-red">¥{fmtMoney(v)}</span>) },
    { title: 'Buyer', dataIndex: 'buyer', width: 130 },
    { title: 'Deposit', dataIndex: 'deposit', align: 'right', width: 110, render: (v: number) => <span className="num-strong">¥{fmtMoney(v)}</span> },
    { title: 'Status', dataIndex: 'status', width: 150, render: (s: OStatus) => <Tag color={STATUS_META[s].color}>{STATUS_META[s].text}</Tag> },
    { title: 'Closed at', dataIndex: 'time', width: 130, render: (t) => <span style={{ color: '#888' }}>{t}</span> },
    {
      title: 'Actions', key: 'op', fixed: 'right', width: 190,
      render: (_, r) => (
        <Space size={4}>
          <Button size="small" type="link" onClick={() => setDetail(r)}>Details</Button>
          {r.status === 'pending' && <Button size="small" type="link" onClick={() => message.success('Payment reminder sent')}>Remind</Button>}
          {r.status === 'paid' && <Button size="small" type="link" onClick={() => message.success('Marked as shipped')}>Ship</Button>}
        </Space>
      ),
    },
  ];

  return (
    <div className="admin-content">
      <div className="admin-toolbar">
        <Segmented value={seg} onChange={(val) => setSeg(val as OStatus | 'all')} options={[{ label: 'All', value: 'all' }, { label: 'Awaiting payment', value: 'pending' }, { label: 'Paid', value: 'paid' }, { label: 'Shipped', value: 'shipped' }, { label: 'Completed', value: 'done' }, { label: 'Deposit refunded', value: 'refunded' }]} />
        <Tag color={source.length ? 'green' : 'default'} style={{ marginLeft: 8 }}>{source.length ? `● Live orders (${source.length})` : 'No sold orders yet - they appear automatically after the hammer'}</Tag>
        <div className="spacer" />
        <Input allowClear prefix={<SearchOutlined style={{ color: '#bbb' }} />} placeholder="Order no. / buyer / lot" style={{ width: 240 }} value={kw} onChange={(e) => setKw(e.target.value)} />
      </div>
      <Table<Order> columns={columns} dataSource={rows} scroll={{ x: 1180 }} locale={{ emptyText: 'No orders yet - once a lot is hammered in the live room, its order appears here in real time' }} pagination={{ pageSize: 8, showTotal: (t) => `${t} order(s) in total` }} size="middle" />

      <Drawer
        title="Order details"
        width={480}
        open={detail !== null}
        onClose={() => setDetail(null)}
        footer={
          detail && (
            <Space>
              {detail.status === 'pending' && (
                <Button type="primary" onClick={() => message.success('Payment reminder sent')}>Remind to pay</Button>
              )}
              {detail.status === 'paid' && (
                <Button type="primary" onClick={() => message.success('Marked as shipped')}>Mark as shipped</Button>
              )}
              {detail.status === 'shipped' && (
                <Button type="primary" onClick={() => message.info('Tracking opened')}>Track shipment</Button>
              )}
              {detail.status === 'refunded' && (
                <Button onClick={() => message.info('This lot got no bid; the deposit was refunded to the original method')}>Refund record</Button>
              )}
              <Button onClick={() => setDetail(null)}>Close</Button>
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
              <Descriptions.Item label="Order no.">
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{detail.no}</span>
              </Descriptions.Item>
              <Descriptions.Item label="Lot">{detail.item}</Descriptions.Item>
              <Descriptions.Item label="Final price">
                {detail.price === 0 ? <span style={{ color: '#bbb' }}>No bid</span> : <span className="num-red">¥{fmtMoney(detail.price)}</span>}
              </Descriptions.Item>
              <Descriptions.Item label="Buyer">{detail.buyer}</Descriptions.Item>
              <Descriptions.Item label="Deposit">
                <span className="num-strong">¥{fmtMoney(detail.deposit)}</span>
              </Descriptions.Item>
              <Descriptions.Item label="Status">
                <Tag color={STATUS_META[detail.status].color}>{STATUS_META[detail.status].text}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Closed at">{detail.time}</Descriptions.Item>
            </Descriptions>

            <div style={{ fontWeight: 600, marginBottom: 12 }}>Fulfilment progress</div>
            {detail.status === 'refunded' ? (
              <div style={{ color: '#999', marginBottom: 20, fontSize: 13 }}>
                This lot received no bid, so there was no sale; the ¥{fmtMoney(detail.deposit)} deposit was refunded to the buyer and there is no fulfilment flow.
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

            <div style={{ fontWeight: 600, marginBottom: 8 }}>Shipping details</div>
            <div style={{ color: '#555', fontSize: 13, lineHeight: 1.9, marginBottom: 4 }}>
              <div>Recipient: {detail.buyer} (demo data)</div>
              <div>Phone: 138****{detail.key.padStart(4, '0')}</div>
              <div>Address: **** Street, Chaoyang District, Beijing (redacted demo address)</div>
            </div>
            <div style={{ color: '#bbb', fontSize: 12, marginBottom: 20 }}>* Shipping details are simulated demo data; the buyer's own entry is authoritative</div>

            {(detail.status === 'shipped' || detail.status === 'done') && (
              <>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>Shipment</div>
                <div style={{ color: '#555', fontSize: 13, lineHeight: 1.9, marginBottom: 20 }}>
                  <div>Carrier: SF Express</div>
                  <div>Tracking no.: <span style={{ fontVariantNumeric: 'tabular-nums' }}>SF{detail.no.slice(-10)}</span> (demo)</div>
                </div>
              </>
            )}

            <div style={{ color: '#999', fontSize: 12, background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 6, padding: '10px 12px', lineHeight: 1.7 }}>
              The result can be shared to the buyer's mobile H5 page, where the buyer opens the link
              <span style={{ fontVariantNumeric: 'tabular-nums', color: '#555' }}> #/m?order={detail.no} </span>
              and views it without logging in.
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
