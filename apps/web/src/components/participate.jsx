import React from 'react';
import { formatCentsCNY } from './primitives.jsx';

// lumen-participate.jsx
// Participation gate for the buyer room: a "我要参与" CTA that, once the buyer
// accepts the auction terms, unlocks the bid chips. MobileRoom owns the
// joined/persistence state (lib/prefs); these are the two presentational
// pieces. Default-off in MobileRoom so preview rooms + the existing
// bid-locking tests keep their direct-to-chips behavior; LiveRoomRoute opts in.

// ─── ParticipateGate — shown in place of the bid chips until terms accepted ──
export function ParticipateGate({ onJoin, disabled = false }) {
  return (
    <button
      onClick={onJoin}
      disabled={disabled}
      style={{
        width: '100%', padding: '14px 18px', borderRadius: 14,
        background: disabled
          ? 'rgba(107,114,128,.3)'
          : 'linear-gradient(135deg, var(--douyin-red) 0%, var(--douyin-red-soft) 100%)',
        color: '#fff', border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: 'var(--font-sans)', fontSize: 15, fontWeight: 600,
        letterSpacing: '.02em',
        boxShadow: disabled ? 'none' : '0 4px 14px rgba(254,44,85,.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
      }}>
      我要参与
      <span style={{ fontSize: 11, fontWeight: 500, opacity: .85 }}>· 阅读条款后出价</span>
    </button>
  );
}

// ─── RulesTermsModal — terms & conditions confirm before participating ───
// Demo-honest, compliance-tight copy: transparent single-item auction, virtual
// settlement, no real payment/logistics (CLAUDE.md Hard Rules). Surfaces the
// rules the meeting asked for: 最低加价, 反狙击延时, 约束性出价意向.
export function RulesTermsModal({ visible, stepCents = '500000', onConfirm, onClose }) {
  const [agreed, setAgreed] = React.useState(false);
  React.useEffect(() => { if (!visible) setAgreed(false); }, [visible]);
  // Esc-to-close (cheap a11y; backdrop click + 取消 also close).
  React.useEffect(() => {
    if (!visible) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [visible, onClose]);
  if (!visible) return null;

  const terms = [
    ['透明单品竞拍', '已认证的单件高价值商品 · 非盲盒 · 非随机 · 无真伪担保延伸'],
    ['最低加价', `每次出价至少 +${formatCentsCNY(stepCents)}，且须为该阶梯的整数倍`],
    ['反狙击延时', '末 10 秒内出价自动延长 +30 秒，直至达到上限次数'],
    ['出价具约束力', '出价即代表理性、负责的竞拍意向，请勿恶意出价后弃标'],
    ['虚拟币结算', '虚拟币 · 非真实支付 · 非赌博 · 不构成真实支付与物流承诺'],
    ['全程可验证', '所有事件上链至证据卡，序列化、可校验、不可篡改'],
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="参与竞拍条款确认"
      onClick={onClose}
      style={{
        position: 'absolute', inset: 0, zIndex: 75,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        background: 'rgba(8,8,14,.66)', backdropFilter: 'blur(10px)',
        fontFamily: 'var(--font-sans)',
      }}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxHeight: '82%', display: 'flex', flexDirection: 'column',
          background: 'var(--douyin-ink-card)',
          borderTopLeftRadius: 18, borderTopRightRadius: 18,
          border: '1px solid rgba(255,255,255,.08)', borderBottom: 'none',
          padding: '14px 18px 22px',
        }}>
        <div style={{
          alignSelf: 'center', width: 36, height: 4, borderRadius: 2,
          background: 'rgba(255,255,255,.18)', marginBottom: 12,
        }}/>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
          <span className="serif" style={{ fontSize: 18, fontWeight: 600 }}>参与竞拍</span>
          <span style={{ fontSize: 11, color: 'var(--douyin-ink-muted)', letterSpacing: '.04em' }}>
            TERMS · 条款确认
          </span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--douyin-ink-dim)', marginBottom: 12 }}>
          出价前请阅读并同意以下规则。
        </div>

        <div className="no-scrollbar" style={{
          flex: 1, minHeight: 0, overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          {terms.map(([title, body], i) => (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <span className="mono" style={{
                flexShrink: 0, width: 18, height: 18, borderRadius: 9,
                background: 'rgba(201,169,97,.16)', color: 'var(--solemn-gold)',
                fontSize: 10, fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>{i + 1}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--douyin-ink-text)' }}>
                  {title}
                </div>
                <div style={{ fontSize: 11, color: 'var(--douyin-ink-muted)', lineHeight: 1.5, marginTop: 2 }}>
                  {body}
                </div>
              </div>
            </div>
          ))}
        </div>

        <label style={{
          display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
          margin: '14px 0 12px', fontSize: 12, color: 'var(--douyin-ink-text)',
        }}>
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            style={{ width: 16, height: 16, accentColor: 'var(--douyin-red)' }}
          />
          我已阅读并同意以上条款
        </label>

        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={onClose}
            style={{
              flex: '0 0 96px', padding: '13px', borderRadius: 12,
              background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.1)',
              color: 'var(--douyin-ink-text)', fontFamily: 'inherit',
              fontSize: 14, fontWeight: 600, cursor: 'pointer',
            }}>
            取消
          </button>
          <button
            onClick={() => { if (agreed) onConfirm?.(); }}
            disabled={!agreed}
            style={{
              flex: 1, padding: '13px', borderRadius: 12, border: 'none',
              background: agreed
                ? 'linear-gradient(135deg, var(--douyin-red) 0%, var(--douyin-red-soft) 100%)'
                : 'rgba(107,114,128,.3)',
              color: '#fff', fontFamily: 'inherit', fontSize: 14, fontWeight: 600,
              cursor: agreed ? 'pointer' : 'not-allowed',
              boxShadow: agreed ? '0 4px 14px rgba(254,44,85,.35)' : 'none',
            }}>
            确认参与
          </button>
        </div>
      </div>
    </div>
  );
}
