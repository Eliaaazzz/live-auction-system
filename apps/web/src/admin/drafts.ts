// Publish auction - draft box storage, persisted in localStorage.
// The demo is a single seller on one machine, so drafts only need to live in the browser; corruption, a
// full quota, or private mode all degrade silently, so saving a draft never throws and interrupts publishing.
export interface AuctionDraft {
  id: string;
  savedAt: number; // epoch ms
  name: string;
  category?: string;
  deposit?: number;
  intro?: string;
  cap?: number;
  step?: number;
  minStep?: number;
  duration?: number;
  autoExtend?: boolean;
  extendSec?: number;
  imageUrl?: string | null; // the uploaded cover image (it can go stale when the server cleans up, so the display side needs a fallback)
}

const KEY = 'lumen.admin.auction-drafts.v1';
const MAX = 20; // stops drafts piling up during the demo; the oldest is evicted automatically

export function listDrafts(): AuctionDraft[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (d): d is AuctionDraft =>
        !!d && typeof d === 'object' &&
        typeof (d as AuctionDraft).id === 'string' &&
        typeof (d as AuctionDraft).name === 'string' &&
        typeof (d as AuctionDraft).savedAt === 'number',
    );
  } catch {
    return [];
  }
}

function persist(drafts: AuctionDraft[]): AuctionDraft[] {
  try {
    localStorage.setItem(KEY, JSON.stringify(drafts));
  } catch {
    /* private mode or a full quota: still usable within this session (it lives in state) but may be lost on refresh */
  }
  return drafts;
}

/** Save a new draft or overwrite one with the same id, newest first. Returns the updated full list. */
export function upsertDraft(d: AuctionDraft): AuctionDraft[] {
  const rest = listDrafts().filter((x) => x.id !== d.id);
  return persist([d, ...rest].slice(0, MAX));
}

export function removeDraft(id: string): AuctionDraft[] {
  return persist(listDrafts().filter((x) => x.id !== id));
}

export function newDraftId(): string {
  return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** "just now / n minutes ago / n hours ago / a date" - the saved-at time shown in the draft list. */
export function fmtSavedAt(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
