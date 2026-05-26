// src/lib/format.js
// Money is string-cents (per blueprint §4 P1). Never parse to Number.

export function formatCentsCNY(cents) {
  const s = String(cents);
  const neg = s.startsWith('-');
  const abs = neg ? s.slice(1) : s;
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

export function fmtRemaining(ms) {
  if (ms <= 0) return '00:00';
  const totalS = Math.ceil(ms / 1000);
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
