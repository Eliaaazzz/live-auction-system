import { Link } from 'react-router-dom';
import { useLayoutEffect, useRef, useState } from 'react';
import { IOSDevice } from '../frames/IOSDevice';
import { ChromeWindow } from '../frames/ChromeWindow';
import MobileApp from '../mobile/MobileApp';
import AdminApp from '../admin/AdminApp';

const TAGS = ['0元起拍', '固定加价', '封顶成交', '自动延时', '毫秒级实时排名', '骨架屏兜底'];

// Natural (1:1) stage geometry. The whole triptych is laid out at these fixed
// sizes, then uniformly scaled to fit the viewport width — so a MacBook (≈1512 /
// 1280 logical px) shows the full 📱 · 🖥 · 📱 poster with no horizontal scroll.
const PHONE_W = 380;
const PHONE_H = 780;
const ADMIN_W = 1000;
const GAP = 24;
const LABEL_H = 48;
const STAGE_W = PHONE_W * 2 + ADMIN_W + GAP * 2; // 1808
const STAGE_H = LABEL_H + PHONE_H; // 828

export default function Showcase() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  // Scale-to-fit: measure the available content width and shrink the stage so it
  // never overflows. Caps at 1 so it never blows up past its natural size.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setScale(Math.min(1, el.clientWidth / STAGE_W));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  return (
    <div
      style={{
        minHeight: '100%',
        background: 'radial-gradient(120% 80% at 80% -10%, #2a1430 0%, #0d0d12 55%)',
        color: '#fff',
        fontFamily: "-apple-system, 'PingFang SC', system-ui, sans-serif",
        padding: '28px 24px 56px',
        boxSizing: 'border-box',
      }}
    >
      {/* header */}
      <div style={{ maxWidth: STAGE_W, margin: '0 auto 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ width: 44, height: 44, borderRadius: 13, background: 'linear-gradient(135deg,#ff5f7e,#fe2c55)', display: 'grid', placeItems: 'center', fontSize: 24 }}>🔨</div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>抖音直播竞拍全栈系统</div>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>双端实时同框 · 移动端用户竞拍 + PC 商家 / 主播后台 · 毫秒级实时出价</div>
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

      {/* stage — uniformly scaled triptych: 📱买家A · 🖥 后台 · 📱买家B */}
      <div ref={wrapRef} style={{ width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          {/* footprint reserves the SCALED size so the footer below never overlaps */}
          <div style={{ width: STAGE_W * scale, height: STAGE_H * scale }}>
            <div
              style={{
                width: STAGE_W,
                height: STAGE_H,
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
                display: 'flex',
                gap: GAP,
                alignItems: 'flex-start',
              }}
            >
              {/* mobile — buyer A */}
              <div style={{ width: PHONE_W }}>
                <SectionLabel title="移动端 · 买家 A" desc="全屏视频 + 浮层竞拍 · 5 Tab · 上滑切换直播间" />
                <IOSDevice dark width={PHONE_W} height={PHONE_H}>
                  <MobileApp startIndex={0} autoGuest />
                </IOSDevice>
              </div>

              {/* admin in chrome frame — center, sidebar foldable */}
              <div style={{ width: ADMIN_W }}>
                <SectionLabel title="PC 端 · 商家 / 主播后台" desc="竞拍发布 · 直播商品 · 订单 · 实时竞拍监控 · 左侧栏可折叠" />
                <ChromeWindow url="seller.auction-master.com/admin" width={ADMIN_W} height={PHONE_H} tabs={[{ title: '实时竞拍大师 · 后台' }]}>
                  <AdminApp embedded />
                </ChromeWindow>
              </div>

              {/* mobile — buyer B (opens on the next live room) */}
              <div style={{ width: PHONE_W }}>
                <SectionLabel title="移动端 · 买家 B" desc="同场竞价 · 出价与排名毫秒级实时同步" />
                <IOSDevice dark width={PHONE_W} height={PHONE_H}>
                  <MobileApp startIndex={1} autoGuest />
                </IOSDevice>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: STAGE_W, margin: '18px auto 0', fontSize: 12.5, color: 'rgba(255,255,255,0.45)', lineHeight: 1.7 }}>
        移动端在手机 / 窄屏中直接访问 <code style={{ color: '#ff8fa3' }}>#/m</code> 获得全屏体验；商家后台访问 <code style={{ color: '#ff8fa3' }}>#/admin</code>。
        全链路实时数据：JWT 鉴权 → REST 快照 → WebSocket 长连接，服务端原子裁决，毫秒级实时排名。
      </div>
    </div>
  );
}

function SectionLabel({ title, desc }: { title: string; desc: string }) {
  return (
    <div style={{ height: LABEL_H, marginBottom: 0, overflow: 'hidden' }}>
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
