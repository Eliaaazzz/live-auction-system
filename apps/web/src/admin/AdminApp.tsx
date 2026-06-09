import { useState } from 'react';
import { ConfigProvider, Layout, Menu, theme, Badge, Avatar, App as AntdApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import 'dayjs/locale/zh-cn';
import {
  DashboardOutlined,
  CloudUploadOutlined,
  AppstoreOutlined,
  FileDoneOutlined,
  FundOutlined,
  BellOutlined,
  UserOutlined,
} from '@ant-design/icons';
import Dashboard from './pages/Dashboard';
import ProductManage from './pages/ProductManage';
import AuctionPublish from './pages/AuctionPublish';
import OrderManage from './pages/OrderManage';
import LiveMonitor from './pages/LiveMonitor';
import './admin.css';

const { Sider, Header, Content } = Layout;

type PageKey = 'dashboard' | 'products' | 'publish' | 'orders' | 'monitor';

const MENU = [
  { key: 'dashboard', icon: <DashboardOutlined />, label: '数据概览' },
  { key: 'publish', icon: <CloudUploadOutlined />, label: '竞拍发布' },
  { key: 'products', icon: <AppstoreOutlined />, label: '直播商品' },
  { key: 'orders', icon: <FileDoneOutlined />, label: '订单管理' },
  { key: 'monitor', icon: <FundOutlined />, label: '实时竞拍监控' },
];

const TITLES: Record<PageKey, string> = {
  dashboard: '数据概览',
  publish: '竞拍发布',
  products: '直播商品管理',
  orders: '订单管理',
  monitor: '实时竞拍监控',
};

export default function AdminApp() {
  const [page, setPage] = useState<PageKey>('products');
  const [collapsed, setCollapsed] = useState(false);

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: { colorPrimary: '#fe2c55', borderRadius: 8, fontSize: 14 },
        components: { Layout: { siderBg: '#15151d', triggerBg: '#0f0f16' } },
      }}
    >
      <AntdApp>
        <Layout className="admin-root">
          <Sider collapsible collapsed={collapsed} onCollapse={setCollapsed} width={216} theme="dark">
            <div className="admin-logo">
              <span className="mark">🔨</span>
              {!collapsed && <span>实时竞拍大师 · 后台</span>}
            </div>
            <Menu
              theme="dark"
              mode="inline"
              selectedKeys={[page]}
              items={MENU}
              onClick={(e) => setPage(e.key as PageKey)}
              style={{ background: 'transparent', borderInlineEnd: 'none' }}
            />
          </Sider>

          <Layout>
            <Header className="admin-header" style={{ height: 56, lineHeight: '56px' }}>
              <span className="title">{TITLES[page]}</span>
              <div style={{ flex: 1 }} />
              <Badge status="processing" text={<span style={{ color: '#fe2c55', fontWeight: 600 }}>直播中</span>} />
              <BellOutlined style={{ fontSize: 18, color: '#666' }} />
              <Avatar size={32} icon={<UserOutlined />} style={{ background: '#fe2c55' }} />
              <span style={{ fontSize: 13, color: '#333' }}>马大瓜珠宝</span>
            </Header>

            <Content style={{ overflow: 'auto' }}>
              {page === 'dashboard' && <Dashboard onGo={(p) => setPage(p as PageKey)} />}
              {page === 'products' && <ProductManage />}
              {page === 'publish' && <AuctionPublish />}
              {page === 'orders' && <OrderManage />}
              {page === 'monitor' && <LiveMonitor />}
            </Content>
          </Layout>
        </Layout>
      </AntdApp>
    </ConfigProvider>
  );
}

/** 与移动端共用的展示主题色 */
export { theme };
