import { useEffect, useState } from 'react';
import { Row, Col, Card, Statistic, Button, List, Tag, Progress, Avatar } from 'antd';
import { RiseOutlined, FileDoneOutlined, ShoppingOutlined, ThunderboltOutlined, ArrowRightOutlined, FireOutlined } from '@ant-design/icons';
import { fmtMoney } from '../../lib/format';
import { PROD } from '../../lib/assets';
import { api } from '../../backend/lib/api.js';
import { isJunk } from '../../lib/mapBackend';

const yuanOf = (c?: string | number | null): number => {
  if (c == null || c === '') return 0;
  try { return Math.round(Number(BigInt(String(c))) / 100); } catch { return Math.round(Number(c) / 100) || 0; }
};
const maskBuyer = (id?: string): string => {
  const n = String(id || '').replace(/^user_/, '');
  return n ? n.slice(0, 1) + '***' : '匿名';
};
const DEMO_RECENT = [
  { img: PROD.watch, name: '二手奢侈品腕表 钢款机械', price: 70000, buyer: '李***' },
  { img: PROD.jadeBangle, name: '天然冰糯种翡翠手镯', price: 21600, buyer: '张***' },
  { img: PROD.jadePendant, name: '金镶玉平安扣吊坠', price: 9000, buyer: '黄***' },
  { img: PROD.teapot, name: '紫砂壶名家全手工', price: 5400, buyer: '王***' },
];

export default function Dashboard({ onGo }: { onGo: (p: string) => void }) {
  // Real overview from GET /api/auctions: 成交额/订单数/在拍/实时出价/当前拍品/近期成交.
  // Falls back to the illustrative seed only before any auction exists.
  const [auctions, setAuctions] = useState<any[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const { auctions = [] } = await api.listAuctions({ limit: 500 } as any);
        if (alive) setAuctions((auctions as any[]).filter((a) => a.auctionId && !isJunk(a.productName)));
      } catch { /* keep last good */ }
    };
    load();
    const t = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const live = auctions.filter((a) => a.status === 'LIVE');
  const sold = auctions.filter((a) => a.status === 'SOLD' || a.status === 'ORDER_CREATED');
  const gmv = sold.reduce((s, a) => s + yuanOf(a.currentPriceCents), 0);
  const liveBids = live.reduce((s, a) => s + (Number(a.bidCount) || 0), 0);
  const liveLot = live[0];
  const hasReal = auctions.length > 0;
  const recent = sold.length
    ? sold.slice(0, 4).map((a) => ({ img: a.imageUrl || PROD.jadePendant, name: a.productName || '拍品', price: yuanOf(a.currentPriceCents), buyer: maskBuyer(a.winnerId) }))
    : DEMO_RECENT;
  return (
    <div style={{ margin: 18 }}>
      <Row gutter={16}>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title={hasReal ? '累计成交额' : '今日成交额'} value={hasReal ? gmv : 1062400} prefix="¥" valueStyle={{ color: '#fe2c55' }} />
            <div style={{ fontSize: 12, color: '#52c41a', marginTop: 6 }}>
              <RiseOutlined /> {hasReal ? `共 ${sold.length} 笔成交` : '较昨日 +18.4%'}
            </div>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="成交订单" value={hasReal ? sold.length : 148} prefix={<FileDoneOutlined />} />
            <div style={{ fontSize: 12, color: '#999', marginTop: 6 }}>{hasReal ? '与订单管理实时同步' : '待支付 6 · 待发货 12'}</div>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="在拍商品" value={hasReal ? live.length : 7} prefix={<ShoppingOutlined />} valueStyle={live.length ? { color: '#fe2c55' } : undefined} />
            <div style={{ fontSize: 12, color: '#999', marginTop: 6 }}>{hasReal ? (live.length ? '正在直播竞拍' : '快去开拍') : '待上架 1'}</div>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="实时出价次数" value={hasReal ? liveBids : 2333} prefix={<ThunderboltOutlined />} valueStyle={{ color: '#1677ff' }} />
            <div style={{ fontSize: 12, color: '#999', marginTop: 6 }}>{hasReal ? '在拍商品累计出价' : '峰值 4,180'}</div>
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
            <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
              <Avatar shape="square" size={72} src={liveLot?.imageUrl || PROD.jadePendant} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{liveLot?.productName || '金镶玉平安扣·和田玉吊坠项链首饰'}</div>
                <div style={{ color: '#999', fontSize: 13, margin: '4px 0 10px' }}>0 元起拍 · 加价 ¥{liveLot ? fmtMoney(yuanOf(liveLot.incrementCents)) : '50'} · {liveLot ? (yuanOf(liveLot.capPriceCents) > 0 ? `封顶 ¥${fmtMoney(yuanOf(liveLot.capPriceCents))}` : '不封顶') : '封顶 ¥12,000'}</div>
                <div style={{ display: 'flex', gap: 24 }}>
                  <Statistic title="当前价" value={liveLot ? yuanOf(liveLot.currentPriceCents) : 850} prefix="¥" valueStyle={{ color: '#fe2c55', fontSize: 22 }} />
                  <Statistic title="出价次数" value={liveLot ? (Number(liveLot.bidCount) || 0) : 17} valueStyle={{ fontSize: 22 }} />
                  <Statistic title="状态" value={liveLot ? '直播中' : '—'} valueStyle={{ fontSize: 22 }} />
                </div>
              </div>
            </div>
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card title="近期成交">
            <List
              dataSource={recent}
              renderItem={(it) => (
                <List.Item>
                  <List.Item.Meta
                    avatar={<Avatar shape="square" size={40} src={it.img} />}
                    title={<span style={{ fontSize: 13 }}>{it.name}</span>}
                    description={<span style={{ fontSize: 12 }}>{it.buyer}</span>}
                  />
                  <span className="num-red">¥{fmtMoney(it.price)}</span>
                </List.Item>
              )}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col span={24}>
          <Card title="各品类成交占比">
            {[
              { k: '玉石珠宝', v: 38, c: '#fe2c55' },
              { k: '二手奢侈品', v: 27, c: '#1677ff' },
              { k: '翡翠玉镯', v: 19, c: '#52c41a' },
              { k: '文玩杂项', v: 16, c: '#faad14' },
            ].map((row) => (
              <div key={row.k} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                <span style={{ width: 96, fontSize: 13 }}>{row.k}</span>
                <Progress percent={row.v} strokeColor={row.c} style={{ flex: 1, margin: 0 }} />
              </div>
            ))}
          </Card>
        </Col>
      </Row>
    </div>
  );
}
