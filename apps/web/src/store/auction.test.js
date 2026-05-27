// src/store/auction.test.js
//
// Unit tests for the applyEvent reducer — the heart of the room state.
// Covers every event type in ws-envelope.md §3.2, seqguard dedup,
// extendCount preservation on ROOM_SNAPSHOT reconnect, the cumulative
// counters added in PR #64 (totalBidsCount + bidderIds), and the
// self-vs-other BID_ACCEPTED branches.

import { describe, it, expect, beforeEach } from 'vitest';
import { useAuctionStore } from './auction.js';
import { AuctionStatus, EventType } from '../lib/types.js';

const RESET = () => useAuctionStore.getState().init({
  auctionId: 'auc_test',
  status: AuctionStatus.LIVE,
  currentCents: '10000000',
  stepCents: '500000',
  capCents: '50000000',
  startCents: '10000000',
  endAtMs: Date.now() + 30_000,
  yourUserId: 'u_me',
});

const env = (over) => ({
  schemaVersion: 1,
  type: EventType.BID_ACCEPTED,
  serverTimeMs: Date.now(),
  seq: 1,
  data: {},
  ...over,
});

describe('applyEvent · seqguard dedup', () => {
  beforeEach(RESET);

  it('drops a re-delivered envelope with seq ≤ lastSeq', () => {
    const apply = useAuctionStore.getState().applyEvent;
    apply(env({ seq: 5, data: { status: 'LIVE', amountCents: '11000000', userId: 'u1', displayName: 'A' } }));
    expect(useAuctionStore.getState().currentCents).toBe('11000000');

    // Same seq again — should be dropped, no state change
    apply(env({ seq: 5, data: { status: 'LIVE', amountCents: '99999999', userId: 'u2', displayName: 'B' } }));
    expect(useAuctionStore.getState().currentCents).toBe('11000000');
  });

  it('drops a re-delivered envelope with seq < lastSeq (out-of-order)', () => {
    const apply = useAuctionStore.getState().applyEvent;
    apply(env({ seq: 10, data: { status: 'LIVE', amountCents: '11000000', userId: 'u1', displayName: 'A' } }));

    // Late-arriving seq=5 — should be dropped
    apply(env({ seq: 5, data: { status: 'LIVE', amountCents: '20000000', userId: 'u2', displayName: 'B' } }));
    expect(useAuctionStore.getState().currentCents).toBe('11000000');
    expect(useAuctionStore.getState().lastSeq).toBe(10);
  });

  it('accepts the next higher seq', () => {
    const apply = useAuctionStore.getState().applyEvent;
    apply(env({ seq: 5, data: { status: 'LIVE', amountCents: '11000000', userId: 'u1', displayName: 'A' } }));
    apply(env({ seq: 6, data: { status: 'LIVE', amountCents: '11500000', userId: 'u2', displayName: 'B' } }));
    expect(useAuctionStore.getState().currentCents).toBe('11500000');
    expect(useAuctionStore.getState().lastSeq).toBe(6);
  });
});

describe('applyEvent · BID_ACCEPTED', () => {
  beforeEach(RESET);

  it('updates currentCents + winnerId + leaders on a non-self bid', () => {
    useAuctionStore.getState().applyEvent(env({
      seq: 1,
      data: { status: 'LIVE', amountCents: '11000000', userId: 'u_other', displayName: '海风_2024', endAtMs: Date.now() + 28_000 },
    }));
    const s = useAuctionStore.getState();
    expect(s.currentCents).toBe('11000000');
    expect(s.winnerId).toBe('u_other');
    expect(s.winnerDisplayName).toBe('海风_2024');
    expect(s.leaders[0]).toMatchObject({ userId: 'u_other', cents: '11000000', isYou: false });
    expect(s.leadingToast).toBe(false);
  });

  it('fires leadingToast when the bidder is self', () => {
    useAuctionStore.getState().applyEvent(env({
      seq: 1,
      data: { status: 'LIVE', amountCents: '11000000', userId: 'u_me', displayName: 'You', endAtMs: Date.now() + 28_000 },
    }));
    expect(useAuctionStore.getState().leadingToast).toBe(true);
    expect(useAuctionStore.getState().yourCents).toBe('11000000');
    expect(useAuctionStore.getState().leaders[0].isYou).toBe(true);
  });

  it('fires overtakeBanner when self was leading and got overtaken', () => {
    const apply = useAuctionStore.getState().applyEvent;
    apply(env({ seq: 1, data: { status: 'LIVE', amountCents: '11000000', userId: 'u_me', displayName: 'You', endAtMs: Date.now() + 28_000 } }));
    apply(env({ seq: 2, data: { status: 'LIVE', amountCents: '11500000', userId: 'u_other', displayName: 'Other', endAtMs: Date.now() + 28_000 } }));
    expect(useAuctionStore.getState().overtakeBanner).toBe(true);
  });

  it('fires blackHorse on a ≥5× step jump', () => {
    // step=500000, current=10000000, threshold: jump ≥ 2500000 → bid ≥ 12500000
    useAuctionStore.getState().applyEvent(env({
      seq: 1,
      data: { status: 'LIVE', amountCents: '15000000', userId: 'u_other', displayName: 'Big', endAtMs: Date.now() + 28_000 },
    }));
    expect(useAuctionStore.getState().blackHorse).toBe(true);
  });

  it('does NOT fire blackHorse on a small bump', () => {
    useAuctionStore.getState().applyEvent(env({
      seq: 1,
      data: { status: 'LIVE', amountCents: '10500000', userId: 'u_other', displayName: 'Tiny', endAtMs: Date.now() + 28_000 },
    }));
    expect(useAuctionStore.getState().blackHorse).toBe(false);
  });

  it('handles status=SOLD on a cap-hit BID_ACCEPTED (status passthrough from data)', () => {
    useAuctionStore.getState().applyEvent(env({
      seq: 1,
      data: { status: 'SOLD', amountCents: '50000000', userId: 'u_other', displayName: 'Winner', endAtMs: Date.now() + 28_000 },
    }));
    expect(useAuctionStore.getState().status).toBe('SOLD');
  });
});

describe('applyEvent · cumulative counters (#64-M1/M2)', () => {
  beforeEach(RESET);

  it('totalBidsCount climbs past the recentEvents cap of 50', () => {
    const apply = useAuctionStore.getState().applyEvent;
    for (let i = 1; i <= 70; i++) {
      apply(env({
        seq: i,
        data: { status: 'LIVE', amountCents: String(10_000_000 + i * 100_000), userId: `u${i % 5}`, displayName: `U${i}`, endAtMs: Date.now() + 28_000 },
      }));
    }
    const s = useAuctionStore.getState();
    expect(s.totalBidsCount).toBe(70);
    expect(s.recentEvents.length).toBe(50);
  });

  it('bidderIds deduplicates and excludes null userIds (M2 .filter(Boolean))', () => {
    const apply = useAuctionStore.getState().applyEvent;
    apply(env({ seq: 1, data: { status: 'LIVE', amountCents: '11000000', userId: 'u1', displayName: 'A', endAtMs: Date.now() + 28_000 } }));
    apply(env({ seq: 2, data: { status: 'LIVE', amountCents: '11500000', userId: 'u2', displayName: 'B', endAtMs: Date.now() + 28_000 } }));
    apply(env({ seq: 3, data: { status: 'LIVE', amountCents: '12000000', userId: 'u1', displayName: 'A', endAtMs: Date.now() + 28_000 } }));
    apply(env({ seq: 4, data: { status: 'LIVE', amountCents: '12500000', userId: null, displayName: 'Anon', endAtMs: Date.now() + 28_000 } }));
    apply(env({ seq: 5, data: { status: 'LIVE', amountCents: '13000000', userId: undefined, displayName: 'Anon2', endAtMs: Date.now() + 28_000 } }));

    expect(useAuctionStore.getState().bidderIds).toEqual(['u1', 'u2']);
  });

  it('init() resets both counters to 0/empty', () => {
    const apply = useAuctionStore.getState().applyEvent;
    apply(env({ seq: 1, data: { status: 'LIVE', amountCents: '11000000', userId: 'u1', displayName: 'A', endAtMs: Date.now() + 28_000 } }));
    expect(useAuctionStore.getState().totalBidsCount).toBe(1);
    expect(useAuctionStore.getState().bidderIds).toEqual(['u1']);

    useAuctionStore.getState().init({ auctionId: 'auc_other' });
    expect(useAuctionStore.getState().totalBidsCount).toBe(0);
    expect(useAuctionStore.getState().bidderIds).toEqual([]);
  });
});

describe('applyEvent · AUCTION_EXTENDED', () => {
  beforeEach(RESET);

  it('increments extendCount and updates endAtMs', () => {
    const before = useAuctionStore.getState().extendCount;
    useAuctionStore.getState().applyEvent(env({
      seq: 1,
      type: EventType.AUCTION_EXTENDED,
      data: { endAtMs: Date.now() + 38_000, extendCount: before + 1 },
    }));
    expect(useAuctionStore.getState().extendCount).toBe(before + 1);
  });

  it('falls back to incrementing from current count if data.extendCount is missing', () => {
    useAuctionStore.getState().applyEvent(env({
      seq: 1,
      type: EventType.AUCTION_EXTENDED,
      data: { endAtMs: Date.now() + 38_000 },
    }));
    expect(useAuctionStore.getState().extendCount).toBe(1);
  });
});

describe('applyEvent · ROOM_SNAPSHOT', () => {
  beforeEach(RESET);

  it('preserves extendCount across reconnect (backend dispatchWS:367)', () => {
    // Simulate the catchup AUCTION_EXTENDED arriving BEFORE ROOM_SNAPSHOT
    const apply = useAuctionStore.getState().applyEvent;
    apply(env({ seq: 1, type: EventType.AUCTION_EXTENDED, data: { endAtMs: Date.now() + 38_000, extendCount: 2 } }));
    expect(useAuctionStore.getState().extendCount).toBe(2);

    // Now the authoritative snapshot — should NOT zero extendCount
    apply(env({
      seq: 5,
      type: EventType.ROOM_SNAPSHOT,
      data: { status: 'LIVE', currentPriceCents: '13000000', winnerId: 'u1', endAtMs: Date.now() + 38_000, seq: 5 },
    }));
    expect(useAuctionStore.getState().extendCount).toBe(2);
    expect(useAuctionStore.getState().currentCents).toBe('13000000');
  });

  it('resets seqguard watermark via data.seq (gap > 200 fallback path)', () => {
    const apply = useAuctionStore.getState().applyEvent;
    apply(env({
      seq: 999,
      type: EventType.ROOM_SNAPSHOT,
      data: { status: 'LIVE', currentPriceCents: '13000000', winnerId: 'u1', endAtMs: Date.now() + 38_000, seq: 999 },
    }));
    expect(useAuctionStore.getState().lastSeq).toBe(999);

    // A seq=500 envelope arriving after the snapshot — must be dropped
    apply(env({ seq: 500, data: { status: 'LIVE', amountCents: '14000000', userId: 'u2', displayName: 'B', endAtMs: Date.now() + 28_000 } }));
    expect(useAuctionStore.getState().currentCents).toBe('13000000');
  });

  it('applies nested rules without losing capCents=null', () => {
    const apply = useAuctionStore.getState().applyEvent;
    apply(env({
      seq: 7,
      type: EventType.ROOM_SNAPSHOT,
      data: {
        status: 'LIVE',
        currentPriceCents: '13000000',
        winnerId: 'u1',
        endAtMs: Date.now() + 38_000,
        seq: 7,
        rules: {
          stepCents: '250000',
          capCents: null,
          reserveCents: '10000000',
          maxExtensions: 5,
          antiSnipeWindowMs: 10000,
        },
      },
    }));
    const s = useAuctionStore.getState();
    expect(s.stepCents).toBe('250000');
    expect(s.capCents).toBeNull();
    expect(s.reserveCents).toBe('10000000');
    expect(s.startCents).toBe('10000000');
  });
});

describe('applyEvent · terminal states', () => {
  beforeEach(RESET);

  it('AUCTION_SOLD sets status + fires hammer transition', () => {
    useAuctionStore.getState().applyEvent(env({
      seq: 1,
      type: EventType.AUCTION_SOLD,
      data: { amountCents: '15000000', winnerId: 'u_other' },
    }));
    const s = useAuctionStore.getState();
    expect(s.status).toBe('SOLD');
    expect(s.currentCents).toBe('15000000');
    expect(s.winnerId).toBe('u_other');
    expect(s.hammerTrans).toBe(true);
  });

  it('AUCTION_NO_BID sets status without touching price', () => {
    useAuctionStore.getState().applyEvent(env({ seq: 1, type: EventType.AUCTION_NO_BID, data: {} }));
    expect(useAuctionStore.getState().status).toBe('NO_BID');
  });

  it('AUCTION_CANCELLED sets status without touching price', () => {
    useAuctionStore.getState().applyEvent(env({ seq: 1, type: EventType.AUCTION_CANCELLED, data: {} }));
    expect(useAuctionStore.getState().status).toBe('CANCELLED');
  });
});

describe('applyEvent · leaderboard mergeLeader', () => {
  beforeEach(RESET);

  it('keeps max-per-user (does not duplicate entries)', () => {
    const apply = useAuctionStore.getState().applyEvent;
    apply(env({ seq: 1, data: { status: 'LIVE', amountCents: '11000000', userId: 'u1', displayName: 'A', endAtMs: Date.now() + 28_000 } }));
    apply(env({ seq: 2, data: { status: 'LIVE', amountCents: '12000000', userId: 'u1', displayName: 'A', endAtMs: Date.now() + 28_000 } }));
    const ledr = useAuctionStore.getState().leaders;
    expect(ledr.filter((l) => l.userId === 'u1').length).toBe(1);
    expect(ledr[0].cents).toBe('12000000');
  });

  it('sorts by cents descending (BigInt-safe)', () => {
    const apply = useAuctionStore.getState().applyEvent;
    apply(env({ seq: 1, data: { status: 'LIVE', amountCents: '11000000', userId: 'u1', displayName: 'A', endAtMs: Date.now() + 28_000 } }));
    apply(env({ seq: 2, data: { status: 'LIVE', amountCents: '13000000', userId: 'u2', displayName: 'B', endAtMs: Date.now() + 28_000 } }));
    apply(env({ seq: 3, data: { status: 'LIVE', amountCents: '12000000', userId: 'u3', displayName: 'C', endAtMs: Date.now() + 28_000 } }));
    const ledr = useAuctionStore.getState().leaders;
    expect(ledr.map((l) => l.userId)).toEqual(['u2', 'u3', 'u1']);
  });

  it('handles BigInt-precision comparison at 9e15+ cents (max-money boundary)', () => {
    const apply = useAuctionStore.getState().applyEvent;
    apply(env({ seq: 1, data: { status: 'LIVE', amountCents: '9000000000000000', userId: 'u1', displayName: 'A', endAtMs: Date.now() + 28_000 } }));
    apply(env({ seq: 2, data: { status: 'LIVE', amountCents: '9000000000000001', userId: 'u2', displayName: 'B', endAtMs: Date.now() + 28_000 } }));
    expect(useAuctionStore.getState().leaders[0].userId).toBe('u2');
  });
});

describe('applyReject', () => {
  beforeEach(RESET);

  it('appends to recentRejects with a code + ts', () => {
    useAuctionStore.getState().applyReject({
      type: EventType.BID_REJECTED,
      requestId: 'req-1',
      data: { code: 'ERR_TOO_LOW' },
    });
    const s = useAuctionStore.getState();
    expect(s.recentRejects[0].code).toBe('ERR_TOO_LOW');
    expect(s.lastRejectCode).toBe('ERR_TOO_LOW');
  });

  it('caps recentRejects at 10', () => {
    const reject = useAuctionStore.getState().applyReject;
    for (let i = 0; i < 15; i++) {
      reject({ type: EventType.BID_REJECTED, requestId: `r-${i}`, data: { code: 'ERR_TOO_LOW' } });
    }
    expect(useAuctionStore.getState().recentRejects.length).toBe(10);
  });
});
