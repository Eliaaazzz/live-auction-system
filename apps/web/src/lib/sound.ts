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

export const sfx = {
  /** 任意一笔新出价 —— 轻快短促 */
  bid: () => tone(760, 0.08, 'triangle', 0.1),
  /** 我领先 —— 上行三音 */
  lead: () => {
    tone(660, 0.1, 'sine', 0.16, 0);
    tone(880, 0.12, 'sine', 0.16, 0.08);
    tone(1175, 0.18, 'sine', 0.16, 0.17);
  },
  /** 被超越 —— 下行刺耳 */
  outbid: () => {
    tone(320, 0.16, 'sawtooth', 0.14, 0, 180);
    tone(240, 0.2, 'sawtooth', 0.12, 0.06, 150);
  },
  /** 自动延时 —— 双声提示 */
  extend: () => {
    tone(520, 0.08, 'square', 0.1, 0);
    tone(720, 0.1, 'square', 0.1, 0.09);
  },
  /** 倒计时滴答 */
  tick: () => tone(1180, 0.04, 'square', 0.07),
  /** 最后 5 秒急促滴答 */
  tickUrgent: () => tone(1560, 0.05, 'square', 0.12),
  /** 落槌 —— 低频闷响 + 噪声 */
  hammer: () => {
    tone(170, 0.2, 'triangle', 0.24, 0, 90);
    noise(0.14, 0.14, 0.0);
  },
  /** 竞拍成功 —— 上行琶音 */
  win: () => {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.2, 'sine', 0.16, i * 0.1));
  },
  /** 流拍 —— 低落两音 */
  lose: () => {
    tone(400, 0.18, 'sine', 0.12, 0, 300);
    tone(300, 0.22, 'sine', 0.1, 0.12, 220);
  },
  /** 送礼物 —— 轻快上行双音叮咚 */
  gift: () => {
    tone(880, 0.1, 'triangle', 0.14, 0);
    tone(1320, 0.14, 'triangle', 0.14, 0.08);
  },
};
