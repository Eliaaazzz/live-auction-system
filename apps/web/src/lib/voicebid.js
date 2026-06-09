// src/lib/voicebid.js
//
// 语音出价 — parse a spoken Chinese bid phrase into a target bid (string-cents).
//
// This is the brain of the voice-bid feature: a transcript like 「加价五千」/
// 「出价十三万八」/「加三档」 → an absolute target amount the buyer confirms,
// which is then submitted through the SAME onBid lane as a chip tap. AI is
// NON-AUTHORITATIVE (V9 P3): this only proposes an amount; the backend Lua
// adjudicator still validates step grid / state / winner. So a mis-hear can at
// worst be rejected — it can never corrupt the auction.
//
// Money is string-cents via BigInt throughout (blueprint P1 — never float).
// Speech is in YUAN; we convert to cents (×100).

// ── Chinese numerals → integer (yuan) ──────────────────────────────
const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_SMALL_UNIT = { 十: 10, 百: 100, 千: 1000 };
const CN_BIG_UNIT = { 万: 10000, 亿: 100000000 };

// parseChineseNumber parses a CN-numeral string (e.g. 十三万八千 → 138000,
// 两千五 → 2500, 一万二 → 12000). Returns null if it isn't a CN number.
// Handles the colloquial trailing-digit form (两千五 = 2500, not 2005) by
// treating a dangling digit as the next-smaller unit.
function parseChineseNumber(s) {
  if (!s) return null;
  let total = 0;     // accumulated value
  let section = 0;   // value within the current 万/亿 section
  let current = 0;   // pending digit
  let lastUnit = 0;  // last small unit applied (for the trailing-digit form)
  let sawAny = false;
  for (const ch of s) {
    if (ch in CN_DIGIT) {
      current = CN_DIGIT[ch];
      sawAny = true;
    } else if (ch in CN_SMALL_UNIT) {
      const unit = CN_SMALL_UNIT[ch];
      // 十三 → 十 with no preceding digit means 1×10
      section += (current === 0 ? 1 : current) * unit;
      current = 0;
      lastUnit = unit;
      sawAny = true;
    } else if (ch in CN_BIG_UNIT) {
      const unit = CN_BIG_UNIT[ch];
      section += current;
      total += (section === 0 ? 1 : section) * unit;
      section = 0;
      current = 0;
      // keep the big unit as lastUnit so a colloquial trailing digit lands one
      // order below it (十三万八 → 八 = 8×千 = 138000, 一万二 → 12000).
      lastUnit = unit;
      sawAny = true;
    } else {
      return null; // non-CN char → not a pure CN number
    }
  }
  if (current !== 0) {
    // trailing digit: implied unit is one order below the last unit applied
    // (两千五 → 5×百, 十三万八 → 8×千, 十五 → 5×1).
    const implied = lastUnit >= 10 ? current * (lastUnit / 10) : current;
    if (lastUnit >= 10000) {
      total += implied; // trailing tail after 万/亿 accumulates into total
    } else {
      section += implied;
    }
  }
  total += section;
  return sawAny ? total : null;
}

// parseAmountYuan extracts a yuan amount from a token, accepting:
//   - pure Chinese numerals: 五千 / 十三万八
//   - arabic: 5000 / 138000
//   - arabic + CN big unit: 13万 / 1.5万 / 5千
// Returns null when no amount is present.
function parseAmountYuan(text) {
  if (!text) return null;
  // arabic (optional decimal) followed by an optional 万/千/百 multiplier
  const m = text.match(/(\d+(?:\.\d+)?)\s*(万|千|百|亿)?/);
  if (m) {
    let v = parseFloat(m[1]);
    if (m[2] === '万') v *= 10000;
    else if (m[2] === '千') v *= 1000;
    else if (m[2] === '百') v *= 100;
    else if (m[2] === '亿') v *= 100000000;
    return Math.round(v);
  }
  // pure CN numerals
  const cnMatch = text.match(/[零〇一二两三四五六七八九十百千万亿]+/);
  if (cnMatch) {
    const n = parseChineseNumber(cnMatch[0]);
    if (n != null && n > 0) return n;
  }
  return null;
}

function toBig(s) {
  try { return BigInt(s); } catch { return 0n; }
}

// extractStepCount finds an "N 档/个档/档" multiplier (加三档 → 3, 加档 → 1).
function extractStepCount(t) {
  if (!/[档|个档]/.test(t) && !t.includes('档')) return null;
  const m = t.match(/([零〇一二两三四五六七八九十百千万\d]+)\s*[个]?\s*档/);
  if (m) {
    const n = parseAmountYuan(m[1]);
    if (n != null && n > 0) return n;
  }
  return 1; // 加档 / 档 with no number → one step
}

const RELATIVE_KW = ['加价', '再加', '加', '涨', '提', '往上'];
const ABSOLUTE_KW = ['出价', '报价', '直接到', '到', '喊到', '喊'];

/**
 * parseBidUtterance(transcript, { currentCents, stepCents }) →
 *   { ok, amountCents, kind, heard, reason }
 *
 * kind ∈ 'step' | 'relative' | 'absolute'. amountCents is the ABSOLUTE target
 * (string-cents) to submit. ok=false carries a human reason for the UI.
 */
export function parseBidUtterance(transcript, { currentCents = '0', stepCents = '0' } = {}) {
  const heard = String(transcript || '').trim();
  if (!heard) return { ok: false, reason: '没听清，请再说一次', heard };

  const t = heard.replace(/\s+/g, '');
  const cur = toBig(currentCents);
  const step = toBig(stepCents);

  // 1) step form: 加三档 / 加档
  const stepCount = extractStepCount(t);
  if (stepCount != null) {
    if (step <= 0n) return { ok: false, reason: '本场未设加价阶梯', heard };
    const target = cur + BigInt(stepCount) * step;
    return finalize(target, cur, 'step', heard);
  }

  const yuan = parseAmountYuan(t);
  const isRelative = RELATIVE_KW.some((k) => t.includes(k));
  const isAbsolute = ABSOLUTE_KW.some((k) => t.includes(k));

  // 2) relative or absolute with no number → one step up (加价 / 出价 alone)
  if (yuan == null) {
    if (isRelative || isAbsolute) {
      if (step <= 0n) return { ok: false, reason: '没听清金额', heard };
      return finalize(cur + step, cur, 'relative', heard);
    }
    return { ok: false, reason: `没听懂「${heard}」，试试「加价五千」或「出价十三万」`, heard };
  }

  const cents = BigInt(Math.round(yuan)) * 100n;

  // 3) explicit relative: 加价五千 → current + 5000
  if (isRelative && !isAbsolute) {
    return finalize(cur + cents, cur, 'relative', heard);
  }
  // 4) explicit absolute: 出价十三万 → 130000
  if (isAbsolute && !isRelative) {
    return finalize(cents, cur, 'absolute', heard);
  }
  // 5) bare number: treat as absolute if it clears the current price, else as a
  // relative raise (人们说「五千」往往指加五千).
  if (cents > cur) return finalize(cents, cur, 'absolute', heard);
  return finalize(cur + cents, cur, 'relative', heard);
}

function finalize(target, cur, kind, heard) {
  if (target <= cur) {
    return { ok: false, reason: '金额不高于当前价，未提交', heard, kind };
  }
  return { ok: true, amountCents: target.toString(), kind, heard };
}

// exported for tests
export { parseChineseNumber, parseAmountYuan };
