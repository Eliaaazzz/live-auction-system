import { Routes, Route, Navigate } from 'react-router-dom';
import Showcase from './showcase/Showcase';
import MobileApp from './mobile/MobileApp';
import AdminApp from './admin/AdminApp';

/**
 * Routes
 *  /            两端设计图同框展示（复用上传的 IOSDevice / ChromeWindow 设备框）
 *  /m           移动端用户端 — 全屏可交互（手机直接访问即原生体验）
 *  /admin/*     PC 管理后台 — Ant Design 完整后台
 */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Showcase />} />
      <Route path="/m" element={<MobileApp />} />
      <Route path="/admin/*" element={<AdminApp />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
