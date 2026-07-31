import { useState } from 'react';
import { ConfigProvider, Layout, Menu, theme, Badge, Avatar, Button, App as AntdApp } from 'antd';
import enUS from 'antd/locale/en_US';
import 'dayjs/locale/en';
import {
  DashboardOutlined,
  CloudUploadOutlined,
  AppstoreOutlined,
  FileDoneOutlined,
  FundOutlined,
  BellOutlined,
  UserOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
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
  { key: 'dashboard', icon: <DashboardOutlined />, label: 'Dashboard' },
  { key: 'publish', icon: <CloudUploadOutlined />, label: 'Publish auction' },
  { key: 'products', icon: <AppstoreOutlined />, label: 'Live products' },
  { key: 'orders', icon: <FileDoneOutlined />, label: 'Orders' },
  { key: 'monitor', icon: <FundOutlined />, label: 'Live monitor' },
];

const TITLES: Record<PageKey, string> = {
  dashboard: 'Dashboard',
  publish: 'Publish auction',
  products: 'Live product management',
  orders: 'Order management',
  monitor: 'Live auction monitor',
};

/**
 * AdminApp
 *  embedded         true when rendered inside the Showcase page's Chrome window: uses height:100% to fill
 *                   the window rather than 100vh (which would overflow the fixed-height window and get clipped).
 *  defaultCollapsed whether the sidebar starts collapsed.
 *
 * Sidebar collapse: we do not use AntD's default position:fixed trigger bar (it anchors to the bottom of
 * the browser viewport and gets clipped by the Showcase window's overflow:hidden, so it appears stuck).
 * Instead a collapse button sits in the top bar, which works in both cases (full-screen /admin and
 * embedded in Showcase).
 */
export default function AdminApp({
  embedded = false,
  defaultCollapsed = false,
}: {
  embedded?: boolean;
  defaultCollapsed?: boolean;
} = {}) {
  const [page, setPage] = useState<PageKey>('products');
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  const fullHeight = embedded ? '100%' : '100vh';

  return (
    <ConfigProvider
      locale={enUS}
      theme={{
        token: { colorPrimary: '#fe2c55', borderRadius: 8, fontSize: 14 },
        components: { Layout: { siderBg: '#15151d', triggerBg: '#0f0f16' } },
      }}
    >
      <AntdApp>
        <Layout className={'admin-root' + (embedded ? ' admin-embedded' : '')} style={{ minHeight: fullHeight, height: embedded ? '100%' : undefined }}>
          <Sider
            collapsible
            collapsed={collapsed}
            onCollapse={setCollapsed}
            trigger={null}
            width={216}
            collapsedWidth={64}
            theme="dark"
            style={{ minHeight: fullHeight, height: embedded ? '100%' : undefined }}
          >
            <div className="admin-logo">
              <span className="mark">🔨</span>
              {!collapsed && <span>Real-Time Auction Master - Admin</span>}
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
              <Button
                type="text"
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                className="admin-fold"
                icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                onClick={() => setCollapsed((c) => !c)}
              />
              <span className="title">{TITLES[page]}</span>
              <div style={{ flex: 1 }} />
              <Badge status="processing" text={<span style={{ color: '#fe2c55', fontWeight: 600 }}>Live</span>} />
              <BellOutlined style={{ fontSize: 18, color: '#666' }} />
              <Avatar size={32} icon={<UserOutlined />} style={{ background: '#fe2c55' }} />
              <span className="seller-name">Marcus Fine Jewellery</span>
            </Header>

            <Content
              style={{
                background: '#f5f6f8',
                minHeight: embedded ? 0 : 'calc(100vh - 56px)',
                height: embedded ? 'calc(100% - 56px)' : undefined,
                overflow: 'auto',
              }}
            >
              {page === 'dashboard' && <Dashboard onGo={(p) => setPage(p as PageKey)} />}
              {page === 'products' && <ProductManage onGo={(p) => setPage(p as PageKey)} />}
              {page === 'publish' && <AuctionPublish />}
              {page === 'orders' && <OrderManage />}
              {page === 'monitor' && <LiveMonitor onGo={(p) => setPage(p as PageKey)} />}
            </Content>
          </Layout>
        </Layout>
      </AntdApp>
    </ConfigProvider>
  );
}

/** The display theme colour shared with the mobile side */
export { theme };
