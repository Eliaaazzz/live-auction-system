export type AuctionStatus = 'upcoming' | 'live' | 'ending' | 'sold' | 'unsold';

export interface User {
  id: string;
  name: string;
  avatar: string;
  color: string;
}

export interface Bid {
  id: string;
  userId: string;
  userName: string;
  avatar: string;
  color?: string;
  amount: number;
  ts: number;
  self?: boolean;
}

export interface RankRow {
  userId: string;
  userName: string;
  avatar: string;
  amount: number;
  self?: boolean;
}

export interface Lot {
  id: string;
  index: number;
  title: string;
  subtitle: string;
  image: string;
  live?: string; // optional live video stream URL (HLS .m3u8 / mp4/webm); falls back to `image`
  tone: string;
  tone2: string;
  startPrice: number;
  increment: number;
  minIncrement: number;
  capPrice: number;
  deposit: number;
  durationSec: number;
  extendSec: number;
  category: string;
  estimate: string;
}

export interface Room {
  id: string;
  anchorName: string;
  anchorAvatar: string;
  fans: string;
  viewers: number;
  tagline: string;
  lot: Lot;
}

/** One ROOM_SOCIAL frame (#261-7/8/10) - danmaku/gift/like from ANY client in the room. */
export interface SocialItem {
  kind: 'comment' | 'gift' | 'like' | 'stats';
  userId?: string;
  displayName?: string;
  text?: string;
  giftId?: string;
  giftName?: string;
  giftEmoji?: string;
  likeDelta?: number;
  likeCount?: number;
  viewerCount?: number;
  /** true when the engine matched userId to this client's session (rendered as "Me" locally). */
  self?: boolean;
}

export type EngineEvent =
  | { kind: 'start' }
  | { kind: 'leading'; amount: number }
  | { kind: 'outbid'; by: string; amount: number }
  | { kind: 'extend'; addSec: number }
  | { kind: 'cap' }
  | { kind: 'settle'; won: boolean; price: number }
  | { kind: 'social'; social: SocialItem };

export interface AuctionState {
  status: AuctionStatus;
  startsInMs: number;
  remainingMs: number;
  totalMs: number;
  currentPrice: number;
  leader: Bid | null;
  bids: Bid[];
  ranking: RankRow[];
  participants: number;
  /** #266 review honesty boundary: how many of the participants are simulated crowd (>0 means the UI must show the simulated-crowd badge). */
  simViewers: number;
  /** #261-10 server-authoritative room likes (synced across every client). */
  likes: number;
  myMaxBid: number | null;
  myRank: number | null;
  extendedFlash: number;
  lastEvent: EngineEvent | null;
  bidCount: number;
  /** Last server bid rejection (BID_REJECTED), localized — drives the buyer reject toast. */
  lastReject?: { code: string; text: string; at: number } | null;
}
