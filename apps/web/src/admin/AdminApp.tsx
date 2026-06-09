import { useState } from 'react';
import { ConfigProvider, Layout, Menu, theme, Badge, Avatar, Button, App as AntdApp } from 'antd';
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

/**
 * AdminApp
 *  embedded         在展示页（Showcase）的 Chrome 窗口里渲染时为 true：用 height:100% 充满窗口，
 *                   而不是 100vh（否则会超出固定高度的窗口被裁掉）。
 *  defaultCollapsed 侧栏初始是否折叠。
 *
 * 侧栏折叠：不用 AntD 默认的 position:fixed 触发条（它锚定到浏览器视口底部，会被
 * Showcase 窗口的 overflow:hidden 裁掉，导致“折不动”）。改为在顶栏放一个折叠按钮，
 * 两种场景（/admin 全屏 & Showcase 内嵌）都能稳定折叠。
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
      locale={zhCN}
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
              <Button
                type="text"
                aria-label={collapsed ? '展开侧栏' : '折叠侧栏'}
                className="admin-fold"
                icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                onClick={() => setCollapsed((c) => !c)}
              />
              <span className="title">{TITLES[page]}</span>
              <div style={{ flex: 1 }} />
              <Badge status="processing" text={<span style={{ color: '#fe2c55', fontWeight: 600 }}>直播中</span>} />
              <BellOutlined style={{ fontSize: 18, color: '#666' }} />
              <Avatar size={32} icon={<UserOutlined />} style={{ background: '#fe2c55' }} />
              <span className="seller-name">马大瓜珠宝</span>
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
