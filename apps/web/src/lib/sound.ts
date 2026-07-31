// Auction sound effects — synthesized with the Web Audio API (no audio files).
// Works offline; nothing to download. Muted state persists in localStorage.
// Browsers block audio until a user gesture, so call unlockAudio() on first tap.

let ctx: AudioContext | null = null;
let muted = typeof localStorage !== 'undefined' && localStorage.getItem('la_muted') === '1';

function ac(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export function unlockAudio(): void {
  ac();
}

export function isMuted(): boolean {
  return muted;
}
export function setMuted(m: boolean): void {
  muted = m;
  try {
    localStorage.setItem('la_muted', m ? '1' : '0');
  } catch {
    /* ignore */
  }
  if (!m) ac();
}

function tone(freq: number, dur: number, type: OscillatorType = 'sine', gain = 0.16, when = 0, slideTo?: number): void {
  const c = ac();
  if (!c || muted) return;
  const t0 = c.currentTime + when;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(c.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.03);
}

function noise(dur: number, gain: number, when = 0): void {
  const c = ac();
  if (!c || muted) return;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
  const src = c.createBufferSource();
  src.buffer = buf;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(g).connect(c.destination);
  src.start(c.currentTime + when);
}

// ── #261-6 spoken announcements (Web Speech API) ─────────────────
// Taking the lead / being outbid / a sale are announced aloud, sharing the mute switch with the sound
// effects. When speechSynthesis is missing (older WebViews) it degrades silently to sound only.
// Each announcement cancel()s anything still queued: under rapid bidding we read out the latest state,
// not the history.
// Chromium gotcha: calling speak() in the same tick as cancel() leaves the new utterance stuck in the
// pending queue with no sound, so rapid bids that cancel each other pile up and only spit out a stale
// "you are in the lead" after the hammer. So cancel and speak must be a tick apart, and a generation
// counter drops any announcement that a newer one has already superseded.
let lastSpeakAt = 0;
let lastSpeakText = '';
let speakGen = 0;
let speakTimer: ReturnType<typeof setTimeout> | undefined;
export function speak(text: string, minGapMs = 2500): void {
  if (muted || typeof window === 'undefined') return;
  const synth = window.speechSynthesis;
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return;
  const now = Date.now();
  // Throttle identical lines: chained auto-bid flips do not turn it into a parrot; a different line (lead -> outbid) cuts in immediately.
  if (text === lastSpeakText && now - lastSpeakAt < minGapMs) return;
  lastSpeakAt = now;
  lastSpeakText = text;
  const gen = ++speakGen;
  if (speakTimer !== undefined) clearTimeout(speakTimer);
  try { synth.cancel(); } catch { /* ignore */ }
  speakTimer = setTimeout(() => {
    if (gen !== speakGen) return; // superseded by a newer announcement
    try {
      synth.resume(); // Chromium occasionally sticks in the paused state, so resume before speaking
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 1.12;
      u.pitch = 1.05;
      u.volume = 0.95;
      synth.speak(u);
    } catch { /* ignore */ }
  }, 60);
}

// On a terminal state such as the close, flush any in-flight or pending stale announcements (lead, outbid) so it does not still be shouting "in the lead" after the hammer.
export function cancelSpeak(): void {
  speakGen++;
  if (speakTimer !== undefined) clearTimeout(speakTimer);
  lastSpeakText = '';
  if (typeof window === 'undefined') return;
  try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
}

export const sfx = {
  /** Any new bid - short and light */
  bid: () => tone(760, 0.08, 'triangle', 0.1),
  /** I am leading - a rising three-note figure */
  lead: () => {
    tone(660, 0.1, 'sine', 0.16, 0);
    tone(880, 0.12, 'sine', 0.16, 0.08);
    tone(1175, 0.18, 'sine', 0.16, 0.17);
  },
  /** Outbid - a harsh descending figure */
  outbid: () => {
    tone(320, 0.16, 'sawtooth', 0.14, 0, 180);
    tone(240, 0.2, 'sawtooth', 0.12, 0.06, 150);
  },
  /** Auto-extension - a two-tone alert */
  extend: () => {
    tone(520, 0.08, 'square', 0.1, 0);
    tone(720, 0.1, 'square', 0.1, 0.09);
  },
  /** Countdown tick */
  tick: () => tone(1180, 0.04, 'square', 0.07),
  /** Urgent ticking in the last 5 seconds */
  tickUrgent: () => tone(1560, 0.05, 'square', 0.12),
  /** Hammer - a low thud plus noise */
  hammer: () => {
    tone(170, 0.2, 'triangle', 0.24, 0, 90);
    noise(0.14, 0.14, 0.0);
  },
  /** Auction won - a rising arpeggio */
  win: () => {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.2, 'sine', 0.16, i * 0.1));
  },
  /** No bid - two downcast notes */
  lose: () => {
    tone(400, 0.18, 'sine', 0.12, 0, 300);
    tone(300, 0.22, 'sine', 0.1, 0.12, 220);
  },
  /** Gift sent - a bright rising two-note chime */
  gift: () => {
    tone(880, 0.1, 'triangle', 0.14, 0);
    tone(1320, 0.14, 'triangle', 0.14, 0.08);
  },
};
