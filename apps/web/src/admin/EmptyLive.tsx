import { Button } from 'antd';
import { VideoCameraOutlined, PlusOutlined } from '@ant-design/icons';

/**
 * Friendly empty state for 直播商品 / 实时竞拍监控 when nothing is live.
 * Replaces the bare antd spinner-over-grey-text with a warm "去直播吧" prompt.
 */
export function EmptyLive({ onGo, title = '暂无商品直播', hint = '快去直播吧 :-)' }: { onGo?: () => void; title?: string; hint?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 20px', textAlign: 'center' }}>
      <div
        style={{
          width: 88, height: 88, borderRadius: '50%', marginBottom: 18,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'linear-gradient(135deg, #ffe3e9, #fff5f7)',
          boxShadow: '0 6px 22px rgba(254,44,85,0.12)',
        }}
      >
        <VideoCameraOutlined style={{ fontSize: 40, color: '#fe2c55' }} />
      </div>
      <div style={{ fontSize: 17, fontWeight: 700, color: '#222', marginBottom: 6 }}>{title}</div>
      <div style={{ color: '#9a9aa5', fontSize: 14, marginBottom: onGo ? 20 : 0 }}>
        快去直播吧 <span style={{ color: '#fe2c55', fontWeight: 700 }}>:-)</span>
      </div>
      {onGo && (
        <Button type="primary" size="large" icon={<PlusOutlined />} onClick={onGo}>
          去竞拍发布开拍
        </Button>
      )}
    </div>
  );
}

export default EmptyLive;
