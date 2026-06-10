import { useEffect, useState, type ReactNode } from 'react';
import { Button, Card, Input, Typography, Alert, Space } from 'antd';
import { ShopOutlined, KeyOutlined } from '@ant-design/icons';
import { currentRole, sellerLogin } from '../backend/lib/auth.js';

/**
 * SellerGate (#260-4) — 包裹 /admin/* 的卖家登录守卫。
 *
 * 之前任何人打开 /admin 都直接进商家后台。现在需要先用「卖家密钥」换一个
 * seller_* 命名空间的会话（auth.js sellerLogin）：服务端配置 LUMEN_SELLER_KEY
 * 时密钥必须匹配，且商品/拍卖/上传等创建接口只认 seller_* 身份（requireSeller）；
 * 未配置时为开放模式（向后兼容 dev/演示/压测种子流程），任意非空密钥可进。
 *
 * 固定昵称 'seller-demo'：admin 各页面硬编码 ensureSession('seller-demo')，
 * 守卫用同一昵称登录，页面侧的会话复用检查（昵称相同）就会命中缓存，
 * 不会用普通登录把 seller 会话顶掉。
 *
 * 桌面 Showcase 直接内嵌 <AdminApp/>（演示三联屏），不经过本守卫 —— 那是
 * 评委演示面板；真正的资产创建在服务端仍受 requireSeller 保护。
 */
export default function SellerGate({ children }: { children: ReactNode }) {
  const [ok, setOk] = useState(() => currentRole() === 'seller');
  const [key, setKey] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Token 失效（api.js 401 → clearSession）时回到登录门。
  useEffect(() => {
    const onExpired = () => setOk(currentRole() === 'seller');
    window.addEventListener('lumen:session-expired', onExpired);
    return () => window.removeEventListener('lumen:session-expired', onExpired);
  }, []);

  if (ok) return <>{children}</>;

  const submit = async () => {
    const k = key.trim();
    if (!k) { setErr('请输入卖家密钥'); return; }
    setBusy(true);
    setErr(null);
    try {
      await sellerLogin(k);
      setOk(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '登录失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100%',
        display: 'grid',
        placeItems: 'center',
        background: 'radial-gradient(1200px 600px at 50% -10%, #1d2333, #0d0d12 70%)',
        padding: 24,
      }}
    >
      <Card style={{ width: 380, borderRadius: 16, boxShadow: '0 24px 64px rgba(0,0,0,0.45)' }}>
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <div style={{ textAlign: 'center' }}>
            <div
              style={{
                width: 56, height: 56, margin: '0 auto 12px', borderRadius: 16,
                display: 'grid', placeItems: 'center', color: '#fff', fontSize: 26,
                background: 'linear-gradient(135deg, #fe2c55, #ff7a8a)',
              }}
            >
              <ShopOutlined />
            </div>
            <Typography.Title level={4} style={{ margin: 0 }}>卖家中心</Typography.Title>
            <Typography.Text type="secondary">输入卖家密钥进入直播竞拍管理后台</Typography.Text>
          </div>

          {err && <Alert type="error" message={err} showIcon />}

          <Input.Password
            size="large"
            prefix={<KeyOutlined style={{ color: 'rgba(0,0,0,0.3)' }} />}
            placeholder="卖家密钥"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onPressEnter={submit}
            autoFocus
          />
          <Button type="primary" size="large" block loading={busy} onClick={submit}>
            进入卖家中心
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12, textAlign: 'center', display: 'block' }}>
            买家请访问手机端 /m 参与竞拍
          </Typography.Text>
        </Space>
      </Card>
    </div>
  );
}
