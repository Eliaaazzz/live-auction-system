// src/lib/bidrules.js
//
// Client-side bid-rule HELPERS. These are advisory only — the backend
// (place_bid.lua / model.Rules) remains the sole authority on minIncrement,
// cap, reserve, and acceptance (V9: AI/UI never adjudicate bids). The admin
// publish form uses suggestStepCents to propose a 加价阶梯 that scales with
// the start price instead of a fixed default; the seller can still type any
// value, and the backend validates whatever is submitted.
//
// Money is string-cents (blueprint §4 P1) — BigInt only, never parseFloat.

// Round n UP to the nearest "nice" auction increment: 1 / 2 / 5 × 10^k.
// Mirrors how auction houses quote increments (¥100 / ¥200 / ¥500 / ¥1,000…).
export function niceRoundCents(n) {
  let v;
  try { v = BigInt(n); } catch { return 0n; }
  if (v <= 1n) return 1n;
  let pow = 1n;
  while (pow < v) {
    if (pow * 2n >= v) return pow * 2n;
    if (pow * 5n >= v) return pow * 5n;
    if (pow * 10n >= v) return pow * 10n;
    pow *= 10n;
  }
  return pow;
}

// Suggest a 加价阶梯 (min increment, in cents) from the start price:
// ~1% of start, snapped to a nice 1/2/5 increment, floored at ¥1 (100 cents).
// Returns a string-cents value ('0' for a non-positive / unparsable start).
export function suggestStepCents(startCents) {
  let start;
  try { start = BigInt(String(startCents)); } catch { return '0'; }
  if (start <= 0n) return '0';
  const onePct = start / 100n;
  const floor = 100n; // ¥1 — never suggest a sub-¥1 increment
  return niceRoundCents(onePct < floor ? floor : onePct).toString();
}
