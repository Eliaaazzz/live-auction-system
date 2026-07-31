import { useCallback, useEffect, useRef, useState } from 'react';
import { Row, Col, Card, Statistic, Button, List, Progress, Avatar, Empty, Checkbox, Popconfirm, App as AntdApp } from 'antd';
import { RiseOutlined, FileDoneOutlined, ShoppingOutlined, ThunderboltOutlined, ArrowRightOutlined, FireOutlined, DeleteOutlined } from '@ant-design/icons';
import { fmtMoney } from '../../lib/format';
import { PROD } from '../../lib/assets';
import { api } from '../../backend/lib/api.js';
import { ensureSession } from '../../backend/lib/auth.js';
import { isJunk } from '../../lib/mapBackend';

const yuanOf = (c?: string | number | null): number => {
  if (c == null || c === '') return 0;
  try { return Math.round(Number(BigInt(String(c))) / 100); } catch { return Math.round(Number(c) / 100) || 0; }
};
const maskBuyer = (id?: string): string => {
  const n = String(id || '').replace(/^user_/, '');
  return n ? n.slice(0, 1) + '***' : 'Anonymous';
};

// Heuristic category bucketing (the list DTO carries no category; bucket by name keywords, used only for the share chart).
const CAT_RULES: { k: string; re: RegExp; c: string }[] = [
  { k: 'Watches', re: /watch|chrono|timepiece|rolex|patek|seiko/i, c: '#fe2c55' },
  { k: 'Bags', re: /bag|tote|purse|handbag/i, c: '#1677ff' },
  { k: 'Shoes', re: /shoe|sneaker|boot|loafer/i, c: '#faad14' },
  { k: 'Apparel', re: /suit|dress|jacket|coat|apparel|tweed/i, c: '#52c41a' },
];
function catOf(name: string): { k: string; c: string } {
  for (const r of CAT_RULES) if (r.re.test(name)) return { k: r.k, c: r.c };
  return { k: 'Other', c: '#b98cf2' };
}

// #261-4b/5/11: the dashboard is entirely real data - total GMV, sold orders, recent sales, and the
// live bid count are all derived from the same GET /api/auctions response (one source, always in sync)
// instead of placeholder rows. With no data it shows an actionable empty state rather than a fake list
// that looks like real sales.
export default function Dashboard({ onGo }: { onGo: (p: string) => void }) {
  const { message } = AntdApp.useApp();
  const [auctions, setAuctions] = useState<any[]>([]);
  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  const load = useCallback(async () => {
    try {
      const { auctions = [] } = await api.listAuctions({ limit: 500 } as any);
      if (aliveRef.current) setAuctions((auctions as any[]).filter((a) => a.auctionId && !isJunk(a.productName)));
    } catch { /* keep last good */ }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  // Recent-sales management (view plus multi-select / select-all hard delete). Sold items are terminal so
  // they can be deleted directly; deletion goes through the backend DELETE /api/auctions/{id}, which also
  // removes the order and events and is not recoverable (same source as the publish history).
  const [manage, setManage] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const live = auctions.filter((a) => a.status === 'LIVE');
  const sold = auctions.filter((a) => a.status === 'SOLD' || a.status === 'ORDER_CREATED');
  const gmv = sold.reduce((s, a) => s + yuanOf(a.currentPriceCents), 0);
  const liveBids = live.reduce((s, a) => s + (Number(a.bidCount) || 0), 0);
  const liveLot = live[0];
  // Normally shows the latest 4; management mode expands to more (up to 20) for easier cleanup.
  const recent = (manage ? sold.slice(0, 20) : sold.slice(0, 4)).map((a) => ({
    id: a.auctionId as string, img: a.imageUrl || PROD.watch, name: a.productName || 'Lot',
    price: yuanOf(a.currentPriceCents), buyer: maskBuyer(a.winnerId),
  }));
  const shownIds = recent.map((r) => r.id);
  const selectedCount = shownIds.filter((id) => selected.has(id)).length;
  const allSelected = shownIds.length > 0 && selectedCount === shownIds.length;
  const toggleSelect = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleSelectAll = () => setSelected(allSelected ? new Set() : new Set(shownIds));
  const exitManage = () => { setManage(false); setSelected(new Set()); };
  const onDeleteSelected = async () => {
    const ids = shownIds.filter((id) => selected.has(id));
    if (ids.length === 0) { message.warning('Select the sales to delete'); return; }
    setDeleting(true);
    try {
      await ensureSession('seller-demo');
      const results = await Promise.allSettled(ids.map((id) => api.deleteAuction(id)));
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const fail = results.length - ok;
      if (ok > 0) message.success(`Permanently deleted ${ok} sale(s)${fail ? `, ${fail} failed` : ''}`);
      else message.error('Delete failed: ' + ((results[0] as PromiseRejectedResult | undefined)?.reason?.message || 'please retry'));
      setSelected(new Set());
      await load();
    } catch (e: any) {
      message.error('Delete failed: ' + (e?.message || e));
    } finally {
      setDeleting(false);
    }
  };

  // Share of sales by category - derived from real sales; with no sales we do not render a fake chart.
  const catAgg = new Map<string, { v: number; c: string }>();
  for (const a of sold) {
    const { k, c } = catOf(String(a.productName || ''));
    const cur = catAgg.get(k) ?? { v: 0, c };
    cur.v += yuanOf(a.currentPriceCents);
    catAgg.set(k, cur);
  }
  const catRows = [...catAgg.entries()]
    .map(([k, { v, c }]) => ({ k, v, c }))
    .sort((x, y) => y.v - x.v);

  return (
    <div style={{ margin: 18 }}>
      <Row gutter={16}>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="Total GMV" value={gmv} prefix="¥" valueStyle={{ color: '#fe2c55' }} />
            <div style={{ fontSize: 12, color: sold.length ? '#52c41a' : '#999', marginTop: 6 }}>
              <RiseOutlined /> {sold.length ? `${sold.length} sale(s)` : 'Accumulates live once lots are hammered'}
            </div>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="Sold orders" value={sold.length} prefix={<FileDoneOutlined />} />
            <div style={{ fontSize: 12, color: '#999', marginTop: 6 }}>Synced live with order management</div>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="Live lots" value={live.length} prefix={<ShoppingOutlined />} valueStyle={live.length ? { color: '#fe2c55' } : undefined} />
            <div style={{ fontSize: 12, color: '#999', marginTop: 6 }}>{live.length ? 'One-to-one with the live products page' : 'Start an auction'}</div>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="Live bids" value={liveBids} prefix={<ThunderboltOutlined />} valueStyle={{ color: '#1677ff' }} />
            <div style={{ fontSize: 12, color: '#999', marginTop: 6 }}>Total bids on live lots - synced with the bid history</div>
          </Card>
        </Col>
      </Row>

      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col xs={24} lg={14}>
          <Card
            title={
              <span>
                <FireOutlined style={{ color: '#fe2c55' }} /> Live now - current lot
              </span>
            }
            extra={
              <Button type="link" onClick={() => onGo('monitor')}>
                Open live monitor <ArrowRightOutlined />
              </Button>
            }
          >
            {liveLot ? (
              <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                <Avatar shape="square" size={72} src={liveLot.imageUrl || PROD.watch} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{liveLot.productName || 'Live lot'}</div>
                  <div style={{ color: '#999', fontSize: 13, margin: '4px 0 10px' }}>Starts at zero - increment ¥{fmtMoney(yuanOf(liveLot.incrementCents))} - {yuanOf(liveLot.capPriceCents) > 0 ? `cap ¥${fmtMoney(yuanOf(liveLot.capPriceCents))}` : 'no cap'}</div>
                  <div style={{ display: 'flex', gap: 24 }}>
                    <Statistic title="Current price" value={yuanOf(liveLot.currentPriceCents)} prefix="¥" valueStyle={{ color: '#fe2c55', fontSize: 22 }} />
                    <Statistic title="Bids" value={Number(liveLot.bidCount) || 0} valueStyle={{ fontSize: 22 }} />
                    <Statistic title="Status" value="Live" valueStyle={{ fontSize: 22 }} />
                  </div>
                </div>
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No lot is live right now" style={{ margin: '24px 0' }}>
                <Button type="primary" onClick={() => onGo('publish')}>Go to Publish auction</Button>
              </Empty>
            )}
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card
            title="Recent sales"
            extra={sold.length > 0 && (manage ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Popconfirm
                  title={`Permanently delete the ${selectedCount} selected sale(s)?`}
                  description="This deletes them from the backend for good (including orders and bid records) and cannot be undone"
                  okText="Delete permanently"
                  cancelText="Cancel"
                  okButtonProps={{ danger: true }}
                  onConfirm={onDeleteSelected}
                  disabled={selectedCount === 0}
                >
                  <Button danger size="small" icon={<DeleteOutlined />} loading={deleting} disabled={selectedCount === 0}>
                    Delete{selectedCount > 0 ? ` (${selectedCount})` : ''}
                  </Button>
                </Popconfirm>
                <Button type="link" size="small" onClick={exitManage}>Done</Button>
              </span>
            ) : (
              <Button type="link" size="small" icon={<DeleteOutlined />} onClick={() => setManage(true)}>Manage</Button>
            ))}
          >
            {recent.length ? (
              <>
                {manage && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '2px 0 12px', borderBottom: '1px solid #f5f5f5', marginBottom: 4 }}>
                    <Checkbox checked={allSelected} indeterminate={!allSelected && selectedCount > 0} onChange={toggleSelectAll}>Select all</Checkbox>
                    <span style={{ color: '#999', fontSize: 12 }}>{sold.length} sale(s) - tick them and hit Delete to remove permanently</span>
                  </div>
                )}
                <List
                  dataSource={recent}
                  renderItem={(it) => (
                    <List.Item>
                      {manage && <Checkbox style={{ marginRight: 12 }} checked={selected.has(it.id)} onChange={() => toggleSelect(it.id)} />}
                      <List.Item.Meta
                        avatar={<Avatar shape="square" size={40} src={it.img} />}
                        title={<span style={{ fontSize: 13 }}>{it.name}</span>}
                        description={<span style={{ fontSize: 12 }}>{it.buyer}</span>}
                      />
                      <span className="num-red">¥{fmtMoney(it.price)}</span>
                    </List.Item>
                  )}
                />
              </>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No sales yet - they appear here in real time after the hammer" style={{ margin: '24px 0' }} />
            )}
          </Card>
        </Col>
      </Row>

      {catRows.length > 0 && (
        <Row gutter={16} style={{ marginTop: 16 }}>
          <Col span={24}>
            <Card title="Sales share by category">
              {catRows.map((row) => (
                <div key={row.k} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                  <span style={{ width: 96, fontSize: 13 }}>{row.k}</span>
                  <Progress percent={gmv > 0 ? Math.round((row.v / gmv) * 100) : 0} strokeColor={row.c} style={{ flex: 1, margin: 0 }} />
                </div>
              ))}
            </Card>
          </Col>
        </Row>
      )}
    </div>
  );
}
