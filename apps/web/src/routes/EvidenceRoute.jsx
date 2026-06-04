// src/routes/EvidenceRoute.jsx
//
// Real backend-wired Evidence card.
//
// Boot order:
//   1. ensureSession()              → JWT cached (Evidence endpoint is auth-gated
//                                     for the order block; timeline is public but
//                                     we send the bearer either way)
//   2. api.getEvidence(auctionId)   → { timeline[], eventsHash, chainVerified,
//                                       auctionMode, hashBreakAtSeq?, order?, ... }
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
import { useParams } from 'react-router-dom';
import { MobileEvidence } from '../components/mobile.jsx';
import { ensureSession } from '../lib/auth.js';
import { api } from '../lib/api.js';

export function EvidenceRoute() {
  const { auctionId } = useParams();
  const [state, setState] = useState({ phase: 'loading', evidence: null, error: null });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await ensureSession('demo');
        const ev = await api.getEvidence(auctionId);
        if (!alive) return;
        setState({ phase: 'ready', evidence: ev, error: null });
      } catch (e) {
        if (!alive) return;
        // Network / 404 / 401 — surface a minimal error state. The Evidence
        // screen's solemn palette is held even on error so a teammate seeing
        // the URL gets the right visual cue (this is a record, not the room).
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
  return <MobileEvidence evidence={state.evidence} />;
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
