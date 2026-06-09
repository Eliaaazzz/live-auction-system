import { Link } from 'react-router-dom';
import { IOSDevice } from '../frames/IOSDevice';
import { ChromeWindow } from '../frames/ChromeWindow';
import MobileApp from '../mobile/MobileApp';
import AdminApp from '../admin/AdminApp';

const TAGS = ['0元起拍', '固定加价', '封顶成交', '自动延时', '毫秒级实时排名', '骨架屏兜底'];

export default function Showcase() {
  return (
    <div
      style={{
        minHeight: '100%',
        background: 'radial-gradient(120% 80% at 80% -10%, #2a1430 0%, #0d0d12 55%)',
        color: '#fff',
        fontFamily: "-apple-system, 'PingFang SC', system-ui, sans-serif",
        padding: '28px 24px 60px',
        boxSizing: 'border-box',
      }}
    >
      {/* header */}
      <div style={{ maxWidth: 1340, margin: '0 auto 22px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ width: 44, height: 44, borderRadius: 13, background: 'linear-gradient(135deg,#ff5f7e,#fe2c55)', display: 'grid', placeItems: 'center', fontSize: 24 }}>🔨</div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>抖音直播竞拍全栈系统</div>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>实时竞拍大师 · 移动端用户竞拍 + PC 商家 / 主播后台 · 毫秒级实时出价</div>
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', gap: 10 }}>
            <Link to="/m" style={btn('#fe2c55')}>
              ▶ 全屏体验移动端
            </Link>
            <Link to="/admin" style={btn('rgba(255,255,255,0.12)')}>
              🖥 全屏打开后台
            </Link>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
          {TAGS.map((t) => (
            <span key={t} style={{ fontSize: 12, padding: '5px 11px', borderRadius: 999, background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.1)' }}>
              {t}
            </span>
          ))}
        </div>
      </div>

      {/* stage */}
      <div style={{ overflowX: 'auto', paddingBottom: 12 }}>
        <div style={{ display: 'flex', gap: 40, alignItems: 'flex-start', width: 'max-content', margin: '0 auto', padding: '8px 12px' }}>
          {/* mobile in iOS frame */}
          <div>
            <SectionLabel title="移动端 · 用户端" desc="全屏视频 + 浮层竞拍 · 5 Tab · 第一/二名特制 · 上滑切换直播间" />
            <IOSDevice dark width={390} height={844}>
              <MobileApp />
            </IOSDevice>
          </div>

          {/* admin in chrome frame */}
          <div>
            <SectionLabel title="PC 端 · 商家 / 主播后台" desc="竞拍发布 · 直播商品 · 订单管理 · 实时竞拍监控" />
            <ChromeWindow url="seller.auction-master.com/admin" width={900} height={844} tabs={[{ title: '实时竞拍大师 · 后台' }]}>
              <div style={{ height: '100%' }}>
                <AdminApp />
              </div>
            </ChromeWindow>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1340, margin: '20px auto 0', fontSize: 12.5, color: 'rgba(255,255,255,0.45)', lineHeight: 1.7 }}>
        移动端在手机 / 窄屏中直接访问 <code style={{ color: '#ff8fa3' }}>#/m</code> 获得全屏体验；商家后台访问 <code style={{ color: '#ff8fa3' }}>#/admin</code>。
        全链路实时数据：JWT 鉴权 → REST 快照 → WebSocket 长连接，服务端原子裁决，毫秒级实时排名。
      </div>
    </div>
  );
}

function SectionLabel({ title, desc }: { title: string; desc: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 15, fontWeight: 700 }}>{title}</div>
      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', marginTop: 2 }}>{desc}</div>
    </div>
  );
}

function btn(bg: string): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '10px 16px',
    borderRadius: 12,
    background: bg,
    color: '#fff',
    fontSize: 13.5,
    fontWeight: 700,
    textDecoration: 'none',
    border: '1px solid rgba(255,255,255,0.12)',
  };
}
