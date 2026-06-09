// Money + number formatting.
// Follow-up task: 数字展示规范 — 中文语境下的分隔/简写规则 + 出价榜溢出处理。

/** 标准千分位：9000 -> "9,000"（价格主显示用） */
export function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('en-US');
}

/** 带 ¥ 前缀 */
export function fmtYuan(n: number): string {
  return '¥' + fmtMoney(n);
}

/**
 * 中文简写：用于排行榜/溢出场景，避免超长数字撑破布局。
 *  9,000      -> "9,000"
 *  12,800     -> "1.28万"
 *  5,000,000  -> "500万"
 *  120,000,000-> "1.2亿"
 */
export function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const v = Math.round(n);
  if (v < 10000) return v.toLocaleString('en-US');
  if (v < 1_0000_0000) {
    const wan = v / 10000;
    return trim(wan) + '万';
  }
  const yi = v / 1_0000_0000;
  return trim(yi) + '亿';
}

export function fmtCompactYuan(n: number): string {
  return '¥' + fmtCompact(n);
}

function trim(x: number): string {
  // 最多两位小数，去掉末尾 0
  return parseFloat(x.toFixed(2)).toString();
}

/** 毫秒 -> mm:ss（用于一般倒计时） */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${pad(m)}:${pad(sec)}`;
}

/** 毫秒 -> { m, s, cs } 用于「最后冲刺」高精度展示（秒 + 厘秒） */
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

/** 浏览人数：12800 -> "1.3万" */
export function fmtCount(n: number): string {
  if (n < 10000) return n.toLocaleString('en-US');
  return trim(n / 10000) + '万';
}
