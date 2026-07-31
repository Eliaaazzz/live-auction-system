import { Routes, Route, Navigate } from 'react-router-dom';
import Showcase from './showcase/Showcase';
import MobileApp from './mobile/MobileApp';
import AdminApp from './admin/AdminApp';
import SellerGate from './admin/SellerGate';

/**
 * Routes
 *  /            desktop: both sides shown in one frame; phone: goes straight to the full-screen,
 *               swipeable /m mobile app
 *  /m           the mobile buyer app - full screen and interactive (a phone gets the native experience directly)
 *  /admin/*     the PC admin console - a full Ant Design back office
 */
function Home() {
  // A phone or narrow screen goes straight into the full-screen mobile room (swipeable) rather than the desktop side-by-side view.
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
