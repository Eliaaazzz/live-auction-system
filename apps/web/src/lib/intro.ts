// lib/intro - all the pure logic for product description copy (an instant template plus the choice of an AI vision refinement).
//
// A two-stage contract (paired with the AI description button in AuctionPublish):
//   1) On click, write the category template immediately - zero wait for the seller, never blank.
//      The templates are written to a top-host standard: human, vivid, a little playful, and aimed at
//      making people want to bid; on compliance they never promise authenticity (the platform does not
//      guarantee it), never imply appreciation in value, and end with a disclaimer.
//   2) Once the real Doubao multimodal vision call (/facts/draft) returns, pickIntro decides the refined
//      copy: prefer the intro the model produced in a single call (the sidecar has already stripped
//      banned words / links / phone numbers / prices and discards the whole thing on a violation); if it
//      is missing, fall back to assembling the structured facts; if neither exists, return null and keep
//      the template.
//
// Starting at zero is a genuine hard-coded rule (AuctionPublish always sets startPriceCents=0), so
// putting it in the copy is a fact, not marketing.
export type DraftFact = { field?: string; value?: string; highRisk?: boolean };

export const INTRO_TEMPLATES: Record<string, (name: string) => string> = {
  Watches: (n) => `${n}: the dial catches the light, the movement keeps steady time, and it carries real presence on the wrist. Starts at zero, the window for a good find is open, and anyone who knows watches will not sleep on it. Condition and authenticity are per the seller's statement; the platform does not endorse any appraisal. Please bid responsibly.`,
  Bags: (n) => `${n}: bright hardware, a structured silhouette, and one bag that covers both the commute and the evening. Starts at zero, wherever the bidding lands is where it lands, and hesitation costs. Condition details are per the item itself and the seller's statement; the platform does not guarantee authenticity. Please bid responsibly.`,
  Apparel: (n) => `${n}: a sculpted cut that gives you presence the moment you put it on, with workmanship that holds up close, and it is the one piece your wardrobe is missing. Starts at zero, so if it catches your eye do not hesitate. Size and condition are per the seller's description; the platform does not guarantee authenticity. Please bid responsibly.`,
  Shoes: (n) => `${n}: a clean shape, light on the foot, and it photographs well with anything - front row of the shoe rack. Starts at zero, and if the size fits, it is meant to be; the highest bid wins. Condition and sizing are per the item itself and the seller's statement; the platform does not guarantee authenticity. Please bid responsibly.`,
};

export const defaultIntro = (n: string) =>
  `${n}: the details are all in the photos, the condition holds up, and if it catches your eye it is yours. Starts at zero, the highest bid wins, and hesitation loses. Material and flaws are per the item itself and the seller's statement; the platform does not guarantee authenticity. Please bid responsibly.`;

// The AI intro never writes the disclaimer (the sidecar prompt forbids it) - the disclaimer tail is
// appended deterministically here, so compliance does not depend on the model behaving.
export const INTRO_TAIL = ' Condition and flaws are per the item itself and the seller\'s statement; the platform does not guarantee authenticity. Please bid responsibly.';

// composeIntro assembles the facts returned by the real Doubao vision call into an AI-vision
// description, filtering out highRisk / authenticity / unverified (the platform does not guarantee
// authenticity) and returning null when no usable fact remains.
// It now serves only as the structured fallback when the intro is missing or was stripped.
const FIELD_LABEL: Record<string, string> = { category: 'category', brand: 'brand', model: 'model', condition: 'condition', defects: 'flaws', material: 'material', color: 'colour' };
export function composeIntro(name: string, facts?: DraftFact[]): string | null {
  // estimateCNY is the vision-based estimate that helps the seller configure the auction (#261-12b) and
  // must never appear in buyer-facing copy (the price moves during the auction, so a fixed one would
  // mislead - consistent with the sidecar intro's no-price rule).
  const good = (facts ?? []).filter(
    (f) => f?.value && !f.highRisk && f.field !== 'authenticity' && f.field !== 'estimateCNY' && String(f.value).trim().toLowerCase() !== 'unverified',
  );
  if (!good.length) return null;
  const parts = good.map((f) => `${FIELD_LABEL[f.field ?? ''] ?? f.field}：${f.value}`);
  return `${name} (AI vision): ${parts.join(', ')}.${INTRO_TAIL}`;
}

// pickEstimate: read the AI estimate (estimateCNY, in yuan) out of the vision facts. Returning null
// means the model gave nothing usable, and the caller falls back to the cap-price heuristic
// (#261-12b, the vision-driven suggested increment).
export function pickEstimate(resp?: { facts?: DraftFact[] }): number | null {
  const f = (resp?.facts ?? []).find((x) => x?.field === 'estimateCNY');
  if (!f?.value) return null;
  const n = parseInt(String(f.value).replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// pickIntro: the AI vision response -> refined copy. The model's own intro (already through the
// sidecar's compliance cleanup) wins; if it does not already carry the disclaimer, INTRO_TAIL is
// appended; an empty intro (mock / stripped / an older sidecar) falls back to composeIntro; and the
// result is finally trimmed to the form's 200-character limit.
export function pickIntro(name: string, resp?: { intro?: string; facts?: DraftFact[] }): string | null {
  const ai = String(resp?.intro ?? '').trim();
  if (ai) {
    const text = ai.includes('does not guarantee authenticity') ? ai : ai + INTRO_TAIL;
    return text.slice(0, 200);
  }
  const fallback = composeIntro(name, resp?.facts);
  return fallback ? fallback.slice(0, 200) : null;
}
