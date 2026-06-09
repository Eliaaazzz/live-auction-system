// Dynamic bid increment ("加价幅度") for the buyer H5.
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
