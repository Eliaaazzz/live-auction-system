import React from 'react';
import { CURRENT_SCHEMA_VERSION } from '../lib/types.js';

// lumen-misc.jsx — Mini-program stub landing + Connection states demo

// ───────────────────────────────────────────────────────────────
// Mini-program stub — §2 row "OPEN DECISION → C"
// "请在抖音 App 打开" — minimal but on-brand
// ───────────────────────────────────────────────────────────────
function MiniProgramStub() {
  return (
    <div style={{
      width: '100%', height: '100%',
      background: 'linear-gradient(180deg, #161823 0%, #0a0d18 100%)',
      color: 'var(--douyin-ink-text)', fontFamily: 'var(--font-sans)',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '70px 28px 50px',
      position: 'relative', overflow: 'hidden',
    }}>
      {/* Brand */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, marginBottom: 'auto',
      }}>
        <div style={{
          width: 40, height: 40, borderRadius: 10,
          background: 'linear-gradient(135deg, var(--douyin-red), var(--douyin-cyan))',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontSize: 17, fontWeight: 700,
          fontFamily: 'var(--font-serif)',
        }}>L</div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span className="serif" style={{ fontSize: 16, fontWeight: 600 }}>Lumen Auction</span>
          <span style={{ fontSize: 10, color: 'var(--douyin-ink-muted)', letterSpacing: '.06em' }}>
            琉森拍卖 · 直播竞拍
          </span>
        </div>
      </div>

      {/* Center: phone illustration + call */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 28 }}>
        {/* Phone with Douyin chrome */}
        <div style={{ position: 'relative', width: 150, height: 200 }}>
          <div style={{
            position: 'absolute', inset: 0, borderRadius: 24,
            background: 'linear-gradient(160deg, #2a2733, #161823)',
            border: '1.5px solid rgba(255,255,255,.1)',
            boxShadow: '0 30px 60px rgba(0,0,0,.45)',
          }}/>
          {/* notch */}
          <div style={{
            position: 'absolute', top: 6, left: '50%', transform: 'translateX(-50%)',
            width: 38, height: 12, borderRadius: 6, background: '#000',
          }}/>
          {/* fake LIVE label */}
          <div style={{
            position: 'absolute', top: '32%', left: '50%', transform: 'translateX(-50%)',
            padding: '4px 10px', borderRadius: 999, background: 'var(--douyin-red)',
            fontSize: 9, fontWeight: 700, color: '#fff', display: 'flex', gap: 4, alignItems: 'center',
          }}>
            <span className="lumen-live-dot" style={{ width: 5, height: 5, borderRadius: 3, background: '#fff' }}/>
            直播中
          </div>
          {/* fake price */}
          <div className="mono" style={{
            position: 'absolute', top: '46%', left: 0, right: 0, textAlign: 'center',
            fontSize: 18, fontWeight: 700, color: 'var(--solemn-gold)',
          }}>¥128,800</div>
          {/* fake countdown */}
          <div className="mono" style={{
            position: 'absolute', top: '60%', left: 0, right: 0, textAlign: 'center',
            fontSize: 10, color: 'var(--douyin-ink-muted)',
          }}>00:07</div>
          {/* fake bid btn */}
          <div style={{
            position: 'absolute', bottom: 18, left: 12, right: 12,
            height: 28, borderRadius: 6,
            background: 'linear-gradient(135deg, var(--douyin-red), var(--douyin-red-soft))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 10, fontWeight: 600, color: '#fff',
          }}>出价 ¥133,800</div>
          {/* Douyin music icon corner */}
          <svg viewBox="0 0 20 20" style={{ position: 'absolute', top: 6, right: 8, width: 14, height: 14 }} fill="#fff" opacity=".7">
            <circle cx="10" cy="10" r="9" fill="none" stroke="#fff" strokeWidth="1.4"/>
            <path d="M8 6v6.5a2 2 0 11-2-2" stroke="#fff" strokeWidth="1.4" fill="none" strokeLinecap="round"/>
          </svg>
        </div>

        {/* Call to action */}
        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h1 className="serif" style={{
            margin: 0, fontSize: 26, fontWeight: 500, color: '#fff',
            letterSpacing: '-.01em', lineHeight: 1.3,
          }}>
            请在抖音 App 内打开
          </h1>
          <p style={{
            margin: 0, fontSize: 13, color: 'var(--douyin-ink-muted)',
            lineHeight: 1.6, maxWidth: 280,
          }}>
            为获得完整直播 + 实时竞拍 + 反狙击体验，<br/>
            请通过抖音 App 进入 Lumen Auction 小程序。
          </p>
        </div>
      </div>

      {/* Bottom actions */}
      <div style={{
        marginTop: 'auto', width: '100%', display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        <button style={{
          width: '100%', padding: '14px', borderRadius: 12, border: 'none',
          background: 'linear-gradient(135deg, var(--douyin-red), var(--douyin-red-soft))',
          color: '#fff', fontFamily: 'inherit', fontSize: 15, fontWeight: 600,
          boxShadow: '0 8px 24px rgba(254,44,85,.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        }}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M11 1.5a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zM7 4.5v6.5a2.5 2.5 0 11-2.5-2.5h.5V11" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round"/>
          </svg>
          打开 抖音 App
        </button>
        <button style={{
          width: '100%', padding: '12px', borderRadius: 12,
          background: 'transparent', border: '1px solid rgba(255,255,255,.18)',
          color: 'var(--douyin-ink-text)', fontFamily: 'inherit', fontSize: 13, cursor: 'pointer',
        }}>
          仍想用 H5 浏览 (功能受限)
        </button>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          fontSize: 10, color: 'var(--douyin-ink-dim)', marginTop: 4,
        }}>
          <span>或扫码进入</span>
          <div style={{
            width: 60, height: 60, marginTop: 6, padding: 4,
            background: '#fff', borderRadius: 6,
            display: 'inline-block',
          }}>
            {/* fake QR */}
            <svg viewBox="0 0 52 52" width="52" height="52" style={{ display: 'block' }}>
              {[[0,0],[44,0],[0,44]].map(([x,y],i) => (
                <g key={i}>
                  <rect x={x} y={y} width="8" height="8" fill="#000"/>
                  <rect x={x+2} y={y+2} width="4" height="4" fill="#fff"/>
                </g>
              ))}
              {Array.from({ length: 60 }).map((_, i) => {
                const r = (i * 9301 + 49297) % 233280;
                const x = 12 + (i % 8) * 4;
                const y = 12 + Math.floor(i / 8) * 4;
                return r % 2 === 0 ? <rect key={i} x={x} y={y} width="3" height="3" fill="#000"/> : null;
              })}
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// Connection states — three small artboards in one row
// Visualizes §4 P7: silent reconnect is forbidden.
// ───────────────────────────────────────────────────────────────

function ConnReconnecting() {
  return <ConnStateFrame status="reconnecting" title="WebSocket 中断 · 正在重连"
    sub="Heartbeat 超时 → 退避重连 · 第 2 次尝试"
    detail={[
      ['attempts', '2 / 5'],
      ['lastSeq', '14921'],
      ['backoff', '2.0s'],
      ['hint', '出价按钮已临时禁用'],
    ]}
    color="var(--douyin-cyan)"
  />;
}

function ConnSyncing() {
  return <ConnStateFrame status="syncing" title="正在同步遗漏事件"
    sub="ROOM_JOIN(lastSeq=14921) → XRANGE 14922→14998"
    detail={[
      ['gap', '#14922 → #14998 · 77 events'],
      ['progress', '64 / 77 (83%)'],
      ['ETA', '~ 240 ms'],
      ['hint', '出价排队中 · 同步完成后回放'],
    ]}
    color="var(--douyin-cyan)"
    progress={0.83}
  />;
}

function ConnSchema() {
  return <ConnStateFrame status="schema" title="协议版本不匹配"
    sub={`server.schemaVersion=${CURRENT_SCHEMA_VERSION + 1} · client.schemaVersion=${CURRENT_SCHEMA_VERSION}`}
    detail={[
      ['code', 'WS_SCHEMA_MISMATCH'],
      ['action', '请下拉刷新或重新进入直播间'],
      ['support', '错误已上报 · 不影响其他直播间'],
    ]}
    color="var(--state-rejected)"
    danger
  />;
}

function ConnStateFrame({ status, title, sub, detail, color, progress, danger }) {
  return (
    <div style={{
      position: 'relative', width: '100%', height: '100%',
      background: 'var(--douyin-ink)', color: 'var(--douyin-ink-text)',
      fontFamily: 'var(--font-sans)', overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Top conn bar */}
      <div style={{
        position: 'absolute', top: 47, left: 0, right: 0, height: 26,
        background: danger ? 'rgba(254,44,85,.18)' : 'rgba(0,0,0,.55)',
        backdropFilter: 'blur(8px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        color, fontSize: 11, fontWeight: 500, zIndex: 30,
        overflow: 'hidden', borderBottom: `1px solid ${color}33`,
      }}>
        {!danger && <div className="lumen-shimmer" style={{
          position: 'absolute', inset: 0, height: 2, top: 'auto', bottom: 0,
        }}/>}
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
          {danger ? (
            <>
              <circle cx="5.5" cy="5.5" r="4.5" stroke={color} strokeWidth="1.2"/>
              <line x1="3" y1="3" x2="8" y2="8" stroke={color} strokeWidth="1.2" strokeLinecap="round"/>
            </>
          ) : (
            <>
              <circle cx="5.5" cy="5.5" r="3" stroke={color} strokeWidth="1" fill="none"/>
              <circle cx="5.5" cy="5.5" r="1.2" fill={color}/>
            </>
          )}
        </svg>
        {sub}
      </div>

      {/* Dimmed faux-room behind */}
      <div style={{
        position: 'absolute', inset: 0, opacity: .25, pointerEvents: 'none',
      }}>
        <div style={{
          position: 'absolute', inset: 0, height: '46%',
          background: 'linear-gradient(160deg,#2a1f2e,#0a0e1a)',
        }}/>
        <svg viewBox="0 0 200 200" style={{
          position: 'absolute', top: '8%', left: '50%', transform: 'translateX(-50%)',
          width: 120, height: 120, opacity: .35,
        }}>
          <circle cx="100" cy="100" r="48" fill="none" stroke="#C9A961" strokeWidth="1.5"/>
          <circle cx="100" cy="100" r="42" fill="#0d0d14"/>
        </svg>
      </div>

      {/* Center modal-card */}
      <div style={{
        margin: 'auto', width: 'calc(100% - 32px)',
        padding: '20px 18px', borderRadius: 14,
        background: 'rgba(20,23,33,.92)', backdropFilter: 'blur(20px)',
        border: '1px solid ' + (danger ? 'rgba(254,44,85,.4)' : 'rgba(37,244,238,.3)'),
        boxShadow: '0 20px 60px rgba(0,0,0,.5)',
        display: 'flex', flexDirection: 'column', gap: 14, zIndex: 20,
      }}>
        {/* Spinner / icon */}
        <div style={{
          width: 44, height: 44, borderRadius: 22, alignSelf: 'center',
          background: 'rgba(0,0,0,.4)',
          border: `2px solid ${color}55`,
          borderTopColor: color,
          animation: danger ? 'none' : 'lumen-spin 1.2s linear infinite',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color, fontSize: 18, fontWeight: 700,
        }}>{danger ? '!' : ''}</div>

        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{title}</div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--douyin-ink-muted)', lineHeight: 1.5 }}>
            {sub}
          </div>
        </div>

        {progress != null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,.06)', overflow: 'hidden' }}>
              <div style={{
                width: `${progress * 100}%`, height: '100%', background: color,
                transition: 'width .3s',
              }}/>
            </div>
            <span className="mono" style={{ fontSize: 9, color: 'var(--douyin-ink-muted)', textAlign: 'right' }}>
              {Math.round(progress * 100)}%
            </span>
          </div>
        )}

        <div style={{
          padding: '10px 12px', borderRadius: 8, background: 'rgba(0,0,0,.3)',
          display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          {detail.map(([k, v]) => (
            <div key={k} className="mono" style={{
              display: 'flex', justifyContent: 'space-between',
              fontSize: 10, color: 'var(--douyin-ink-muted)',
            }}>
              <span>{k}</span>
              <span style={{ color: 'var(--douyin-ink-text)' }}>{v}</span>
            </div>
          ))}
        </div>

        <button style={{
          width: '100%', padding: '10px', borderRadius: 8, cursor: 'pointer',
          background: danger ? color : 'rgba(255,255,255,.04)',
          color: danger ? '#fff' : color, fontFamily: 'inherit',
          fontSize: 12, fontWeight: 600, border: '1px solid ' + (danger ? color : color + '40'),
        }}>
          {danger ? '刷新页面' : status === 'reconnecting' ? '取消并退出' : '后台等待'}
        </button>
      </div>

      {/* Inject spin keyframe */}
      <style>{`@keyframes lumen-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export {
  MiniProgramStub,
  ConnReconnecting,
  ConnSyncing,
  ConnSchema
};
