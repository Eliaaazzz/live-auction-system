// src/routes/IndexPage.jsx
// Dev landing page — links to every screen in the system.
// Useful while wiring backend integration. Replace with your real entry route.

import React from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { formatCentsCNY, StatusBadge } from '../components/primitives.jsx';

// Real auction hall: browse live + past auctions (竞拍浏览 商品列表 / 历史竞拍记录).
// LIVE/SCHEDULED → the room; terminal → the evidence card. Fed by GET /api/auctions.
function AuctionHall() {
  const [auctions, setAuctions] = React.useState([]);
  const [err, setErr] = React.useState(null);
  React.useEffect(() => {
    let live = true;
    api.listAuctions({ limit: 60 })
      .then(res => { if (live) setAuctions(res.auctions || []); })
      .catch(e => { if (live) setErr(e?.message || String(e)); });
    return () => { live = false; };
  }, []);
  const isLive = (s) => s === 'LIVE' || s === 'SCHEDULED';
  if (err) return <div style={{ color: '#9aa0b4', fontSize: 12 }}>拍品加载失败: {err}</div>;
  if (auctions.length === 0) return <div style={{ color: '#6b7186', fontSize: 12 }}>暂无拍品 — 去「新建拍品」发布一场</div>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
      {auctions.map(a => (
        <Link key={a.auctionId} to={isLive(a.status) ? `/room/${a.auctionId}` : `/evidence/${a.auctionId}`}
          style={{ display: 'flex', gap: 12, padding: 12, borderRadius: 10, textDecoration: 'none',
            background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.06)', color: '#fff' }}>
          <div style={{ width: 56, height: 56, borderRadius: 8, flexShrink: 0, overflow: 'hidden',
            background: 'linear-gradient(160deg,#2a1f2e,#0a0e1a)' }}>
            {a.imageUrl && <img src={a.imageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              onError={(e) => { e.currentTarget.style.display = 'none'; }}/>}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <StatusBadge status={a.status} size="sm"/>
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4, overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.productName || a.auctionId}</div>
            <div className="mono" style={{ fontSize: 12, color: 'var(--solemn-gold)', marginTop: 2 }}>
              {formatCentsCNY(a.currentPriceCents || '0')}
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}

const SECTIONS = [
  {
    label: '买家流程 · Mobile',
    items: [
      { to: '/preview/room',            label: 'Room · LIVE · 30s',           hint: '心跳脉冲 + 实时出价流' },
      { to: '/preview/room/final10',    label: 'Room · 末 10s',               hint: '沙漏 + 脉冲波纹 + 黑马' },
      { to: '/preview/room/leading',    label: 'Room · 自己领先 + 拒绝',       hint: 'F06 + F08 + Reject Toast' },
      { to: '/room/demo-001',           label: 'Room · 实时 (WS)',            hint: '连接 /ws/v1/room/demo-001' },
      { to: '/preview/hammer',          label: 'Hammer · 落槌',                hint: 'A→B 调色板切换' },
      { to: '/preview/evidence',        label: 'Evidence · 证据卡',            hint: 'CHAIN VERIFIED' },
      { to: '/preview/evidence/broken', label: 'Evidence · 链断',              hint: 'CHAIN BROKEN' },
      { to: '/preview/mp',              label: 'Mini-program 引导',            hint: '请在抖音 App 打开' },
    ],
  },
  {
    label: '连接状态 · Connection',
    items: [
      { to: '/preview/conn/reconnect', label: '重连中',         hint: 'WS 中断' },
      { to: '/preview/conn/sync',      label: '同步遗漏事件',    hint: 'XRANGE 14922→14998' },
      { to: '/preview/conn/schema',    label: '协议版本不匹配',  hint: '终态 · 需刷新' },
    ],
  },
  {
    label: '管理后台 · PC Admin',
    items: [
      { to: '/admin/auctions',                     label: '拍品 & 订单管理',  hint: 'GMV 概览 + 7 状态筛选' },
      { to: '/admin/auctions/new',                 label: '新建拍品',         hint: '5 步表单 · DRAFT 起点' },
      { to: '/admin/auctions/demo-001/vlm',        label: 'VLM 事实核对',     hint: '管理后台 hero' },
      { to: '/admin/auctions/demo-001/live',       label: 'Live Console',     hint: '主持人控制台' },
      { to: '/admin/auctions/demo-001/cancel',     label: '取消本场 · 2-step',hint: '危险操作确认' },
    ],
  },
];

export function IndexPage() {
  return (
    <div style={{
      minHeight: '100vh', background: 'linear-gradient(180deg, #0a0d18 0%, #06070d 100%)',
      color: '#f5f5f7', fontFamily: 'var(--font-sans)',
      padding: '60px 24px 80px', boxSizing: 'border-box',
    }}>
      <div style={{ maxWidth: 1080, margin: '0 auto' }}>
        {/* Header */}
        <div style={{ marginBottom: 48 }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 14, marginBottom: 18,
          }}>
            <div style={{
              width: 48, height: 48, borderRadius: 12,
              background: 'linear-gradient(135deg, var(--douyin-red), var(--solemn-gold))',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: 'var(--font-serif)', fontWeight: 700, fontSize: 26, color: '#fff',
            }}>L</div>
            <div>
              <div className="mono" style={{ fontSize: 11, color: 'rgba(245,237,221,.55)',
                letterSpacing: '.18em' }}>LIVE AUCTION SYSTEM</div>
              <div style={{ fontSize: 14, color: 'rgba(245,237,221,.85)', marginTop: 2 }}>
                琉森拍卖 · 直播竞拍前端
              </div>
            </div>
          </div>
          <h1 className="serif" style={{
            fontFamily: 'var(--font-serif)', fontSize: 56, fontWeight: 500,
            letterSpacing: '-.02em', lineHeight: 1.05, margin: 0,
          }}>
            Lumen Auction
            <br/>
            <span style={{ color: 'var(--solemn-gold)' }}>Front-End</span>
            <span style={{ color: 'rgba(245,237,221,.6)', fontSize: 28, marginLeft: 12, fontWeight: 400 }}>
              · v0.1
            </span>
          </h1>
          <p style={{
            fontSize: 14, color: '#9aa0b4', maxWidth: 660, lineHeight: 1.7, marginTop: 14,
          }}>
            Dev 索引页 · 列出系统所有页面入口。 Mobile 用 MobileFrame 包裹，
            Admin 用 DesktopShell 包裹。 <code>/room/:id</code> 是真正连接
            WebSocket 的入口， <code>/preview/*</code> 用 demo 数据渲染。
            <br/>
            <span style={{ color: 'var(--solemn-gold)' }}>VITE_USE_MOCK_DATA=true</span>{' '}
            时整站从 demo data 渲染（默认）；接好后端后设为 false。
          </p>
        </div>

        {/* Real auction hall — live + history, from the backend */}
        <section style={{ marginBottom: 36 }}>
          <div style={{
            fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--solemn-gold)',
            letterSpacing: '.12em', marginBottom: 14, paddingBottom: 8,
            borderBottom: '1px solid rgba(201,169,97,.2)',
          }}>竞拍大厅 · LIVE & 历史 (REAL DATA)</div>
          <AuctionHall/>
        </section>

        {/* Sections */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
          {SECTIONS.map(s => (
            <section key={s.label}>
              <div style={{
                fontSize: 11, fontFamily: 'var(--font-mono)',
                color: 'var(--solemn-gold)', letterSpacing: '.12em',
                marginBottom: 14, paddingBottom: 8,
                borderBottom: '1px solid rgba(201,169,97,.2)',
              }}>{s.label.toUpperCase()}</div>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                gap: 10,
              }}>
                {s.items.map(it => (
                  <Link key={it.to} to={it.to}
                    style={{
                      display: 'flex', flexDirection: 'column', gap: 4,
                      padding: '14px 16px', borderRadius: 10,
                      background: 'rgba(255,255,255,.02)',
                      border: '1px solid rgba(255,255,255,.06)',
                      textDecoration: 'none', color: '#fff',
                      transition: 'all .15s ease',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(254,44,85,.06)';
                      e.currentTarget.style.borderColor = 'rgba(254,44,85,.3)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(255,255,255,.02)';
                      e.currentTarget.style.borderColor = 'rgba(255,255,255,.06)';
                    }}>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>{it.label}</span>
                    <span style={{ fontSize: 11, color: '#9aa0b4' }}>{it.hint}</span>
                    <span className="mono" style={{ fontSize: 10, color: 'var(--douyin-cyan)',
                      marginTop: 2, opacity: .75 }}>{it.to}</span>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>

        {/* Footer */}
        <div style={{
          marginTop: 56, paddingTop: 24,
          borderTop: '1px solid rgba(255,255,255,.06)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          fontSize: 11, color: '#6b7186', fontFamily: 'var(--font-mono)',
        }}>
          <span>VITE_API_BASE  =  {import.meta.env.VITE_API_BASE || '/api'}</span>
          <span>VITE_WS_BASE  =  {import.meta.env.VITE_WS_BASE || '/ws'}</span>
          <span>BUILD  =  {import.meta.env.VITE_BUILD_SHA || 'dev'}</span>
        </div>
      </div>
    </div>
  );
}
