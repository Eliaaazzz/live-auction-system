// 竞拍发布 · 草稿箱存储 —— localStorage 持久化。
// demo 是单卖家本机操作，草稿只需活在浏览器里；存坏/超额/隐私模式一律静默降级，
// 绝不让「存草稿」抛错打断发布流程。
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
  imageUrl?: string | null; // 已上传主图（可能随服务端清理失效，展示侧需兜底）
}

const KEY = 'lumen.admin.auction-drafts.v1';
const MAX = 20; // 防止 demo 期间无限堆积；最旧的自动挤出

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
    /* 隐私模式 / 配额满：本次会话内仍可用（state 里有），刷新后可能丢失 */
  }
  return drafts;
}

/** 新存或覆盖同 id 草稿，最新的排最前。返回更新后的全量列表。 */
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

/** 「刚刚 / n 分钟前 / n 小时前 / m月d日」——草稿列表里的保存时间。 */
export function fmtSavedAt(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
