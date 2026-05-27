// src/App.jsx
// Routing — maps URL paths to the screens we built.
// Backend integration happens in the route components (see RoomRoute → useRoomConnection).

import React from 'react';
import { Routes, Route, Link, Navigate, useNavigate } from 'react-router-dom';

import { MobileFrame } from './components/MobileFrame.jsx';
import { DesktopShell } from './components/DesktopShell.jsx';

import { MobileRoom, MobileHammer, MobileEvidence } from './components/mobile.jsx';
import { AdminVLMFacts, AdminConsole } from './components/admin.jsx';
import { AdminPublish, AdminOrders, AdminCancelModal } from './components/adminExtra.jsx';
import { MiniProgramStub, ConnReconnecting, ConnSyncing, ConnSchema } from './components/misc.jsx';
import { TweaksPanel } from './components/TweaksPanel.jsx';

import { LiveRoomRoute } from './routes/LiveRoomRoute.jsx';
import { EvidenceRoute } from './routes/EvidenceRoute.jsx';
import { IndexPage } from './routes/IndexPage.jsx';
import { api } from './lib/api.js';
import { ensureSession } from './lib/auth.js';
import { useParams } from 'react-router-dom';

export default function App() {
  return (
    <>
      <Routes>
      <Route path="/" element={<IndexPage/>}/>

      {/* ─── Buyer flow (mobile) ─────────────────────────── */}
      {/* Real, WS-wired room. Falls back to mock data if VITE_USE_MOCK_DATA=true. */}
      <Route path="/room/:auctionId"
        element={<MobileFrame><LiveRoomRoute/></MobileFrame>}/>

      {/* Real, REST-wired evidence card — auth-gated for the order block. */}
      <Route path="/evidence/:auctionId"
        element={<MobileFrame><EvidenceRoute/></MobileFrame>}/>

      {/* Mock variants — useful while wiring */}
      <Route path="/preview/room"          element={<MobileFrame><DemoRoom/></MobileFrame>}/>
      <Route path="/preview/room/final10"  element={<MobileFrame><DemoRoomFinal10/></MobileFrame>}/>
      <Route path="/preview/room/leading"  element={<MobileFrame><DemoRoomLeading/></MobileFrame>}/>
      <Route path="/preview/hammer"        element={<MobileFrame><MobileHammer amountCents="12880000" winnerName="海风_2024" expressive/></MobileFrame>}/>
      <Route path="/preview/evidence"      element={<MobileFrame><MobileEvidence/></MobileFrame>}/>
      <Route path="/preview/evidence/broken" element={<MobileFrame><MobileEvidence chainBreak breakAtSeq={14834}/></MobileFrame>}/>
      <Route path="/preview/mp"            element={<MobileFrame><MiniProgramStub/></MobileFrame>}/>
      <Route path="/preview/conn/reconnect" element={<MobileFrame><ConnReconnecting/></MobileFrame>}/>
      <Route path="/preview/conn/sync"      element={<MobileFrame><ConnSyncing/></MobileFrame>}/>
      <Route path="/preview/conn/schema"    element={<MobileFrame><ConnSchema/></MobileFrame>}/>

      {/* ─── Admin (desktop) ─────────────────────────────── */}
      <Route path="/admin" element={<Navigate to="/admin/auctions" replace/>}/>
      <Route path="/admin/auctions"          element={<DesktopShell title="Lumen 拍卖管理  ·  拍品 & 订单"><AdminOrders/></DesktopShell>}/>
      <Route path="/admin/auctions/new"      element={<DesktopShell title="Lumen 拍卖管理  ·  新建拍品  ·  DRAFT"><AdminPublish/></DesktopShell>}/>
      <Route path="/admin/auctions/:id/vlm"  element={<DesktopShell title="Lumen 拍卖管理  ·  VLM 事实核对"><AdminVLMFacts/></DesktopShell>}/>
      <Route path="/admin/auctions/:id/live" element={<DesktopShell title="Lumen 拍卖管理  ·  Live Console"><AdminConsole/></DesktopShell>}/>
      <Route path="/admin/auctions/:id/cancel" element={<DesktopShell title="Lumen 拍卖管理  ·  危险确认">
        <div style={{ position: 'relative', width: '100%', height: 'calc(100vh - 36px)' }}>
          <AdminConsole/>
          <CancelOverlay/>
        </div>
      </DesktopShell>}/>

      <Route path="*" element={<NotFound/>}/>
      </Routes>
      <TweaksPanel/>
    </>
  );
}

function CancelOverlay() {
  const nav = useNavigate();
  const { id } = useParams();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [currentCents, setCurrentCents] = React.useState(null);

  // #51-H4 fix: previously hardcoded '12880000' as the modal's confirm-by-
  // typing amount. It happened to match the seed `auc_demo` but would be
  // wrong for any other auction. Now fetches the real current price from
  // the backend on mount so the 2-step verify checks against ground truth.
  React.useEffect(() => {
    let alive = true;
    if (!id) return;
    (async () => {
      try {
        await ensureSession('seller-demo');
        const snap = await api.getAuction(id);
        if (!alive) return;
        // currentPriceCents '' on a brand-new SCHEDULED auction with no
        // bids; AdminCancelModal handles empty string as "0" via its
        // formatCentsCNY pipeline — but more useful for the seller is to
        // see the start price as the fallback. Backend's GetAuction
        // returns currentPriceCents per ws-envelope.md §3.2.
        setCurrentCents(snap?.currentPriceCents ?? '0');
      } catch (e) {
        // Non-fatal — modal renders with a sentinel so seller can still
        // cancel; backend ultimately enforces ownership + state.
        console.warn('[CancelOverlay] getAuction failed', e);
        if (alive) setCurrentCents('0');
      }
    })();
    return () => { alive = false; };
  }, [id]);

  const handleCancel = async () => {
    if (busy || !id) return;
    setBusy(true);
    setError(null);
    try {
      await ensureSession('seller-demo');
      // Backend cancel handler: §api.go handleCancel. Returns either
      // OK_CANCELLED (200) or ERR_ALREADY_TERMINAL / ERR_NOT_ALLOWED (4xx),
      // semantic copy comes from api.js' ApiError surface.
      await api.cancel(id, {});
      nav('..');
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  // Loading guard: show the modal disabled while we fetch. Avoids a flash
  // of the wrong amount where the seller might type the old hardcoded
  // 12880000 and have the verify check fail confusingly.
  if (currentCents == null) {
    return <AdminCancelModal currentCents="0"
      busy={true}
      error={null}
      onClose={() => nav('..')}
      onCancelAuction={() => {}}/>;
  }
  return <AdminCancelModal currentCents={currentCents}
    busy={busy}
    error={error}
    onClose={() => nav('..')}
    onCancelAuction={handleCancel}/>;
}

// ─── Demo room variants (used by /preview/room*) ────────────────
function DemoRoom() {
  return <MobileRoom
    remainingMs={28400}
    currentCents="12880000"
    extendCount={2}
    yourRank={3} yourGapCents="380000"
    aiText="¥128,800 · 28 秒，海风_2024 领先 · 这只蓝面鹦鹉螺等的就是你。"
    aiTrigger="open"
    expressive/>;
}
function DemoRoomFinal10() {
  return <MobileRoom
    remainingMs={5400}
    currentCents="13380000"
    extendCount={3}
    showColorRamp showHourglass showPulseWaves showBlackHorse
    yourRank={4} yourGapCents="630000"
    aiText="夜航星 +10× 阶梯 直接拉到 ¥133,800 — 这是一匹真正的黑马。"
    aiTrigger="jump" aiStreaming
    expressive/>;
}
function DemoRoomLeading() {
  return <MobileRoom
    remainingMs={28400}
    currentCents="12500000"
    extendCount={2}
    isYouLeading rejectShake rejectCode="ERR_TOO_LOW"
    showLeadingToast showOwnFlash
    yourRank={1} yourGapCents="0"
    aiText="陆_LU ¥125,000 领先 · 当前已是新纪录。"
    aiTrigger="hammer"
    expressive/>;
}

function NotFound() {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#0a0a14', color: '#f5f5f7', fontFamily: 'var(--font-sans)',
      flexDirection: 'column', gap: 14,
    }}>
      <h1 style={{ fontFamily: 'var(--font-serif)', fontSize: 36, margin: 0 }}>404</h1>
      <p style={{ color: '#9aa0b4' }}>找不到这个页面</p>
      <Link to="/" style={{ color: 'var(--douyin-cyan)' }}>← 返回首页</Link>
    </div>
  );
}
