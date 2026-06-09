// mapBackend — translate backend REST shapes (string-CENTS) into the prototype's
// Room / Lot view models (YUAN numbers). Keeps the antd/抖音 UI unchanged while
// the data underneath is real.

import type { Room, Lot } from './types';
import { avatar, PROD } from './assets';

export interface BackendAuction {
  auctionId: string;
  productName?: string;
  imageUrl?: string;
  livePlayUrl?: string;
  status?: string;
  currentPriceCents?: string;
  startPriceCents?: string;
  incrementCents?: string;
  capPriceCents?: string;
  endAtMs?: number;
  mode?: string;
  bidCount?: number;
}

/**
 * Load-test / placeholder lots that must never reach a real buyer or the admin
 * product list. Matches: "load test" (optional space, any case), names that
 * start with "final" and end with "lot", and empty/whitespace names.
 */
export function isJunk(name?: string): boolean {
  const n = (name || '').trim();
  if (n === '') return true;
  const lower = n.toLowerCase();
  if (/load\s*test/.test(lower)) return true;
  if (lower.startsWith('final') && lower.endsWith('lot')) return true;
  return false;
}

const yuan = (cents?: string | number | null): number => {
  if (cents == null || cents === '') return 0;
  try { return Math.round(Number(BigInt(String(cents))) / 100); } catch { return Math.round(Number(cents) / 100) || 0; }
};

function hashNum(s: string): number {
  let h = 0;
  for (let i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return (h % 70) + 1;
}

const MODE_LABEL: Record<string, string> = {
  ENGLISH: '英式拍卖', SEALED: '暗拍', VICKREY: '二价拍', HYBRID_REVEAL: '混合明暗', ALL_PAY: '全付拍', PREQUALIFY: '资格预审',
};

/** Map one backend auction → a prototype Lot (YUAN). Real numbers refine over WS. */
export function auctionToLot(a: BackendAuction): Lot {
  const step = yuan(a.incrementCents) || 50;
  return {
    id: a.auctionId,
    index: 1,
    title: a.productName || '直播拍品',
    subtitle: '单品竞拍 · 0 元起拍 · 服务端裁决',
    image: a.imageUrl || PROD.watch,
    // No fake fallback loop: the real stream URL arrives later via the per-room
    // snapshot (engine livePlayUrl). With no real stream, VideoBackground shows
    // the product still — never an off-brand placeholder video.
    live: a.livePlayUrl || undefined,
    tone: '#1b2a4a',
    tone2: '#c9a961',
    startPrice: yuan(a.startPriceCents),
    increment: step,
    minIncrement: step,
    capPrice: yuan(a.capPriceCents),
    deposit: 0,
    durationSec: 60,
    extendSec: 30,
    category: MODE_LABEL[a.mode || 'ENGLISH'] || '英式拍卖',
    estimate: '',
  };
}

/** Map a backend auction → a prototype Room (anchor/header chrome derived). */
export function auctionToRoom(a: BackendAuction): Room {
  const name = (a.productName || '直播').slice(0, 8);
  return {
    id: a.auctionId,
    anchorName: `${name} · 拍卖间`,
    anchorAvatar: avatar(hashNum(a.auctionId)),
    fans: '—',
    viewers: 0,
    tagline: a.status === 'LIVE' ? '正在直播竞拍' : '即将开拍',
    lot: auctionToLot(a),
  };
}

/** LIVE first, then SCHEDULED; terminal/draft auctions are hidden from the room rail. */
export function auctionsToRooms(auctions: BackendAuction[]): Room[] {
  const rank = (s?: string) => (s === 'LIVE' ? 0 : s === 'SCHEDULED' ? 1 : 2);
  return (auctions || [])
    .filter((a) => a.auctionId && (a.status === 'LIVE' || a.status === 'SCHEDULED'))
    .filter((a) => !isJunk(a.productName))
    .sort((x, y) => rank(x.status) - rank(y.status))
    .map(auctionToRoom);
}
