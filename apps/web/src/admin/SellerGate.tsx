import { useEffect, useState, type ReactNode } from 'react';
import { Button, Card, Input, Typography, Alert, Space } from 'antd';
import { ShopOutlined, KeyOutlined } from '@ant-design/icons';
import { currentRole, sellerLogin } from '../backend/lib/auth.js';

/**
 * SellerGate (#260-4) - the seller login guard wrapping /admin/*.
 *
 * Previously anyone opening /admin landed straight in the merchant console. Now a seller key must first be
 * exchanged for a session in the seller_* namespace (auth.js sellerLogin): when the server sets
 * LUMEN_SELLER_KEY the key must match, and the create endpoints for products/auctions/uploads only accept a
 * seller_* identity (requireSeller). When it is unset the gate is open (backwards compatible with dev,
 * demo, and load-seed flows) and any non-empty key gets in.
 *
 * The fixed nickname 'seller-demo': every admin page hard-codes ensureSession('seller-demo'), and the guard
 * logs in with the same nickname, so the page-side session reuse check (same nickname) hits the cache and an
 * ordinary login cannot displace the seller session.
 *
 * The desktop Showcase embeds <AdminApp/> directly (the three-panel demo) and bypasses this guard - that is
 * the judges' demo panel, and real asset creation is still protected server-side by requireSeller.
 */
export default function SellerGate({ children }: { children: ReactNode }) {
  const [ok, setOk] = useState(() => currentRole() === 'seller');
  const [key, setKey] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // On an invalid token (api.js 401 -> clearSession) fall back to the login gate.
  useEffect(() => {
    const onExpired = () => setOk(currentRole() === 'seller');
    window.addEventListener('lumen:session-expired', onExpired);
    return () => window.removeEventListener('lumen:session-expired', onExpired);
  }, []);

  if (ok) return <>{children}</>;

  const submit = async () => {
    const k = key.trim();
    if (!k) { setErr('Enter the seller key'); return; }
    setBusy(true);
    setErr(null);
    try {
      await sellerLogin(k);
      setOk(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Sign-in failed, please retry');
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
            <Typography.Title level={4} style={{ margin: 0 }}>Seller centre</Typography.Title>
            <Typography.Text type="secondary">Enter the seller key to open the live auction console</Typography.Text>
          </div>

          {err && <Alert type="error" message={err} showIcon />}

          <Input.Password
            size="large"
            prefix={<KeyOutlined style={{ color: 'rgba(0,0,0,0.3)' }} />}
            placeholder="Seller key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onPressEnter={submit}
            autoFocus
          />
          <Button type="primary" size="large" block loading={busy} onClick={submit}>
            Enter the seller centre
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12, textAlign: 'center', display: 'block' }}>
            Buyers should go to /m on mobile to take part
          </Typography.Text>
        </Space>
      </Card>
    </div>
  );
}
