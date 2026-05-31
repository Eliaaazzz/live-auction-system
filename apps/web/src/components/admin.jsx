import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { formatCentsCNY, PriceDisplay, Countdown, StatusBadge,
  TypewriterText, Leaderboard, ClockDriftIndicator } from './primitives.jsx';
import { DEMO_LEADERS, LiveVideo } from './mobile.jsx';
import { api, ApiError } from '../lib/api.js';
import { ensureSession, currentToken } from '../lib/auth.js';
import { RoomClient, buildRoomUrl } from '../lib/ws.js';
import { useAuctionStore } from '../store/auction.js';
import { msRemaining } from '../lib/clock.js';

const WS_BASE = import.meta.env.VITE_WS_BASE || undefined;

// lumen-admin.jsx
// Admin desktop screens: VLM facts confirmation + Live console.
// Designed for a 1280x800 inner canvas (inside a macOS window chrome).

// ── VLM-drafted facts ────────────────────────────────────────────
// Mirrors backend FactsDraft (blueprint §4.5)
const VLM_MODEL = {
  name: 'doubao-vision-pro-32k',  // T1 stub uses "mock-vlm-T1"
  ver: 'v0.9.2',
  vendor: 'Doubao',
};

const VLM_FACTS = [
  {
    id: 'brand',  label: '品牌',   vlmText: 'Patek Philippe (百达翡丽)',
    editedText: 'Patek Philippe (百达翡丽)',
    status: 'confirmed', confidence: 0.987, evidence: 'frame 02:14',
    highRisk: false,
  },
  {
    id: 'model',  label: '型号',   vlmText: '5711/1A — Nautilus, blue sunburst dial',
    editedText: '5711/1A-014 — Nautilus, 蓝面 sunburst',
    status: 'edited', confidence: 0.942, evidence: 'frame 02:31, 03:08',
    highRisk: false,
  },
  {
    id: 'condition', label: '成色', vlmText: '95新 · 表盘无划痕 · 表壳轻微抛光痕迹',
    editedText: '95新 · 表盘无划痕 · 表壳轻微抛光痕迹',
    status: 'confirmed', confidence: 0.873, evidence: 'frame 01:22–01:58',
    highRisk: false,
  },
  {
    id: 'flaws', label: '瑕疵', vlmText: '6点位日历窗口边缘有一处可见微划痕',
    editedText: '',
    status: 'pending', confidence: 0.611, evidence: 'frame 03:42',
    highRisk: true,  // 瑕疵 always high-risk per blueprint
  },
  {
    id: 'specs', label: '关键参数', vlmText: '40mm · 不锈钢 · Cal. 26-330 S C · 自动 · 防水30m',
    editedText: '40mm · 不锈钢 · Cal. 26-330 S C · 自动机芯 · 防水30m · 全套带证书',
    status: 'edited', confidence: 0.901, evidence: 'frame 00:48, voice 02:55',
    highRisk: false,
  },
];
const HIGH_RISK_DISCLAIMER = '此项不可由 VLM 客观验证 · 信息以卖家声明为准';

function AdminVLMFacts() {
  const navigate = useNavigate();
  const { id: auctionId } = useParams();
  const [facts, setFacts] = React.useState([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  // Item 2 (#101): draft facts from the REAL VLM endpoint (/facts/draft,
  // mock-backed) instead of a hardcoded array. Fetch the auction for its
  // productId + image, then ask the sidecar to extract facts from that image.
  // AI-down surfaces as a banner; the bid path is unaffected (V9 P3).
  React.useEffect(() => {
    let live = true;
    (async () => {
      try {
        const a = await api.getAuction(auctionId);
        const draft = await api.draftFacts({
          productId: a.productId || '',
          imageUrls: a.imageUrl ? [a.imageUrl] : [],
          title: a.productName || '',
          description: a.description || '',
        });
        if (!live) return;
        const labelOf = { category: '类目', brand: '品牌', model: '型号', condition: '成色', flaws: '瑕疵', authenticity: '真伪', specs: '关键参数' };
        setFacts((draft.facts || []).map((f) => ({
          id: f.field,
          label: labelOf[f.field] || f.field,
          vlmText: String(f.value),
          status: 'pending',
          confidence: f.confidence,
          evidence: draft.modelName || 'VLM',
          highRisk: !!f.highRisk,
        })));
      } catch (e) {
        if (live) setError('VLM 抽取失败(AI 旁路,出价不受影响): ' + (e?.message || String(e)));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [auctionId]);
  // T7-3 §4.3: read AI sidecar health for the on-page status pill +
  // the non-blocking freeze banner. Local component state for facts
  // stays unchanged when the sidecar is offline — the seller can still
  // confirm / edit / freeze with whatever they have.
  const aiSidecarHealth = useAuctionStore((s) => s.aiSidecarHealth);
  const aiOffline = aiSidecarHealth === 'offline';

  // Per-fact action handlers. Local state only — backend persists the final
  // confirmed snapshot atomically on api.freeze (handler at api.go:165 reads
  // factsConfirmed from MySQL). Future T7 work can call PATCH per-fact for
  // server-side per-edit persistence if needed.
  const setStatus = (factId, next) => setFacts((curr) =>
    curr.map((f) => f.id === factId ? { ...f, ...next } : f),
  );
  const handleConfirm = (id) => setStatus(id, { status: 'confirmed', editedText: facts.find((f) => f.id === id).vlmText });
  const handleEdit    = (id) => {
    const f = facts.find((x) => x.id === id);
    const input = window.prompt(`编辑「${f.label}」`, f.editedText || f.vlmText);
    if (input != null && input.trim()) setStatus(id, { status: 'edited', editedText: input });
  };
  const handleRestore = (id) => setStatus(id, { status: 'pending', editedText: '' });
  const handleDelete  = (id) => setFacts((curr) => curr.filter((f) => f.id !== id));

  const confirmedN = facts.filter((f) => f.status === 'confirmed' || f.status === 'edited').length;
  const total = facts.length;
  const pct = total > 0 ? Math.round(confirmedN / total * 100) : 0;
  const gateOpen = total > 0 && confirmedN === total;

  // Bottom CTA: freeze (DRAFT → SCHEDULED) then start (SCHEDULED → LIVE).
  // Both calls share the route's :id auction. On success route to the
  // live console; the console subscribes to the WS feed for the broadcaster
  // view of the same room buyers see.
  //
  // Idempotency (review by @Eliaaazzz on PR #51/#53, H2): if freeze
  // succeeds but startLive fails (network blip / Redis race / timer
  // race), the auction stays in SCHEDULED. On retry, the backend's
  // freeze handler now returns ERR_BAD_STATE (the auction is past
  // DRAFT), which would orphan the user. We treat ERR_BAD_STATE on
  // freeze as "already frozen, proceed to startLive". This makes the
  // freeze step client-side idempotent without needing a backend flag.
  //
  // We DO NOT treat ERR_BAD_STATE on startLive as success — that path
  // means the auction is already past SCHEDULED (LIVE / SOLD / etc.),
  // which is a different problem the user should see.
  const handleFreezeAndStart = async () => {
    if (busy || !gateOpen || !auctionId) return;
    setBusy(true);
    setError(null);
    try {
      await ensureSession('seller-demo');

      // Step 1: freeze (idempotent — ERR_BAD_STATE = already frozen, skip)
      let alreadyFrozen = false;
      try {
        const fz = await api.freeze(auctionId);
        if (fz?.code && fz.code !== 'OK_FROZEN') {
          if (fz.code === 'ERR_BAD_STATE') {
            alreadyFrozen = true;  // proceed to startLive
          } else {
            throw new ApiError(409, fz.code, fz.code);
          }
        }
      } catch (e) {
        // ApiError with ERR_BAD_STATE from the HTTP error path also means
        // already-past-DRAFT — same handling as the OK-code branch above.
        if (e instanceof ApiError && e.code === 'ERR_BAD_STATE') {
          alreadyFrozen = true;
        } else {
          throw e;
        }
      }
      // (alreadyFrozen is informational; we don't surface it to the user
      // since the success path is identical either way.)
      void alreadyFrozen;

      // Step 2: startLive — backend accepts optional durationMs; omitted
      // here means the seed/freeze default applies. ERR_BAD_STATE here
      // is NOT swallowed — it means the auction is past SCHEDULED, which
      // the user needs to see (don't pretend success).
      const st = await api.startLive(auctionId);
      if (st?.code && st.code !== 'OK_LIVE') {
        throw new ApiError(409, st.code, st.code);
      }
      navigate(`/admin/auctions/${auctionId}/live`);
    } catch (e) {
      const msg = e instanceof ApiError
        ? `${e.code || e.status} · ${e.message}`
        : (e?.message || String(e));
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
      background: '#0e1018', color: 'var(--douyin-ink-text)',
      fontFamily: 'var(--font-sans)',
    }}>
      {/* Top breadcrumb / context */}
      <div style={{
        flexShrink: 0, padding: '14px 28px',
        display: 'flex', alignItems: 'center', gap: 14,
        borderBottom: '1px solid rgba(255,255,255,.06)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--douyin-ink-muted)' }}>拍品管理</span>
          <span style={{ color: 'var(--douyin-ink-dim)' }}>›</span>
          <span style={{ fontSize: 11, color: 'var(--douyin-ink-muted)' }}>LOT 2024-0142</span>
          <span style={{ color: 'var(--douyin-ink-dim)' }}>›</span>
          <span style={{ fontSize: 12, fontWeight: 600 }}>VLM 事实核对</span>
        </div>
        {/* VLM model trust pill — blueprint §3.4 */}
        <div className="mono" style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '3px 8px 3px 4px', borderRadius: 999,
          background: 'rgba(37,244,238,.08)', border: '1px solid rgba(37,244,238,.3)',
        }}>
          <span style={{
            width: 16, height: 16, borderRadius: 8, background: 'var(--douyin-cyan)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#0a0a14', fontSize: 9, fontWeight: 700,
          }}>AI</span>
          <span style={{ fontSize: 10, color: 'var(--douyin-cyan)', fontWeight: 600 }}>
            {VLM_MODEL.name} · {VLM_MODEL.ver}
          </span>
        </div>
        <div style={{ flex: 1 }}/>
        {/* Step indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--douyin-ink-muted)' }}>
          {['DRAFT', 'VLM 核对', 'SCHEDULED', 'LIVE'].map((s, i) => (
            <React.Fragment key={s}>
              <span className="mono" style={{
                padding: '3px 8px', borderRadius: 4,
                background: i === 1 ? 'rgba(254,44,85,.15)' : 'rgba(255,255,255,.04)',
                color: i === 1 ? 'var(--douyin-red)' : i === 0 ? 'var(--douyin-ink-muted)' : 'var(--douyin-ink-dim)',
                fontWeight: i === 1 ? 600 : 400, letterSpacing: '.04em',
                border: '1px solid ' + (i === 1 ? 'rgba(254,44,85,.4)' : 'transparent'),
              }}>{s}</span>
              {i < 3 && <span style={{ color: 'var(--douyin-ink-dim)' }}>→</span>}
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* Main: 3-column — video / facts / context */}
      <div style={{
        flex: 1, display: 'grid', gridTemplateColumns: '360px 1fr 260px',
        minHeight: 0, gap: 0,
      }}>
        {/* L: Source video + frame ribbon */}
        <div style={{
          padding: '20px 14px 20px 28px', display: 'flex', flexDirection: 'column', gap: 12,
          borderRight: '1px solid rgba(255,255,255,.04)',
        }}>
          <div style={{ fontSize: 11, color: 'var(--douyin-ink-muted)', fontWeight: 600, letterSpacing: '.06em' }}>
            来源视频 · SOURCE
          </div>
          {/* video placeholder */}
          <div style={{
            aspectRatio: '4 / 5', borderRadius: 10, overflow: 'hidden',
            background: 'linear-gradient(160deg,#2a1f2e 0%,#1a1320 30%,#0a0e1a 100%)',
            position: 'relative',
          }}>
            <svg viewBox="0 0 200 200" style={{ position: 'absolute', inset: '8% 12%', width: '76%', height: '76%' }}>
              <circle cx="100" cy="100" r="62" fill="#15151c" stroke="#C9A961" strokeWidth="2" opacity=".95"/>
              <circle cx="100" cy="100" r="55" fill="#0d0d14" stroke="rgba(255,255,255,.08)"/>
              <line x1="100" y1="100" x2="100" y2="60" stroke="#C9A961" strokeWidth="2.4" strokeLinecap="round"/>
              <line x1="100" y1="100" x2="135" y2="100" stroke="#dcbf7f" strokeWidth="2" strokeLinecap="round"/>
              <circle cx="100" cy="100" r="2.5" fill="#C9A961"/>
            </svg>
            <div style={{
              position: 'absolute', top: 10, left: 10,
              padding: '3px 8px', borderRadius: 4,
              background: 'rgba(0,0,0,.65)', backdropFilter: 'blur(8px)',
              fontSize: 10, color: '#fff', fontFamily: 'var(--font-mono)',
            }}>03:42 / 05:18</div>
            <div style={{
              position: 'absolute', bottom: 10, right: 10,
              padding: '3px 8px', borderRadius: 4,
              background: 'rgba(254,44,85,.85)',
              fontSize: 10, fontWeight: 600, color: '#fff',
            }}>VLM 处理中</div>
          </div>
          {/* frame ribbon */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 10, color: 'var(--douyin-ink-muted)', letterSpacing: '.04em' }}>
              已采样关键帧 · 12 / 28
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }}>
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} style={{
                  aspectRatio: '1', borderRadius: 4,
                  background: 'linear-gradient(135deg,#2a1f2e,#0a0e1a)',
                  border: i === 3 ? '1.5px solid var(--douyin-red)' : '1px solid rgba(255,255,255,.06)',
                  position: 'relative', overflow: 'hidden',
                }}>
                  <svg viewBox="0 0 50 50" style={{ position: 'absolute', inset: 0, opacity: .7 }}>
                    <circle cx="25" cy="25" r="14" fill="none" stroke="#C9A961" strokeWidth="1.2"/>
                    <circle cx="25" cy="25" r="11" fill="#0d0d14"/>
                  </svg>
                  <div className="mono" style={{
                    position: 'absolute', bottom: 1, left: 2, fontSize: 7,
                    color: 'rgba(255,255,255,.55)',
                  }}>0{i+1}:{(12 + i*9) % 60}</div>
                </div>
              ))}
            </div>
          </div>

          {/* AI sidecar status — T7-3 §4.3: dynamic from store */}
          <div
            data-testid="ai-sidecar-status"
            data-state={aiOffline ? 'offline' : 'ok'}
            style={{
              marginTop: 'auto', padding: '10px 12px', borderRadius: 8,
              background: aiOffline ? 'rgba(107,114,128,.10)' : 'rgba(37,244,238,.06)',
              border: '1px solid ' + (aiOffline ? 'rgba(107,114,128,.28)' : 'rgba(37,244,238,.22)'),
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
            <div className={aiOffline ? '' : 'lumen-live-dot'} style={{
              width: 8, height: 8, borderRadius: 4,
              background: aiOffline ? '#6b7280' : 'var(--douyin-cyan)',
              flexShrink: 0,
            }}/>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 11, fontWeight: 600,
                color: aiOffline ? 'var(--douyin-ink-muted)' : 'var(--douyin-cyan)',
              }}>
                {aiOffline ? 'AI Sidecar · 离线' : 'AI Sidecar · 在线'}
              </div>
              <div style={{ fontSize: 10, color: 'var(--douyin-ink-muted)' }}>
                {aiOffline ? '事实仍可手动确认 · freeze 不受影响' : 'VLM gpt-4o-vision · 节流 1Hz'}
              </div>
            </div>
          </div>
        </div>

        {/* M: Facts list */}
        <div style={{
          padding: '20px 24px', display: 'flex', flexDirection: 'column',
          gap: 14, overflow: 'auto', minHeight: 0,
        }} className="no-scrollbar">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, letterSpacing: '-.01em' }}>
              事实核对 · 共 5 项
            </h1>
            <div style={{ flex: 1 }}/>
            <span className="mono" style={{
              fontSize: 11, color: 'var(--douyin-ink-muted)',
            }}>
              已核对 <span style={{ color: 'var(--douyin-cyan)', fontWeight: 600 }}>{confirmedN}</span> · 待办 {total - confirmedN}
            </span>
          </div>

          {/* Progress bar */}
          <div style={{
            height: 4, borderRadius: 2, background: 'rgba(255,255,255,.06)', overflow: 'hidden',
          }}>
            <div style={{
              width: `${pct}%`, height: '100%',
              background: gateOpen ? 'var(--solemn-gold)' : 'var(--douyin-cyan)',
              transition: 'width .4s ease',
            }}/>
          </div>

          {/* Fact cards */}
          {facts.map((f) => (
            <FactCard key={f.id} f={f}
              onConfirm={() => handleConfirm(f.id)}
              onEdit={() => handleEdit(f.id)}
              onRestore={() => handleRestore(f.id)}
              onDelete={() => handleDelete(f.id)}/>
          ))}
        </div>

        {/* R: Context (LOT meta + commentary) */}
        <div style={{
          padding: '20px 24px 20px 14px', display: 'flex', flexDirection: 'column', gap: 14,
          borderLeft: '1px solid rgba(255,255,255,.04)',
        }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--douyin-ink-muted)', letterSpacing: '.06em', marginBottom: 6 }}>
              LOT 信息
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>百达翡丽 5711/1A · 蓝面</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--douyin-ink-muted)' }}>
              ID 2024-0142<br/>
              创建于 21:14:08<br/>
              主持人 琉森拍卖行
            </div>
          </div>

          <div>
            <div style={{ fontSize: 10, color: 'var(--douyin-ink-muted)', letterSpacing: '.06em', marginBottom: 6 }}>
              开拍配置
            </div>
            <table className="mono" style={{ fontSize: 11, color: 'var(--douyin-ink-text)', borderCollapse: 'collapse' }}>
              <tbody>
                <tr><td style={{ color: 'var(--douyin-ink-muted)', paddingRight: 12, paddingBottom: 4 }}>起拍价</td><td>¥120,000.00</td></tr>
                <tr><td style={{ color: 'var(--douyin-ink-muted)', paddingRight: 12, paddingBottom: 4 }}>加价阶梯</td><td>¥5,000</td></tr>
                <tr><td style={{ color: 'var(--douyin-ink-muted)', paddingRight: 12, paddingBottom: 4 }}>预计时长</td><td>30 min</td></tr>
                <tr><td style={{ color: 'var(--douyin-ink-muted)', paddingRight: 12, paddingBottom: 4 }}>反狙击</td><td>末10s +30s</td></tr>
                <tr><td style={{ color: 'var(--douyin-ink-muted)', paddingRight: 12 }}>保留价</td><td>¥100,000.00</td></tr>
              </tbody>
            </table>
          </div>

          <div style={{
            padding: '10px 12px', borderRadius: 8,
            background: 'rgba(255,176,32,.08)', border: '1px solid rgba(255,176,32,.3)',
          }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--state-extended)', marginBottom: 4 }}>
              ⚠ 注意
            </div>
            <div style={{ fontSize: 11, color: 'var(--douyin-ink-text)', lineHeight: 1.45 }}>
              «瑕疵» 字段置信度 61.1%，建议人工补录后再开拍。
            </div>
          </div>
        </div>
      </div>

      {/* Bottom gate — F20 */}
      <div style={{
        flexShrink: 0, padding: '16px 28px',
        borderTop: '1px solid rgba(255,255,255,.06)',
        background: 'linear-gradient(180deg, rgba(0,0,0,0), rgba(0,0,0,.4))',
        display: 'flex', alignItems: 'center', gap: 14,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 11, color: 'var(--douyin-ink-muted)', letterSpacing: '.04em' }}>
            发布门禁 · GATE
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, color: error ? 'var(--state-rejected)' : gateOpen ? 'var(--solemn-gold)' : 'var(--state-extended)' }}>
            {error
              ? `开拍失败 · ${error}`
              : gateOpen ? '全部确认 · 点击开拍即进入 LIVE' : `还差 ${total - confirmedN} 项未核对`}
          </span>
        </div>
        <div style={{ flex: 1 }}/>
        <button disabled={busy} style={{
          padding: '10px 18px', borderRadius: 8, border: '1px solid rgba(255,255,255,.14)',
          background: 'transparent', color: 'var(--douyin-ink-text)', fontFamily: 'inherit',
          fontSize: 13, cursor: busy ? 'not-allowed' : 'pointer',
        }}>暂存草稿</button>
        <button onClick={handleFreezeAndStart} disabled={!gateOpen || busy} style={{
          padding: '10px 22px', borderRadius: 8, border: 'none',
          background: (gateOpen && !busy)
            ? 'linear-gradient(135deg, var(--solemn-gold), var(--solemn-gold-soft))'
            : 'rgba(107,114,128,.3)',
          color: (gateOpen && !busy) ? 'var(--solemn-ink)' : 'var(--douyin-ink-muted)',
          fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
          cursor: (gateOpen && !busy) ? 'pointer' : 'not-allowed',
          display: 'flex', alignItems: 'center', gap: 8,
          boxShadow: (gateOpen && !busy) ? '0 4px 18px rgba(201,169,97,.4)' : 'none',
        }}>
          {busy ? '正在开拍 …' : '全部确认后开拍'}
          {!busy && (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 7h8M8 3l4 4-4 4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

function FactCard({ f, onConfirm, onEdit, onRestore, onDelete }) {
  const isDirty = f.editedText && f.editedText !== f.vlmText;
  const isEmpty = !f.editedText;
  const statusColor = f.status === 'confirmed' ? 'var(--solemn-gold)'
                    : f.status === 'edited'    ? 'var(--douyin-cyan)'
                    :                            'var(--state-extended)';
  const statusLabel = f.status === 'confirmed' ? '✓ 已确认'
                    : f.status === 'edited'    ? '✓ 已编辑'
                    :                            '待办';
  const confColor = f.confidence > 0.9 ? 'var(--solemn-gold)' : f.confidence > 0.75 ? 'var(--douyin-cyan)' : 'var(--state-extended)';

  return (
    <div style={{
      padding: '14px 16px', borderRadius: 10,
      background: 'rgba(255,255,255,.02)',
      border: `1px solid ${f.status === 'pending' ? 'rgba(255,176,32,.35)' : 'rgba(255,255,255,.06)'}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{f.label}</span>
        <span style={{
          padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600,
          background: `${statusColor}26`, color: statusColor,
        }}>{statusLabel}</span>
        {f.highRisk && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600,
            background: 'rgba(254,44,85,.15)', color: 'var(--state-rejected)',
            border: '1px solid rgba(254,44,85,.4)',
          }}>
            <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
              <path d="M4.5 1l3.5 7H1l3.5-7zM4.5 4v2M4.5 6.5v.5" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
            </svg>
            高风险 · 卖家声明
          </span>
        )}
        <div style={{ flex: 1 }}/>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span className="mono" style={{ fontSize: 10, color: confColor }}>
            {(f.confidence * 100).toFixed(1)}%
          </span>
          <span style={{ fontSize: 10, color: 'var(--douyin-ink-muted)' }}>conf</span>
        </div>
        <span className="mono" style={{ fontSize: 10, color: 'var(--douyin-ink-dim)' }}>
          {f.evidence}
        </span>
      </div>

      {f.highRisk && (
        <div style={{
          marginBottom: 8, padding: '6px 10px', borderRadius: 6,
          background: 'rgba(254,44,85,.04)', border: '1px solid rgba(254,44,85,.2)',
          fontSize: 10, color: 'var(--solemn-cream-dim)', lineHeight: 1.45,
          fontFamily: 'var(--font-sans)',
        }}>
          {HIGH_RISK_DISCLAIMER}
        </div>
      )}

      {/* VLM original (always shown, struck-through when edited) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{
          padding: '8px 10px', borderRadius: 6,
          background: 'rgba(0,0,0,.3)',
          display: 'flex', gap: 8, alignItems: 'flex-start',
        }}>
          <span className="mono" style={{
            fontSize: 9, padding: '1px 5px', borderRadius: 3,
            background: 'rgba(37,244,238,.2)', color: 'var(--douyin-cyan)',
            marginTop: 1, flexShrink: 0,
          }}>VLM</span>
          <span style={{
            fontSize: 12, lineHeight: 1.5,
            color: isDirty ? 'var(--douyin-ink-dim)' : 'var(--douyin-ink-text)',
            textDecoration: isDirty ? 'line-through' : 'none',
            fontFamily: 'var(--font-sans)',
          }}>{f.vlmText}</span>
        </div>

        {(isDirty || f.status === 'confirmed') && (
          <div style={{
            padding: '8px 10px', borderRadius: 6,
            background: isDirty ? 'rgba(37,244,238,.06)' : 'rgba(201,169,97,.06)',
            border: `1px solid ${isDirty ? 'rgba(37,244,238,.18)' : 'rgba(201,169,97,.18)'}`,
            display: 'flex', gap: 8, alignItems: 'flex-start',
          }}>
            <span className="mono" style={{
              fontSize: 9, padding: '1px 5px', borderRadius: 3,
              background: isDirty ? 'rgba(37,244,238,.25)' : 'rgba(201,169,97,.25)',
              color: isDirty ? 'var(--douyin-cyan)' : 'var(--solemn-gold)',
              marginTop: 1, flexShrink: 0,
            }}>{isDirty ? '编辑' : 'OK'}</span>
            <span style={{ fontSize: 12, lineHeight: 1.5, fontFamily: 'var(--font-sans)' }}>
              {f.editedText}
            </span>
          </div>
        )}

        {isEmpty && (
          <div style={{
            padding: '10px 12px', borderRadius: 6,
            background: 'rgba(255,176,32,.06)',
            border: '1px dashed rgba(255,176,32,.4)',
            fontSize: 11, color: 'var(--state-extended)',
          }}>
            等待人工补录 · 置信度低，需要确认或修正
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        {f.status === 'pending' ? (
          <>
            <button onClick={onConfirm} style={btnPrimary}>采纳并补录</button>
            <button onClick={onEdit} style={btnGhost}>修改</button>
            <button onClick={onDelete} style={btnGhost}>删除</button>
          </>
        ) : (
          <>
            <button onClick={onEdit} style={btnGhost}>修改</button>
            <button onClick={onRestore} style={btnGhost}>恢复 VLM 原文</button>
            <div style={{ flex: 1 }}/>
            <span className="mono" style={{ fontSize: 10, color: 'var(--douyin-ink-dim)', alignSelf: 'center' }}>
              已锁定 21:34
            </span>
          </>
        )}
      </div>
    </div>
  );
}

const btnPrimary = {
  padding: '6px 12px', borderRadius: 6, border: 'none',
  background: 'var(--douyin-red)', color: '#fff',
  fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
};
const btnGhost = {
  padding: '6px 12px', borderRadius: 6,
  background: 'transparent', border: '1px solid rgba(255,255,255,.12)',
  color: 'var(--douyin-ink-text)', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit',
};

// ── Live Console ────────────────────────────────────────────────
const CONSOLE_BIDS = [
  { seq: 14998, time: '21:48:33.002', type: 'AUCTION_SOLD',    user: '海风_2024',   cents: '12880000' },
  { seq: 14991, time: '21:48:31.418', type: 'BID_ACCEPTED',    user: '海风_2024',   cents: '12880000' },
  { seq: 14945, time: '21:48:24.110', type: 'AUCTION_EXTENDED', extend: 2 },
  { seq: 14912, time: '21:48:14.221', type: 'BID_ACCEPTED',    user: '听雨人',     cents: '12750000' },
  { seq: 14834, time: '21:47:51.601', type: 'AUCTION_EXTENDED', extend: 1 },
  { seq: 14802, time: '21:47:42.118', type: 'BID_ACCEPTED',    user: '陆_LU',      cents: '12700000' },
  { seq: 14721, time: '21:47:08.342', type: 'BID_REJECTED',    user: 'Echo🌙',     code: 'BELOW_MIN_INCREMENT' },
  { seq: 14592, time: '21:46:08.802', type: 'BID_ACCEPTED',    user: '盐渍生活',   cents: '12500000' },
  { seq: 14437, time: '21:42:55.014', type: 'BID_ACCEPTED',    user: '陆_LU',      cents: '12400000' },
  { seq: 14201, time: '21:35:12.144', type: 'BID_ACCEPTED',    user: '听雨人',     cents: '12200000' },
];

const TYPE_COLOR = {
  BID_ACCEPTED:     { c: '#fff',                  bg: 'transparent' },
  BID_REJECTED:     { c: 'var(--state-rejected)', bg: 'rgba(255,77,112,.07)' },
  AUCTION_EXTENDED: { c: 'var(--state-extended)', bg: 'rgba(255,176,32,.07)' },
  AUCTION_SOLD:     { c: 'var(--solemn-gold)',    bg: 'rgba(201,169,97,.08)' },
};

function AdminConsole() {
  const navigate = useNavigate();
  const { id: auctionId } = useParams();
  // #53-H2: individual selectors so the console only re-renders when its
  // OWN slices change. Previously `useAuctionStore()` (no selector) caused
  // a full re-render of this huge component on every WS event — even ones
  // it doesn't visibly use. Each line below subscribes to a single field.
  const status         = useAuctionStore((s) => s.status);
  const storeCurrentCents = useAuctionStore((s) => s.currentCents);
  const remainingMs    = useAuctionStore((s) => s.remainingMs);
  const extendCount    = useAuctionStore((s) => s.extendCount);
  const recentEvents   = useAuctionStore((s) => s.recentEvents);
  const recentRejects  = useAuctionStore((s) => s.recentRejects);
  const totalBidsCount = useAuctionStore((s) => s.totalBidsCount);
  const bidderIds      = useAuctionStore((s) => s.bidderIds);
  const leaders        = useAuctionStore((s) => s.leaders);
  // init() is a stable function ref on the store — accessing via getState()
  // for the WS bootstrap effect (no need to subscribe).
  const rafRef = React.useRef(null);
  const [streamInfo, setStreamInfo] = React.useState(null);
  const [publicLivePlayUrl, setPublicLivePlayUrl] = React.useState(null);

  // Broadcaster-side WS subscription: same RoomClient + store as the buyer
  // (LiveRoomRoute) — broadcaster just observes, never sends BID_PLACE. On
  // mount we ensure session, optionally fetch a snapshot, then open WS.
  // The store fills with the same event reducer, so we read currentCents /
  // endAtMs / extendCount / recentEvents straight off it.
  React.useEffect(() => {
    if (!auctionId) return;
    let alive = true;
    let client;
    setStreamInfo(null);
    setPublicLivePlayUrl(null);
    (async () => {
      try {
        await ensureSession('seller-demo');
        useAuctionStore.getState().setSelfUserId(null); // broadcaster, not a bidder
      } catch (e) {
        console.warn('[Console] dev-login failed', e);
      }
      try {
        const snap = await api.getAuction(auctionId);
        if (!alive) return;
        // getState().init avoids a stale-closure issue from the removed
        // `store` var; init is a stable function ref on the store.
        useAuctionStore.getState().init({
          auctionId,
          status: snap.status,
          currentCents: snap.currentPriceCents ?? '0',
          endAtMs: snap.endAtMs ?? null,
          winnerId: snap.winnerId ?? null,
        });
        setPublicLivePlayUrl(snap.livePlayUrl || null);
      } catch (e) {
        console.warn('[Console] snapshot failed (continuing — WS will rebuild)', e);
      }
      try {
        const stream = await api.getAuctionStream(auctionId);
        if (alive) setStreamInfo(stream);
      } catch (e) {
        // The endpoint is owner-only. A non-owner observer can still run the
        // console view; they just won't see the seller push material.
        console.warn('[Console] stream material unavailable', e);
      }
      try {
        // Seed the leaderboard so the console shows existing top bids on first
        // paint, not just bids placed after the broadcaster opened it.
        const { leaderboard = [] } = await api.getLeaderboard(auctionId, 10);
        if (alive) useAuctionStore.getState().setLeaders(leaderboard);
      } catch (e) {
        console.warn('[Console] leaderboard seed failed', e);
      }
      const url = buildRoomUrl(WS_BASE, auctionId, currentToken());
      client = new RoomClient({
        url, auctionId,
        getLastSeq: () => useAuctionStore.getState().lastSeq,
        onState:    (s) => useAuctionStore.getState().setConn(s.status, s),
        onEvent:    (env) => useAuctionStore.getState().applyEvent(env),
        onReject:   (env) => useAuctionStore.getState().applyReject(env),
      });
      client.connect();
    })();
    return () => { alive = false; client?.leave(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auctionId]);

  // 1Hz countdown tick (same as LiveRoomRoute)
  React.useEffect(() => {
    const tick = () => {
      const endAtMs = useAuctionStore.getState().endAtMs;
      if (endAtMs) useAuctionStore.getState().tickRemaining(msRemaining(endAtMs));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // Demo fallbacks when no auctionId is in the URL (e.g. design preview).
  const effectiveStatus = status || 'LIVE';
  const liveCents       = auctionId ? storeCurrentCents : '12880000';
  const liveRemainingMs = auctionId ? remainingMs       : 8210;
  const liveExtend      = auctionId ? extendCount       : 2;
  const liveBids        = auctionId ? recentEvents      : null;  // null → fall through to CONSOLE_BIDS demo
  const liveRejects     = auctionId ? recentRejects     : null;
  // #53-M1: total bids from cumulative counter, not from recentEvents
  // (capped at 50). #53-M2: unique bidder count from bidderIds (which
  // already excludes null userIds at the store level).
  const liveTotalBids   = auctionId ? totalBidsCount    : 126;
  const liveUniqueBids  = auctionId ? bidderIds.length  : 38;
  const streamPreviewUrl = streamInfo?.livePlayUrl || publicLivePlayUrl || null;

  return (
    <div style={{
      width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
      background: '#0e1018', color: 'var(--douyin-ink-text)',
      fontFamily: 'var(--font-sans)',
    }}>
      {/* Big status header */}
      <div style={{
        flexShrink: 0, padding: '18px 28px',
        background: 'linear-gradient(180deg, rgba(254,44,85,.08), transparent)',
        borderBottom: '1px solid rgba(255,255,255,.06)',
        display: 'flex', alignItems: 'center', gap: 24,
      }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <StatusBadge status={effectiveStatus} size="md"/>
            <span style={{ fontSize: 11, color: 'var(--douyin-ink-muted)' }}>
              {auctionId ? `AID ${auctionId.slice(0, 16)}` : 'LOT 2024-0142 · 百达翡丽 5711/1A'}
            </span>
          </div>
          <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-.01em' }}>
            主持人控制台 · Live Console
          </div>
        </div>
        <div style={{ flex: 1 }}/>
        <div style={{ display: 'flex', gap: 22 }}>
          <Stat label="当前价" value={<PriceDisplay cents={liveCents} size={28} tone="ink"/>}/>
          <Stat label="距落槌" value={<Countdown remainingMs={liveRemainingMs} size="md"/>}/>
          <Stat label="出价总数" value={<span className="mono" style={{ fontSize: 24, fontWeight: 600 }}>
            {liveTotalBids}
          </span>}/>
          <Stat label="参与人数" value={<span className="mono" style={{ fontSize: 24, fontWeight: 600 }}>
            {liveUniqueBids}
          </span>}/>
          <Stat label="延时" value={<span className="mono" style={{ fontSize: 24, fontWeight: 600, color: 'var(--state-extended)' }}>×{liveExtend}</span>}/>
        </div>
      </div>

      {/* Body grid */}
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '420px 1fr 320px', minHeight: 0 }}>
        {/* L: Live stream preview */}
        <div style={{
          padding: '18px 14px 18px 28px',
          borderRight: '1px solid rgba(255,255,255,.04)',
          display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0,
        }}>
          <div style={{ fontSize: 11, color: 'var(--douyin-ink-muted)', fontWeight: 600, letterSpacing: '.06em' }}>
            主播预览 · STREAM
          </div>
          <div style={{
            aspectRatio: '9 / 16', maxHeight: 360,
            borderRadius: 10, background: 'linear-gradient(160deg,#2a1f2e,#0a0e1a)',
            position: 'relative', overflow: 'hidden',
          }}>
            <svg viewBox="0 0 200 200" style={{ position: 'absolute', inset: '20% 22%', width: '56%' }}>
              <circle cx="100" cy="100" r="62" fill="#15151c" stroke="#C9A961" strokeWidth="2"/>
              <circle cx="100" cy="100" r="55" fill="#0d0d14"/>
              <line x1="100" y1="100" x2="100" y2="60" stroke="#C9A961" strokeWidth="2.4" strokeLinecap="round"/>
              <line x1="100" y1="100" x2="135" y2="100" stroke="#dcbf7f" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            {streamPreviewUrl && <LiveVideo url={streamPreviewUrl}/>}
            <div style={{
              position: 'absolute', top: 8, left: 8, padding: '3px 8px',
              borderRadius: 4, background: 'rgba(254,44,85,.9)',
              fontSize: 10, fontWeight: 600,
            }}>● REC</div>
            <div className="mono" style={{
              position: 'absolute', bottom: 8, right: 8,
              padding: '3px 8px', borderRadius: 4,
              background: 'rgba(0,0,0,.6)',
              fontSize: 10,
            }}>1080p · 30fps</div>
          </div>

          <div style={{
            padding: '10px 12px', borderRadius: 8,
            background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.05)',
            display: 'flex', flexDirection: 'column', gap: 7,
          }}>
            <StreamField label="STREAM KEY" value={streamInfo?.streamKey}/>
            <StreamField label="OBS RTMP" value={streamInfo?.pushUrl}/>
            <StreamField label="HLS PLAY" value={streamInfo?.livePlayUrl || publicLivePlayUrl}/>
          </div>

          {/* Stream health */}
          <div style={{
            padding: '10px 12px', borderRadius: 8,
            background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.05)',
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
          }}>
            <Health label="带宽" value="6.8 Mbps" ok/>
            <Health label="时延" value="142ms"   ok/>
            <Health label="丢包" value="0.02%"   ok/>
            <Health label="WS 心跳" value="15s · OK" ok/>
          </div>

          {/* AI preview */}
          <div style={{
            marginTop: 'auto', padding: '12px', borderRadius: 8,
            background: 'rgba(37,244,238,.05)', border: '1px solid rgba(37,244,238,.2)',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6,
            }}>
              <div className="lumen-live-dot" style={{
                width: 6, height: 6, borderRadius: 3, background: 'var(--douyin-cyan)',
              }}/>
              <span style={{ fontSize: 10, color: 'var(--douyin-cyan)', fontWeight: 600, letterSpacing: '.04em' }}>
                AI 拍卖师 · 待播
              </span>
              <span className="mono" style={{ fontSize: 9, color: 'var(--douyin-ink-muted)', marginLeft: 'auto' }}>
                read-only · 仅展示
              </span>
              <button title="静音/取消静音 AI 文本流" style={{
                width: 22, height: 22, borderRadius: 11, border: 'none',
                background: 'rgba(255,255,255,.04)',
                color: 'var(--douyin-ink-muted)',
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor">
                  <path d="M1.5 4.2h1.5l2.5-2v6.6L3 6.8H1.5z"/>
                  <line x1="7" y1="3.5" x2="10" y2="7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                  <line x1="10" y1="3.5" x2="7" y2="7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--douyin-ink-text)' }}>
              <TypewriterText text={'"海风_2024 ¥128,800 领先 · 还剩 8 秒，谁来挑战这只蓝面鹦鹉螺？"'} charDelay={48}/>
            </div>
          </div>
        </div>

        {/* M: Bid stream ticker */}
        <div style={{
          padding: '18px 24px', display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 11, color: 'var(--douyin-ink-muted)', fontWeight: 600, letterSpacing: '.06em' }}>
              出价流 · BID STREAM
            </span>
            <span style={{ fontSize: 10, color: 'var(--douyin-ink-dim)' }}>· 实时 · WSS</span>
            <div style={{ flex: 1 }}/>
            <ClockDriftIndicator offsetMs={42}/>
            <span className="mono" style={{ fontSize: 10, color: 'var(--douyin-ink-dim)' }}>
              seq 14000 → 14998
            </span>
          </div>

          {/* Stream header */}
          <div className="mono" style={{
            display: 'grid', gridTemplateColumns: '70px 100px 130px 1fr 110px',
            gap: 12, padding: '6px 10px', fontSize: 10,
            color: 'var(--douyin-ink-muted)', letterSpacing: '.04em',
            borderBottom: '1px solid rgba(255,255,255,.06)',
          }}>
            <span>SEQ</span><span>TIME</span><span>EVENT</span><span>USER</span><span style={{ textAlign: 'right' }}>AMOUNT</span>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }} className="no-scrollbar">
            {((liveBids && liveBids.length) ? mapStoreEventsToBidStream(liveBids) : CONSOLE_BIDS).map((b) => {
              const tc = TYPE_COLOR[b.type] ?? TYPE_COLOR.BID_ACCEPTED;
              return (
                <div key={b.seq} className="mono" style={{
                  display: 'grid', gridTemplateColumns: '70px 100px 130px 1fr 110px',
                  gap: 12, padding: '8px 10px', borderRadius: 6,
                  background: tc.bg, fontSize: 12,
                  alignItems: 'center',
                }}>
                  <span style={{ color: 'var(--douyin-ink-muted)' }}>#{b.seq}</span>
                  <span style={{ color: 'var(--douyin-ink-muted)', fontSize: 11 }}>{b.time}</span>
                  <span style={{ color: tc.c, fontWeight: b.type === 'AUCTION_SOLD' ? 700 : 500 }}>
                    {b.type}
                  </span>
                  <span style={{ color: 'var(--douyin-ink-text)', fontFamily: 'var(--font-sans)' }}>
                    {b.user || '—'}
                    {b.code && <span style={{ color: 'var(--state-rejected)', marginLeft: 8, fontSize: 10 }}>· {b.code}</span>}
                    {b.extend && <span style={{ color: 'var(--state-extended)', marginLeft: 8 }}>+30s · 第{b.extend}次</span>}
                  </span>
                  <span style={{ color: tc.c, fontWeight: 600, textAlign: 'right' }}>
                    {b.cents ? formatCentsCNY(b.cents) : '—'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* R: Danger zone + leaderboard */}
        <div style={{
          padding: '18px 24px 18px 14px',
          borderLeft: '1px solid rgba(255,255,255,.04)',
          display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0,
        }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--douyin-ink-muted)', fontWeight: 600, letterSpacing: '.06em', marginBottom: 8 }}>
              出价榜
            </div>
            <Leaderboard leaders={(auctionId ? leaders : DEMO_LEADERS).slice(0, 5)}/>
          </div>

          {/* Last-N rejects panel — blueprint §3.5 */}
          <div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8,
              fontSize: 11, fontWeight: 600, color: 'var(--state-rejected)', letterSpacing: '.06em',
            }}>
              最近被拒 · LAST 3 REJECTS
              <span className="mono" style={{ fontSize: 9, color: 'var(--douyin-ink-dim)', marginLeft: 'auto', fontWeight: 400 }}>
                place_bid.lua
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {((liveRejects && liveRejects.length)
                ? liveRejects.slice(0, 3).map((r) => ({
                    user: r.requestId ? `cbid ${r.requestId.slice(0, 8)}` : 'unknown',
                    code: r.code,
                    t:    new Date(r.ts).toLocaleTimeString('zh-CN', { hour12: false }),
                  }))
                : [
                    { user: 'Echo🌙', code: 'ERR_TOO_LOW',     t: '21:47:08' },
                    { user: '夜航星', code: 'ERR_BAD_INPUT',   t: '21:46:31' },
                    { user: '某买家', code: 'ERR_NOT_ALLOWED', t: '21:45:12' },
                  ]
              ).map((r, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 8px', borderRadius: 6,
                  background: 'rgba(254,44,85,.04)',
                  border: '1px solid rgba(254,44,85,.15)',
                }}>
                  <span style={{ fontSize: 11, color: 'var(--douyin-ink-text)', flex: 1, minWidth: 0,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.user}
                  </span>
                  <span className="mono" style={{ fontSize: 9, color: 'var(--state-rejected)', fontWeight: 600 }}>
                    {r.code}
                  </span>
                  <span className="mono" style={{ fontSize: 9, color: 'var(--douyin-ink-dim)' }}>
                    {r.t}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Danger zone */}
          <div style={{
            marginTop: 'auto', padding: '14px',
            borderRadius: 10, background: 'rgba(254,44,85,.05)',
            border: '1px solid rgba(254,44,85,.3)',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8,
              fontSize: 11, fontWeight: 600, color: 'var(--state-rejected)', letterSpacing: '.04em',
            }}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M6 1l5 9H1L6 1zM6 5v3M6 9v.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
              </svg>
              危险操作 · DANGER
            </div>
            <div style={{ fontSize: 11, color: 'var(--douyin-ink-muted)', marginBottom: 10, lineHeight: 1.4 }}>
              终止 LIVE 会立即推送 CANCELLED 给所有买家，行为已上链。
            </div>
            <button onClick={() => {
              if (auctionId) navigate(`/admin/auctions/${auctionId}/cancel`);
            }} style={{
              width: '100%', padding: '8px 12px', borderRadius: 6,
              background: 'rgba(254,44,85,.1)', color: 'var(--state-rejected)',
              border: '1px solid rgba(254,44,85,.5)', cursor: auctionId ? 'pointer' : 'not-allowed',
              fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
              opacity: auctionId ? 1 : 0.5,
            }}>取消本场拍卖…</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
      <span style={{ fontSize: 9, color: 'var(--douyin-ink-muted)', letterSpacing: '.08em' }}>
        {label}
      </span>
      <span>{value}</span>
    </div>
  );
}
function Health({ label, value, ok }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
      <span style={{
        width: 6, height: 6, borderRadius: 3,
        background: ok ? 'var(--douyin-cyan)' : 'var(--state-rejected)',
      }}/>
      <span style={{ color: 'var(--douyin-ink-muted)' }}>{label}</span>
      <span className="mono" style={{ marginLeft: 'auto', color: 'var(--douyin-ink-text)' }}>{value}</span>
    </div>
  );
}

function StreamField({ label, value }) {
  const display = value || '-';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '78px 1fr', gap: 8, alignItems: 'center' }}>
      <span style={{ fontSize: 9, color: 'var(--douyin-ink-muted)', letterSpacing: '.06em' }}>
        {label}
      </span>
      <span className="mono" title={display} style={{
        minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        color: value ? 'var(--douyin-ink-text)' : 'var(--douyin-ink-dim)', fontSize: 10,
      }}>
        {display}
      </span>
    </div>
  );
}

// Map Zustand store.recentEvents → AdminConsole's bid-stream row shape.
// Order is reverse-chrono (newest first) so the ticker fills from the top.
function mapStoreEventsToBidStream(events) {
  const formatHMS = (ms) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
  };
  return events.map((e) => ({
    seq: e.seq ?? 0,
    time: e.ts ? formatHMS(e.ts) : '',
    type: e.type,
    user: e.data?.displayName,
    cents: e.data?.amountCents,
    extend: e.type === 'AUCTION_EXTENDED' ? (e.data?.extendCount ?? 1) : undefined,
  }));
}

export {
  AdminVLMFacts,
  AdminConsole,
  VLM_FACTS,
  CONSOLE_BIDS,
  VLM_MODEL
};
