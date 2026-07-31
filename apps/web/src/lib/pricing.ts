// Dynamic bid increment for the buyer H5.
//
// The backend Lua adjudicator enforces a hard step floor (lot.increment /
// stepCents). This module only ever RAISES the suggested client-side step above
// that floor based on the item's value tier and live "heat" (online viewers),
// so a bid built from computeIncrement() is never rejected for being below the
// minimum. Callers must still clamp the suggested step to >= lot.increment.

/** Round a raw step to a "nice" human-friendly number (tiered by magnitude). */
export function roundNice(n: number): number {
  const v = Math.max(0, n || 0);
  let r: number;
  if (v < 100) r = Math.round(v / 10) * 10;
  else if (v < 1000) r = Math.round(v / 50) * 50;
  else if (v < 10000) r = Math.round(v / 100) * 100;
  else r = Math.round(v / 500) * 500;
  return Math.max(10, r);
}

/**
 * Compute a dynamic increment in YUAN.
 *
 * @param valueYuan    current price or cap price of the lot (drives the value tier)
 * @param online       live viewer / participant count (drives the heat multiplier)
 * @param baseStepYuan backend step floor in yuan; the result is never below it
 */
export function computeIncrement(valueYuan: number, online: number, baseStepYuan = 0): number {
  const v = Math.max(0, valueYuan || 0);
  let base =
    v >= 1000000 ? 5000 :
    v >= 300000 ? 2000 :
    v >= 100000 ? 1000 :
    v >= 30000 ? 500 :
    v >= 10000 ? 200 :
    v >= 3000 ? 100 :
    v >= 1000 ? 50 :
    20;
  base = Math.max(base, baseStepYuan || 0);
  const heat = 1 + Math.min(Math.max(online, 0), 10000) / 4000;
  return roundNice(base * heat);
}

/** ≈ percentage of the lot value used by recommendIncrement (a ~40-bid climb). */
export const RECOMMEND_INCREMENT_PCT = 0.025;

/**
 * Recommend a FIXED bid increment for the SELLER to set BEFORE the
 * auction, from the lot's cap / value. This is NOT computeIncrement: that one is
 * the live, heat-driven dynamic step used DURING bidding (and stays unchanged —
 * it has 4 live callers). This is a one-shot, value-PROPORTIONAL suggestion, so a
 * high-value lot finally gets a meaningful step instead of a cheap flat tier:
 *
 *   a ¥50,000 Rolex -> ¥1,300   (the old tier gave ¥250 - a luxury watch climbing in
 *                              ¥250 steps took ~200 bids and felt insulting)
 *   a ¥12,000 jade bangle -> ¥300
 *   a ¥200 food item -> ¥10
 *
 * ≈2.5% of the lot value, snapped to a nice number, floored by the value tier so
 * a cheap lot still gets a usable step. No fake "heat": the seller's fixed
 * increment is set pre-auction, when there are no live viewers to heat it.
 */
export function recommendIncrement(valueYuan: number): number {
  const v = Math.max(0, valueYuan || 0);
  if (v <= 0) return 50;
  const tierFloor =
    v >= 100000 ? 1000 :
    v >= 30000 ? 500 :
    v >= 10000 ? 200 :
    v >= 3000 ? 100 :
    v >= 1000 ? 50 :
    10;
  return roundNice(Math.max(v * RECOMMEND_INCREMENT_PCT, tierFloor));
}
