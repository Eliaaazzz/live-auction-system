import { Row, Col, Card, Statistic, Button, List, Tag, Progress, Avatar } from 'antd';
import { RiseOutlined, FileDoneOutlined, ShoppingOutlined, TeamOutlined, ArrowRightOutlined, FireOutlined } from '@ant-design/icons';
import { fmtMoney } from '../../lib/format';
import { PROD } from '../../lib/assets';

export default function Dashboard({ onGo }: { onGo: (p: string) => void }) {
  const recent = [
    { img: PROD.watch, name: '二手奢侈品腕表 钢款机械', price: 70000, buyer: '李***' },
    { img: PROD.jadeBangle, name: '天然冰糯种翡翠手镯', price: 21600, buyer: '张***' },
    { img: PROD.jadePendant, name: '金镶玉平安扣吊坠', price: 9000, buyer: '黄***' },
    { img: PROD.teapot, name: '紫砂壶名家全手工', price: 5400, buyer: '王***' },
  ];
  return (
    <div style={{ margin: 18 }}>
      <Row gutter={16}>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="今日成交额" value={1062400} prefix="¥" valueStyle={{ color: '#fe2c55' }} />
            <div style={{ fontSize: 12, color: '#52c41a', marginTop: 6 }}>
              <RiseOutlined /> 较昨日 +18.4%
            </div>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="成交订单" value={148} prefix={<FileDoneOutlined />} />
            <div style={{ fontSize: 12, color: '#999', marginTop: 6 }}>待支付 6 · 待发货 12</div>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="在拍商品" value={7} prefix={<ShoppingOutlined />} />
            <div style={{ fontSize: 12, color: '#999', marginTop: 6 }}>待上架 1</div>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="直播间实时在线" value={2333} prefix={<TeamOutlined />} valueStyle={{ color: '#1677ff' }} />
            <div style={{ fontSize: 12, color: '#999', marginTop: 6 }}>峰值 4,180</div>
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
              <Avatar shape="square" size={72} src={PROD.jadePendant} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>金镶玉平安扣·和田玉吊坠项链首饰</div>
                <div style={{ color: '#999', fontSize: 13, margin: '4px 0 10px' }}>0 元起拍 · 加价 ¥50 · 封顶 ¥12,000</div>
                <div style={{ display: 'flex', gap: 24 }}>
                  <Statistic title="当前价" value={850} prefix="¥" valueStyle={{ color: '#fe2c55', fontSize: 22 }} />
                  <Statistic title="出价次数" value={17} valueStyle={{ fontSize: 22 }} />
                  <Statistic title="参与人数" value={9} valueStyle={{ fontSize: 22 }} />
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
