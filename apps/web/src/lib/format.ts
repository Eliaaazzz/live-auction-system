// Money + number formatting.
// Follow-up task: number display conventions - separator and compact rules, plus overflow handling on the bid board.

/** Standard thousands separator: 9000 -> "9,000" (used for the main price display) */
export function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('en-US');
}

/** With the ¥ prefix */
export function fmtYuan(n: number): string {
  return '¥' + fmtMoney(n);
}

/**
 * Compact form: used on the leaderboard and in overflow cases so long numbers do not break the layout.
 *  9,000      -> "9,000"
 *  12,800     -> "12.8K"
 *  5,000,000  -> "5M"
 *  120,000,000-> "120M"
 */
export function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const v = Math.round(n);
  if (v < 10000) return v.toLocaleString('en-US');
  if (v < 1_0000_0000) {
    const wan = v / 10000;
    return trim(wan) + 'K';
  }
  const yi = v / 1_0000_0000;
  return trim(yi) + 'M';
}

export function fmtCompactYuan(n: number): string {
  return '¥' + fmtCompact(n);
}

function trim(x: number): string {
  // at most two decimals, trailing zeros removed
  return parseFloat(x.toFixed(2)).toString();
}

/** Milliseconds -> mm:ss (for the general countdown) */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${pad(m)}:${pad(sec)}`;
}

/** Milliseconds -> { m, s, cs } for the high-precision final-sprint display (seconds plus centiseconds) */
export function splitClock(ms: number): { m: string; s: string; cs: string } {
  const clamped = Math.max(0, ms);
  const totalSec = Math.floor(clamped / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const cs = Math.floor((clamped % 1000) / 10); // 0-99
  return { m: pad(m), s: pad(s), cs: pad(cs) };
}

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** Viewer count: 12800 -> "12.8K" */
export function fmtCount(n: number): string {
  if (n < 10000) return n.toLocaleString('en-US');
  return trim(n / 1000) + 'K';
}
