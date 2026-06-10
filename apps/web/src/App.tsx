import { Routes, Route, Navigate } from 'react-router-dom';
import Showcase from './showcase/Showcase';
import MobileApp from './mobile/MobileApp';
import AdminApp from './admin/AdminApp';
import SellerGate from './admin/SellerGate';

/**
 * Routes
 *  /            桌面：两端同框展示；手机：自动进入 /m 全屏可上滑的真移动端
 *  /m           移动端用户端 — 全屏可交互（手机直接访问即原生体验）
 *  /admin/*     PC 管理后台 — Ant Design 完整后台
 */
function Home() {
  // 手机/窄屏一进公网就直接进全屏移动直播间（可上滑切换），而不是桌面同框稿。
  const isMobile = typeof navigator !== 'undefined'
    && (/Android|iPhone|iPad|iPod|HarmonyOS|Mobile/i.test(navigator.userAgent) || window.innerWidth < 820);
  return isMobile ? <Navigate to="/m" replace /> : <Showcase />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/m" element={<MobileApp />} />
      <Route path="/admin/*" element={<SellerGate><AdminApp /></SellerGate>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
