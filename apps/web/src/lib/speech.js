// src/lib/speech.js
//
// Key-moment auctioneer VOICE. The brief (Jerry): AI 不做主播 — it does NOT
// narrate continuously; it only 在关键时刻出声 (开拍 / 黑马 / 反狙击延时 / 落槌).
//
// Tier 1 (this file): the browser Web Speech API (speechSynthesis). Zero key,
// zero cost, offline, instant — perfect for the live demo drama. It is the
// OS/browser TTS, NOT a model call, so it does not by itself count as an "AI
// capability"; it is the always-available fallback.
//
// Tier 2 (follow-up): 豆包语音合成2.0 (Volcengine TTS, separate appid+token /
// WebSocket service) produces the high-fidelity "real AI voice" for the same
// cues. The cue layer (AuctioneerVoice.jsx) is source-agnostic: swapping in a
// fetch-Doubao-audio + <audio> playback path is a drop-in, the trigger logic
// stays. Until then this keeps the feature live without credentials.

// isSpeechSupported guards SSR + jsdom (tests) + older browsers: both the synth
// and the utterance constructor must exist.
export function isSpeechSupported() {
  return typeof window !== 'undefined'
    && typeof window.speechSynthesis !== 'undefined'
    && typeof window.SpeechSynthesisUtterance !== 'undefined';
}

// pickZhVoice prefers an installed zh-CN / Mandarin voice so the cue sounds
// native. getVoices() can be empty until the async 'voiceschanged' event, so
// callers tolerate a null (utterance.lang=zh-CN still steers most engines).
function pickZhVoice() {
  try {
    const voices = window.speechSynthesis.getVoices() || [];
    return voices.find((v) => /zh|cmn|chinese|mandarin/i.test(`${v.lang} ${v.name}`)) || null;
  } catch {
    return null;
  }
}

// speakCue speaks one short cue. Key-moment cues are punchy and must not queue
// up behind each other, so we cancel() any in-flight utterance first (the
// newest moment wins). Returns true if it actually spoke — false on mute /
// unsupported / empty, so callers/tests can assert without throwing.
export function speakCue(text, opts = {}) {
  const { mute = false, rate = 1.06, pitch = 1, volume = 1 } = opts;
  if (mute || !text || !isSpeechSupported()) return false;
  try {
    const synth = window.speechSynthesis;
    synth.cancel();
    const u = new window.SpeechSynthesisUtterance(String(text));
    u.lang = 'zh-CN';
    u.rate = rate;
    u.pitch = pitch;
    u.volume = volume;
    const voice = pickZhVoice();
    if (voice) u.voice = voice;
    synth.speak(u);
    return true;
  } catch {
    return false;
  }
}

// cancelSpeech stops any in-flight cue (sound toggled off / room unmount).
export function cancelSpeech() {
  if (!isSpeechSupported()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    /* best-effort */
  }
}
