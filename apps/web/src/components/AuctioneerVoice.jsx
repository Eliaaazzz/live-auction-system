// src/components/AuctioneerVoice.jsx
//
// AI 关键时刻出声 (Jerry's brief: AI 不做主播，只在关键时刻出声). An invisible
// driver that fires ONE short spoken cue at each auction beat — not continuous
// narration. Gated by the room's sound toggle; speech source is the browser
// Web Speech API today (lib/speech.js), swappable for 豆包语音合成 later.
//
// Beats: 开拍 (SCHEDULED→LIVE) · 黑马 (≥5× jump) · 反狙击延时 (AUCTION_EXTENDED)
// · 落槌成交 (SOLD) · 流拍 (NO_BID). Each de-duped so one occurrence = one cue.

import React from 'react';
import { speakCue, cancelSpeech } from '../lib/speech.js';

export const VOICE_CUES = {
  open: '拍卖开始',
  surge: '黑马出价',
  extend: '反狙击延时',
  sold: '落槌成交',
  nobid: '本场流拍',
};

export function AuctioneerVoice({ enabled = false, status, showBlackHorse = false, extendFlash = null }) {
  const prevStatus = React.useRef(status);
  // already-LIVE on mount (page reload / deep-link into a running auction) must
  // NOT shout 开拍 — only a real SCHEDULED→LIVE transition does.
  const spokeOpen = React.useRef(status === 'LIVE');
  const spokeBlackHorse = React.useRef(false);
  const lastExtendTok = React.useRef(extendFlash ? (extendFlash.seq ?? extendFlash.count) : null);

  // status-transition cues: 开拍 / 落槌 / 流拍
  React.useEffect(() => {
    const prev = prevStatus.current;
    if (enabled && prev && prev !== status) {
      if (status === 'LIVE' && !spokeOpen.current) {
        speakCue(VOICE_CUES.open);
        spokeOpen.current = true;
      } else if (status === 'SOLD') {
        speakCue(VOICE_CUES.sold);
      } else if (status === 'NO_BID') {
        speakCue(VOICE_CUES.nobid);
      }
    }
    prevStatus.current = status;
  }, [status, enabled]);

  // 黑马: speak once while the banner is up; re-arm when it clears so the next
  // jump speaks again.
  React.useEffect(() => {
    if (enabled && showBlackHorse && !spokeBlackHorse.current) {
      speakCue(VOICE_CUES.surge);
      spokeBlackHorse.current = true;
    }
    if (!showBlackHorse) spokeBlackHorse.current = false;
  }, [showBlackHorse, enabled]);

  // 反狙击延时: extendFlash is a one-shot {count,seq,addedSec} the store sets
  // then clears. Fire once per new seq (token), ignore the clear-to-null.
  React.useEffect(() => {
    const tok = extendFlash ? (extendFlash.seq ?? extendFlash.count) : null;
    if (enabled && extendFlash && tok !== lastExtendTok.current) {
      speakCue(VOICE_CUES.extend);
    }
    lastExtendTok.current = tok;
  }, [extendFlash, enabled]);

  // stop any in-flight cue when sound is muted or the room unmounts.
  React.useEffect(() => {
    if (!enabled) cancelSpeech();
    return () => cancelSpeech();
  }, [enabled]);

  return null;
}

export default AuctioneerVoice;
