// src/lib/bidding.js
// Suggested minimum-increment ladder (meeting follow-up: 最低加价逻辑 —
// 后台可根据起拍价动态调整最低加价).
//
// The ladder follows the cross-platform research synthesis (eBay's published
// bid-increment table + 阿里拍卖 convention): the minimum increment scales
// with price, landing around 1–5% of the current/starting price — dense at
// the low end so cheap lots stay lively, sparse at the high end so a
// million-yuan lot doesn't crawl ¥50 at a time.
//
// Backend rules stay authoritative (model.Rules incrementCents); this module
// only powers the seller-side suggestion in the publish form. Money is
// string-cents, BigInt-compared, never Number (§4 P1).

// [upper-bound-exclusive cents, suggested step cents]
const LADDER = [
  [10_000n,      500n],       // < ¥100        → ¥5
  [50_000n,      1_000n],     // < ¥500        → ¥10
  [100_000n,     2_000n],     // < ¥1,000      → ¥20
  [500_000n,     5_000n],     // < ¥5,000      → ¥50
  [1_000_000n,   10_000n],    // < ¥10,000     → ¥100
  [5_000_000n,   50_000n],    // < ¥50,000     → ¥500
  [10_000_000n,  100_000n],   // < ¥100,000    → ¥1,000
  [50_000_000n,  200_000n],   // < ¥500,000    → ¥2,000
  [100_000_000n, 500_000n],   // < ¥1,000,000  → ¥5,000
];
const TOP_STEP = 1_000_000n;  // ≥ ¥1,000,000  → ¥10,000

export function suggestStepCents(startCents) {
  let n;
  try { n = BigInt(startCents); } catch { return null; }
  if (n <= 0n) return null;
  for (const [limit, step] of LADDER) {
    if (n < limit) return step.toString();
  }
  return TOP_STEP.toString();
}
