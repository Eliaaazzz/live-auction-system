// src/lib/format.js
// Money is string-cents (per blueprint §4 P1). Never parse to Number.

export function formatCentsCNY(cents) {
  const s = String(cents);
  const neg = s.startsWith('-');
  // Cents are integer-only; strip any non-digit so a malformed value
  // (undefined / null / '' / partial event payload) degrades to ¥0.00
  // instead of rendering garbage like "¥undefin.ed".
  const abs = (neg ? s.slice(1) : s).replace(/[^0-9]/g, '') || '0';
  const padded = abs.padStart(3, '0');
  const yuan = padded.slice(0, -2);
  const fen = padded.slice(-2);
  const grouped = yuan.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + '¥' + grouped + '.' + fen;
}

export function addCentsStr(a, b) {
  const an = BigInt(a);
  const bn = BigInt(b);
  return (an + bn).toString();
}

// formatCentsCompact — space-constrained CN unit display (万 / 亿).
//
// The canonical formatCentsCNY stays exact (千分位 + 两位分) and is used
// everywhere precision matters (price card, evidence card, hammer). This
// compact variant is for tight spots (leaderboard rows, bid-history pills,
// overflowing chips) where "¥12.88万" reads cleaner than "¥128,800.00".
//
// Chinese groups large numbers by 4 digits (万 = 10^4 元, 亿 = 10^8 元);
// below 1万元 we fall back to the exact format so small amounts never get
// a misleading "0.99万". String-cents / BigInt only — never parseFloat.
export function formatCentsCompact(cents) {
  const s = String(cents);
  const neg = s.startsWith('-');
  const absStr = neg ? s.slice(1) : s;
  let abs;
  try { abs = BigInt(absStr || '0'); } catch { return formatCentsCNY(cents); }

  const WAN = 1000000n;      // 1 万元 in cents  (10^4 元 × 100)
  const YI  = 10000000000n;  // 1 亿元 in cents  (10^8 元 × 100)
  if (abs < WAN) return formatCentsCNY(cents);

  const sign = neg ? '-' : '';
  if (abs < YI) return sign + '¥' + scaleToUnit(abs, WAN) + '万';
  return sign + '¥' + scaleToUnit(abs, YI) + '亿';
}

// abs / unit, kept to ≤2 decimals (trailing zeros trimmed), whole part
// grouped with 千分位. All BigInt so 9e15 cents survives without drift.
function scaleToUnit(abs, unit) {
  const scaled = (abs * 100n) / unit; // value × 100, floored
  const whole = scaled / 100n;
  const frac = scaled % 100n;
  const fracStr = frac.toString().padStart(2, '0').replace(/0+$/, '');
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fracStr ? wholeStr + '.' + fracStr : wholeStr;
}

export function fmtRemaining(ms) {
  if (ms <= 0) return '00:00';
  const totalS = Math.ceil(ms / 1000);
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
