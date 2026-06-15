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
  return n ? n.slice(0, 1) + '***' : '匿名';
};

// 品类启发式归类（列表 DTO 不带 category；按名称关键词归桶，仅用于占比图示意）。
const CAT_RULES: { k: string; re: RegExp; c: string }[] = [
  { k: '名表', re: /表|时计|chrono|watch/i, c: '#fe2c55' },
  { k: '箱包', re: /包|bag|tote/i, c: '#1677ff' },
  { k: '鞋履', re: /鞋|sneaker|靴/i, c: '#faad14' },
  { k: '服饰', re: /衣|裙|套装|外套|服/i, c: '#52c41a' },
];
function catOf(name: string): { k: string; c: string } {
  for (const r of CAT_RULES) if (r.re.test(name)) return { k: r.k, c: r.c };
  return { k: '其他', c: '#b98cf2' };
}

// #261-4b/5/11: 数据概览全面真数据 — 累计成交额 / 成交订单 / 近期成交 / 实时出价
// 次数全部从同一份 GET /api/auctions 推导（同源必同步），不再用迪奥等假占位数据
// 垫底。没有数据时给行动化空状态，而不是看起来像成交了的假列表。
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

  // 近期成交管理（查看 + 多选/全选硬删除）。成交项均为终态，可直接删除；删除走后端
  // DELETE /api/auctions/{id}，连带订单/事件一并清除，不可恢复（与发布历史同源）。
  const [manage, setManage] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const live = auctions.filter((a) => a.status === 'LIVE');
  const sold = auctions.filter((a) => a.status === 'SOLD' || a.status === 'ORDER_CREATED');
  const gmv = sold.reduce((s, a) => s + yuanOf(a.currentPriceCents), 0);
  const liveBids = live.reduce((s, a) => s + (Number(a.bidCount) || 0), 0);
  const liveLot = live[0];
  // 平时看最近 4 笔；进入管理后展开更多（最多 20）方便逐条清理。
  const recent = (manage ? sold.slice(0, 20) : sold.slice(0, 4)).map((a) => ({
    id: a.auctionId as string, img: a.imageUrl || PROD.watch, name: a.productName || '拍品',
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
    if (ids.length === 0) { message.warning('请勾选要删除的成交'); return; }
    setDeleting(true);
    try {
      await ensureSession('seller-demo');
      const results = await Promise.allSettled(ids.map((id) => api.deleteAuction(id)));
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const fail = results.length - ok;
      if (ok > 0) message.success(`已永久删除 ${ok} 笔成交${fail ? `，${fail} 笔失败` : ''}`);
      else message.error('删除失败：' + ((results[0] as PromiseRejectedResult | undefined)?.reason?.message || '请重试'));
      setSelected(new Set());
      await load();
    } catch (e: any) {
      message.error('删除失败：' + (e?.message || e));
    } finally {
      setDeleting(false);
    }
  };

  // 各品类成交占比 — 从真实成交推导；无成交不渲染假图。
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
            <Statistic title="累计成交额" value={gmv} prefix="¥" valueStyle={{ color: '#fe2c55' }} />
            <div style={{ fontSize: 12, color: sold.length ? '#52c41a' : '#999', marginTop: 6 }}>
              <RiseOutlined /> {sold.length ? `共 ${sold.length} 笔成交` : '落锤成交后实时累计'}
            </div>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="成交订单" value={sold.length} prefix={<FileDoneOutlined />} />
            <div style={{ fontSize: 12, color: '#999', marginTop: 6 }}>与订单管理实时同步</div>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="在拍商品" value={live.length} prefix={<ShoppingOutlined />} valueStyle={live.length ? { color: '#fe2c55' } : undefined} />
            <div style={{ fontSize: 12, color: '#999', marginTop: 6 }}>{live.length ? '与直播商品页一一对应' : '快去开拍'}</div>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="实时出价次数" value={liveBids} prefix={<ThunderboltOutlined />} valueStyle={{ color: '#1677ff' }} />
            <div style={{ fontSize: 12, color: '#999', marginTop: 6 }}>在拍商品累计出价 · 与出价历史同步</div>
          </Card>
        </Col>
      </Row>

      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col xs={24} lg={14}>
          <Card
            title={
              <span>
                <FireOutlined style={{ color: '#fe2c55' }} /> 正在直播 · 当前拍品
              </span>
            }
            extra={
              <Button type="link" onClick={() => onGo('monitor')}>
                进入实时监控 <ArrowRightOutlined />
              </Button>
            }
          >
            {liveLot ? (
              <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                <Avatar shape="square" size={72} src={liveLot.imageUrl || PROD.watch} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{liveLot.productName || '直播拍品'}</div>
                  <div style={{ color: '#999', fontSize: 13, margin: '4px 0 10px' }}>0 元起拍 · 加价 ¥{fmtMoney(yuanOf(liveLot.incrementCents))} · {yuanOf(liveLot.capPriceCents) > 0 ? `封顶 ¥${fmtMoney(yuanOf(liveLot.capPriceCents))}` : '不封顶'}</div>
                  <div style={{ display: 'flex', gap: 24 }}>
                    <Statistic title="当前价" value={yuanOf(liveLot.currentPriceCents)} prefix="¥" valueStyle={{ color: '#fe2c55', fontSize: 22 }} />
                    <Statistic title="出价次数" value={Number(liveLot.bidCount) || 0} valueStyle={{ fontSize: 22 }} />
                    <Statistic title="状态" value="直播中" valueStyle={{ fontSize: 22 }} />
                  </div>
                </div>
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无正在直播的拍品" style={{ margin: '24px 0' }}>
                <Button type="primary" onClick={() => onGo('publish')}>去竞拍发布开拍</Button>
              </Empty>
            )}
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card
            title="近期成交"
            extra={sold.length > 0 && (manage ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Popconfirm
                  title={`永久删除选中的 ${selectedCount} 笔成交？`}
                  description="将从后端彻底删除（含订单 / 竞价记录），不可恢复"
                  okText="永久删除"
                  cancelText="再想想"
                  okButtonProps={{ danger: true }}
                  onConfirm={onDeleteSelected}
                  disabled={selectedCount === 0}
                >
                  <Button danger size="small" icon={<DeleteOutlined />} loading={deleting} disabled={selectedCount === 0}>
                    删除{selectedCount > 0 ? ` (${selectedCount})` : ''}
                  </Button>
                </Popconfirm>
                <Button type="link" size="small" onClick={exitManage}>完成</Button>
              </span>
            ) : (
              <Button type="link" size="small" icon={<DeleteOutlined />} onClick={() => setManage(true)}>管理</Button>
            ))}
          >
            {recent.length ? (
              <>
                {manage && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '2px 0 12px', borderBottom: '1px solid #f5f5f5', marginBottom: 4 }}>
                    <Checkbox checked={allSelected} indeterminate={!allSelected && selectedCount > 0} onChange={toggleSelectAll}>全选</Checkbox>
                    <span style={{ color: '#999', fontSize: 12 }}>共 {sold.length} 笔成交 · 勾选后点「删除」永久清除</span>
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
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无成交 · 落锤后实时出现" style={{ margin: '24px 0' }} />
            )}
          </Card>
        </Col>
      </Row>

      {catRows.length > 0 && (
        <Row gutter={16} style={{ marginTop: 16 }}>
          <Col span={24}>
            <Card title="各品类成交占比">
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
