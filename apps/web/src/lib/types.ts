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

export type EngineEvent =
  | { kind: 'start' }
  | { kind: 'leading'; amount: number }
  | { kind: 'outbid'; by: string; amount: number }
  | { kind: 'extend'; addSec: number }
  | { kind: 'cap' }
  | { kind: 'settle'; won: boolean; price: number };

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
  myMaxBid: number | null;
  myRank: number | null;
  extendedFlash: number;
  lastEvent: EngineEvent | null;
  bidCount: number;
}
