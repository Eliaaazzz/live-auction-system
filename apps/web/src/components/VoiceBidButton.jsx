// src/components/VoiceBidButton.jsx
//
// 语音出价 — hold-to-talk bid. The buyer says 「加价五千」/「出价十三万八」/
// 「加三档」; browser ASR transcribes it, parseBidUtterance() turns it into a
// target amount, and after a one-tap confirm it goes through the SAME onBid
// lane as a chip tap. AI is NON-AUTHORITATIVE (V9 P3): a mis-hear is at worst
// rejected by the backend Lua adjudicator — it can never corrupt the auction.
//
// Tier 1 (this component): the browser Web Speech API (SpeechRecognition) —
// zero key, works in Chrome/Edge. Tier 2 (follow-up): 豆包语音识别2.0 (火山
// ASR) for an on-theme, higher-accuracy, privacy-kept transcript — swap the
// transcript SOURCE, the parse + confirm + onBid flow is unchanged.

import React from 'react';
import { parseBidUtterance } from '../lib/voicebid.js';
import { formatCentsCNYShort } from './primitives.jsx';

function getRecognitionCtor() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function VoiceBidButton({ currentCents = '0', stepCents = '0', disabled = false, onBid }) {
  const [listening, setListening] = React.useState(false);
  const [pending, setPending] = React.useState(null); // { heard, amountCents }
  const [note, setNote] = React.useState(null);
  const recRef = React.useRef(null);

  React.useEffect(() => () => { try { recRef.current?.abort?.(); } catch { /* noop */ } }, []);

  const handleTranscript = React.useCallback((transcript) => {
    const r = parseBidUtterance(transcript, { currentCents, stepCents });
    if (r.ok) {
      setPending({ heard: r.heard, amountCents: r.amountCents });
      setNote(null);
    } else {
      setPending(null);
      setNote(r.reason);
    }
  }, [currentCents, stepCents]);

  const start = React.useCallback(() => {
    if (disabled || listening) return;
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setNote('当前浏览器不支持语音 · 请用下方加价键');
      return;
    }
    let rec;
    try {
      rec = new Ctor();
    } catch {
      setNote('语音初始化失败 · 请用加价键');
      return;
    }
    rec.lang = 'zh-CN';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      const tx = e?.results?.[0]?.[0]?.transcript || '';
      handleTranscript(tx);
    };
    rec.onerror = () => { setListening(false); setNote('没听清，请再说一次'); };
    rec.onend = () => setListening(false);
    recRef.current = rec;
    setPending(null);
    setNote(null);
    setListening(true);
    try {
      rec.start();
    } catch {
      setListening(false);
      setNote('语音启动失败 · 请用加价键');
    }
  }, [disabled, listening, handleTranscript]);

  const confirm = React.useCallback(() => {
    if (!pending) return;
    onBid?.(pending.amountCents);
    setNote(`已提交 ${formatCentsCNYShort(pending.amountCents)}`);
    setPending(null);
  }, [pending, onBid]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <button
        type="button"
        onClick={start}
        disabled={disabled || listening}
        aria-label="语音出价"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          minHeight: 40, padding: '0 14px', borderRadius: 10, cursor: disabled ? 'not-allowed' : 'pointer',
          border: '1px solid rgba(37,244,238,.4)',
          background: listening ? 'rgba(37,244,238,.18)' : 'rgba(37,244,238,.07)',
          color: 'var(--douyin-cyan)', fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 700,
        }}>
        <span aria-hidden style={{ fontSize: 15 }}>{listening ? '●' : '🎤'}</span>
        {listening ? '正在聆听…' : '语音出价 · 说「加价五千」'}
      </button>

      {pending && (
        <div role="alert" style={{
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          padding: '8px 10px', borderRadius: 10,
          background: 'rgba(201,169,97,.12)', border: '1px solid rgba(201,169,97,.4)',
          fontFamily: 'var(--font-sans)',
        }}>
          <span style={{ fontSize: 11, color: 'var(--douyin-ink-muted)' }}>听到「{pending.heard}」</span>
          <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--solemn-gold)' }}>
            出价 {formatCentsCNYShort(pending.amountCents)}
          </span>
          <div style={{ flex: 1 }}/>
          <button type="button" onClick={() => setPending(null)} style={{
            minHeight: 32, padding: '0 10px', borderRadius: 8, cursor: 'pointer',
            border: '1px solid rgba(255,255,255,.18)', background: 'transparent',
            color: 'var(--douyin-ink-muted)', fontSize: 12, fontWeight: 600,
          }}>取消</button>
          <button type="button" onClick={confirm} style={{
            minHeight: 32, padding: '0 14px', borderRadius: 8, cursor: 'pointer', border: 'none',
            background: 'linear-gradient(135deg, var(--douyin-red), var(--douyin-red-soft))',
            color: '#fff', fontSize: 12, fontWeight: 700,
          }}>确认出价</button>
        </div>
      )}

      {note && !pending && (
        <div style={{ fontSize: 11, color: 'var(--douyin-ink-muted)', textAlign: 'center' }}>{note}</div>
      )}
    </div>
  );
}

export default VoiceBidButton;
