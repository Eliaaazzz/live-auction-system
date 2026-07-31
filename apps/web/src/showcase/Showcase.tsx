import { Link } from 'react-router-dom';
import { useLayoutEffect, useRef, useState } from 'react';
import { IOSDevice } from '../frames/IOSDevice';
import { ChromeWindow } from '../frames/ChromeWindow';
import MobileApp from '../mobile/MobileApp';
import AdminApp from '../admin/AdminApp';

const TAGS = ['Starts at zero', 'Fixed increment', 'Cap closes the sale', 'Auto-extension', 'Millisecond live ranking', 'Skeleton fallback'];

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
            <div style={{ fontSize: 22, fontWeight: 800 }}>Douyin live auction full-stack system</div>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>Both sides live in one frame - mobile buyers bidding plus the PC merchant/host console - millisecond bidding</div>
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', gap: 10 }}>
            <Link to="/m" style={btn('#fe2c55')}>
              ▶ Full-screen mobile
            </Link>
            <Link to="/admin" style={btn('rgba(255,255,255,0.12)')}>
              🖥 Open the console full screen
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

      {/* stage — uniformly scaled triptych: 📱buyer A · 🖥 console · 📱buyer B */}
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
                <SectionLabel title="Mobile - buyer A" desc="Full-screen video with an overlay auction - 5 tabs - swipe up for the next room" />
                <IOSDevice dark width={PHONE_W} height={PHONE_H}>
                  <MobileApp startIndex={0} seat="A" />
                </IOSDevice>
              </div>

              {/* admin in chrome frame — center, sidebar foldable. #261-2: start
                  COLLAPSED inside the 1000px showcase window so the content area
                  (monitor / product table) gets the full width so everything is visible; the top-bar button expands it. */}
              <div style={{ width: ADMIN_W }}>
                <SectionLabel title="Desktop - merchant / host console" desc="Publish auction - live products - orders - live monitor - collapsible sidebar" />
                <ChromeWindow url="seller.auction-master.com/admin" width={ADMIN_W} height={PHONE_H} tabs={[{ title: 'Real-Time Auction Master - Admin' }]}>
                  <AdminApp embedded defaultCollapsed />
                </ChromeWindow>
              </div>

              {/* mobile — buyer B. SAME room as buyer A (startIndex 0): the whole
                  triptych story is buyer A vs buyer B bidding against each other in one
                  auction - the same session. With startIndex=1, B silently opened the NEXT
                  live room whenever more than one auction was live, so A and B
                  never saw each other's bids. Viewers can still swipe to other
                  rooms by hand. */}
              <div style={{ width: PHONE_W }}>
                <SectionLabel title="Mobile - buyer B" desc="Same session - bids and ranking sync in milliseconds" />
                <IOSDevice dark width={PHONE_W} height={PHONE_H}>
                  <MobileApp startIndex={0} seat="B" />
                </IOSDevice>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: STAGE_W, margin: '18px auto 0', fontSize: 12.5, color: 'rgba(255,255,255,0.45)', lineHeight: 1.7 }}>
        On a phone or narrow screen, open <code style={{ color: '#ff8fa3' }}>#/m</code> directly for the full-screen experience; the merchant console is at <code style={{ color: '#ff8fa3' }}>#/admin</code>.
        Real-time data end to end: JWT auth, REST snapshot, and a long-lived WebSocket, with atomic server-side adjudication and millisecond ranking.
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
