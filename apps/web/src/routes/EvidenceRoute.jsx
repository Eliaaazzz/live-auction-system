// src/routes/EvidenceRoute.jsx
//
// Real backend-wired Evidence card.
//
// Boot order:
//   1. ensureSession()              → JWT cached (Evidence endpoint is auth-gated
//                                     for the order block; timeline is public but
//                                     we send the bearer either way)
//   2. api.getEvidence(auctionId)   → { timeline[], eventsHash, chainVerified,
//                                       hashBreakAtSeq?, order?, ... }
//   3. render <MobileEvidence evidence={response} />
//
// Per blueprint §5 and proto/evidence-card.md §1: `hashBreakAtSeq` is
// present ONLY when chainVerified=false; order is present ONLY when an
// order exists (and the caller is authenticated).
//
// ─── HMAC custody — threat model (summary; canonical in proto/evidence-card.md §6) ───
// What the chain DEFENDS against: post-hoc single-point tampering of a
// stored event (edit a `payload_json` or an `event_hash`) — recompute
// breaks at that seq, anyone holding the HMAC key can detect it. The
// CHAIN BROKEN UI rendered when chainVerified=false signals this.
//
// What it does NOT do: external notarization. If the HMAC key is
// readable by the same process that writes events (as in T1 dev mode),
// a malicious writer with key access can re-chain a forgery. T1-T6
// describes this as an "integrity / consistency check," not tamper-
// proof evidence. Hardening (KMS-managed key, separate signer,
// rotation with versioned key-id column) is post-MVP.
//
// Implication for this UI: chainVerified=true means "the recompute
// agreed with the stored chain head right now," NOT "no one ever
// modified this auction." Surface chain-verified credibility as a
// strong-but-not-absolute signal; reviewers reading the card should
// see "T4 evidence v0 · 哈希链可验证" not "blockchain-secured."

import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { MobileEvidence } from '../components/mobile.jsx';
import { formatCentsCNY } from '../components/primitives.jsx';
import { ensureSession } from '../lib/auth.js';
import { api } from '../lib/api.js';

export function EvidenceRoute() {
  const { auctionId } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState({ phase: 'loading', evidence: null, error: null });
  const [order, setOrder] = useState(null); // settlement order (null = none / not sold)

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await ensureSession('demo');
        const ev = await api.getEvidence(auctionId);
        if (!alive) return;
        setState({ phase: 'ready', evidence: ev, error: null });
        // Best-effort: a SOLD auction has a settlement order (模拟支付). 404 = none.
        try { const o = await api.getOrder(auctionId); if (alive) setOrder(o); } catch { /* no order */ }
      } catch (e) {
        if (!alive) return;
        const msg = e?.message || String(e);
        setState({ phase: 'error', evidence: null, error: msg });
      }
    })();
    return () => { alive = false; };
  }, [auctionId]);

  if (state.phase === 'loading') {
    return <EvidenceStatus message="加载证据卡 · LOADING EVIDENCE …" />;
  }
  if (state.phase === 'error') {
    return <EvidenceStatus message={`无法读取证据卡 · ${state.error}`} tone="error" />;
  }
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <MobileEvidence evidence={state.evidence} onBack={() => navigate(`/room/${auctionId}`)} />
      {order && <PaymentBar order={order} onPaid={setOrder} auctionId={auctionId} />}
    </div>
  );
}

// 结果查看 · 模拟支付流程. Shows the settlement amount + a pay button; idempotent
// (POST /pay). 403 → only the winning buyer may pay.
function PaymentBar({ order, onPaid, auctionId }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const paid = order.status === 'paid' || !!order.paidAt;
  const pay = async () => {
    setBusy(true); setMsg(null);
    try { onPaid(await api.pay(auctionId)); }
    catch (e) { setMsg(/403/.test(e?.message || '') ? '仅中拍买家可支付' : (e?.message || '支付失败')); }
    finally { setBusy(false); }
  };
  return (
    <div style={{
      position: 'absolute', left: 0, right: 0, bottom: 0, padding: '14px 18px',
      background: 'rgba(10,10,20,.92)', borderTop: '1px solid rgba(201,169,97,.25)',
      display: 'flex', alignItems: 'center', gap: 12, fontFamily: 'var(--font-sans)',
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 11, color: 'var(--solemn-cream-dim, #9aa0b4)' }}>成交价 · 待支付</div>
        <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: 'var(--solemn-gold)' }}>
          {formatCentsCNY(String(order.amountCents))}
        </div>
        {msg && <div style={{ fontSize: 11, color: 'var(--state-rejected,#ff6b6b)' }}>{msg}</div>}
      </div>
      {paid
        ? <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--douyin-cyan,#25F4EE)' }}>已支付 ✓</span>
        : <button onClick={pay} disabled={busy} style={{
            padding: '10px 22px', borderRadius: 999, border: 'none', cursor: 'pointer',
            background: 'var(--douyin-red,#FE2C55)', color: '#fff', fontSize: 14, fontWeight: 700,
          }}>{busy ? '支付中…' : '模拟支付'}</button>}
    </div>
  );
}

function EvidenceStatus({ message, tone = 'info' }) {
  return (
    <div style={{
      position: 'relative', width: '100%', height: '100%',
      background: 'var(--solemn-deep)', color: 'var(--solemn-cream)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--font-sans)', gap: 12, padding: 24, textAlign: 'center',
    }}>
      <div style={{
        width: 30, height: 30, borderRadius: 16,
        border: `1px solid ${tone === 'error' ? 'var(--state-rejected)' : 'var(--solemn-gold)'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <span style={{ color: tone === 'error' ? 'var(--state-rejected)' : 'var(--solemn-gold)' }}>
          {tone === 'error' ? '×' : '◷'}
        </span>
      </div>
      <span style={{ fontSize: 12, color: 'var(--solemn-cream-dim)', letterSpacing: '.05em' }}>
        {message}
      </span>
    </div>
  );
}

export default EvidenceRoute;
