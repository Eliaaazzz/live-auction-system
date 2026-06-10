// src/store/auction.test.js
//
// Unit tests for the applyEvent reducer — the heart of the room state.
// Covers every event type in ws-envelope.md §3.2, seqguard dedup,
// extendCount preservation on ROOM_SNAPSHOT reconnect, the cumulative
// counters added in PR #64 (totalBidsCount + bidderIds), and the
// self-vs-other BID_ACCEPTED branches.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  it('ignores malformed non-number seq and avoids throwing', () => {
    const apply = useAuctionStore.getState().applyEvent;
    const before = useAuctionStore.getState().currentCents;

    expect(() => apply(env({
      type: EventType.BID_ACCEPTED,
      seq: 5n,
      data: { status: 'LIVE', amountCents: '12000000', userId: 'u_bad', displayName: 'Bad' },
    }))).not.toThrow();

    expect(useAuctionStore.getState().currentCents).toBe(before);
    expect(useAuctionStore.getState().lastSeq).toBe(0);
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

  it('falls back winnerDisplayName to userId when displayName is empty', () => {
    useAuctionStore.getState().applyEvent(env({
      seq: 1,
      data: { status: 'LIVE', amountCents: '11000000', userId: 'u_other', displayName: '', endAtMs: Date.now() + 28_000 },
    }));
    const s = useAuctionStore.getState();
    expect(s.winnerDisplayName).toBe('u_other');
  });

  it('stores normalized displayName in recentEvents for ticker rendering', () => {
    useAuctionStore.getState().applyEvent(env({
      seq: 1,
      data: { status: 'LIVE', amountCents: '11000000', userId: 'u_other', displayName: '   ', endAtMs: Date.now() + 28_000 },
    }));
    const s = useAuctionStore.getState();

    expect(s.recentEvents[0].data.displayName).toBe('u_other');
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

  it('clears active reject state when BID_ACCEPTED arrives', () => {
    useAuctionStore.getState().applyReject({
      type: EventType.BID_REJECTED,
      requestId: 'r-1',
      data: { code: 'ERR_RATE_LIMITED' },
    });
    expect(useAuctionStore.getState().lastRejectCode).toBe('ERR_RATE_LIMITED');

    useAuctionStore.getState().applyEvent(env({
      seq: 2,
      data: { status: 'LIVE', amountCents: '11000000', userId: 'u_other', displayName: 'Winner', endAtMs: Date.now() + 28_000 },
    }));
    expect(useAuctionStore.getState().lastRejectCode).toBeNull();
    expect(useAuctionStore.getState().lastRejectAt).toBeNull();
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

describe('applyEvent · ROOM_STATE_PATCH', () => {
  beforeEach(RESET);

  it('applies advisory room state fields and clears active reject state', () => {
    useAuctionStore.getState().applyReject({
      type: EventType.BID_REJECTED,
      requestId: 'r-1',
      data: { code: 'ERR_RATE_LIMITED' },
    });

    const patchData = {
      status: 'LIVE',
      currentPriceCents: '13000000',
      winnerId: 'u_patch',
      winnerDisplayName: 'Patch Winner',
      endAtMs: Date.now() + 40_000,
      extendCount: 3,
      bidCountDelta: 2,
    };
    useAuctionStore.getState().applyEvent({
      schemaVersion: 1,
      type: EventType.ROOM_STATE_PATCH,
      seq: 9,
      serverTimeMs: Date.now(),
      data: patchData,
    });

    const s = useAuctionStore.getState();
    expect(s.status).toBe('LIVE');
    expect(s.currentCents).toBe('13000000');
    expect(s.winnerId).toBe('u_patch');
    expect(s.winnerDisplayName).toBe('Patch Winner');
    expect(s.extendCount).toBe(3);
    expect(s.totalBidsCount).toBe(2);
    expect(s.leaders[0]).toMatchObject({
      userId: 'u_patch',
      cents: '13000000',
      isYou: false,
    });
    expect(s.bidderIds).toEqual(['u_patch']);
    expect(s.lastRejectCode).toBeNull();
    expect(s.lastRejectAt).toBeNull();
  });

  it('falls back winnerDisplayName to winnerId and does not replace winner without winnerId', () => {
    useAuctionStore.getState().applyEvent(env({
      seq: 1,
      data: {
        status: 'LIVE',
        amountCents: '12000000',
        userId: 'u_seed',
        displayName: 'Seed',
        endAtMs: Date.now() + 28_000,
      },
    }));
    useAuctionStore.getState().applyEvent({
      schemaVersion: 1,
      type: EventType.ROOM_STATE_PATCH,
      seq: 2,
      serverTimeMs: Date.now(),
      data: {
        winnerId: '',
        winnerDisplayName: '   ',
        currentPriceCents: '12500000',
        status: 'LIVE',
        bidCountDelta: 1,
      },
    });

    const s = useAuctionStore.getState();
    expect(s.currentCents).toBe('12500000');
    expect(s.winnerId).toBe('u_seed');
    expect(s.winnerDisplayName).toBe('Seed');
    expect(s.totalBidsCount).toBe(2);
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

  it('captures auctionMode from rules when backend sends second_price', () => {
    useAuctionStore.getState().applyEvent({
      schemaVersion: 1,
      type: EventType.ROOM_SNAPSHOT,
      seq: 9,
      serverTimeMs: Date.now(),
      data: {
        status: 'LIVE',
        currentPriceCents: '13000000',
        winnerId: 'u1',
        endAtMs: Date.now() + 38_000,
        seq: 9,
        rules: {
          stepCents: '250000',
          capCents: null,
          reserveCents: '10000000',
          maxExtensions: 5,
          antiSnipeWindowMs: 10000,
          auctionMode: 'second_price',
        },
      },
    });

    expect(useAuctionStore.getState().auctionMode).toBe('second_price');
  });

  it('accepts legacy rules.mode values and normalizes vickrey to second_price', () => {
    useAuctionStore.getState().applyEvent({
      schemaVersion: 1,
      type: EventType.ROOM_SNAPSHOT,
      seq: 9,
      serverTimeMs: Date.now(),
      data: {
        status: 'LIVE',
        currentPriceCents: '13000000',
        winnerId: 'u1',
        endAtMs: Date.now() + 38_000,
        seq: 9,
        rules: {
          stepCents: '250000',
          capCents: null,
          reserveCents: '10000000',
          maxExtensions: 5,
          antiSnipeWindowMs: 10000,
          mode: 'vickrey',
        },
      },
    });

    expect(useAuctionStore.getState().auctionMode).toBe('second_price');
  });

  it('normalizes legacy alias mode=second to second_price', () => {
    useAuctionStore.getState().applyEvent({
      schemaVersion: 1,
      type: EventType.ROOM_SNAPSHOT,
      seq: 9,
      serverTimeMs: Date.now(),
      data: {
        status: 'LIVE',
        currentPriceCents: '13000000',
        winnerId: 'u1',
        endAtMs: Date.now() + 38_000,
        seq: 9,
        rules: {
          stepCents: '250000',
          capCents: null,
          reserveCents: '10000000',
          maxExtensions: 5,
          antiSnipeWindowMs: 10000,
          mode: 'second',
        },
      },
    });

    expect(useAuctionStore.getState().auctionMode).toBe('second_price');
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

describe('setLeaders · REST normalization', () => {
  beforeEach(RESET);

  it('normalizes displayName and cents from REST /leaderboard payload', () => {
    useAuctionStore.getState().setLeaders([
      { userId: 'alice', amountCents: '12000000' },
      { userId: 'bob', cents: '13000000', displayName: 'BobName' },
    ]);

    const s = useAuctionStore.getState();
    expect(s.leaders).toHaveLength(2);
    expect(s.leaders[0]).toMatchObject({
      userId: 'alice',
      displayName: 'alice',
      cents: '12000000',
      isYou: false,
    });
    expect(s.leaders[1]).toMatchObject({
      userId: 'bob',
      displayName: 'BobName',
      cents: '13000000',
      isYou: false,
    });
  });

  it('normalizes blank displayName to fallback id in REST leaderboard payload', () => {
    useAuctionStore.getState().setLeaders([
      { userId: 'alice', amountCents: '12000000', displayName: '   ' },
      { userId: 'bob', cents: '13000000', displayName: '' },
    ]);

    const s = useAuctionStore.getState();
    expect(s.leaders).toHaveLength(2);
    expect(s.leaders[0]).toMatchObject({
      userId: 'alice',
      displayName: 'alice',
      cents: '12000000',
    });
    expect(s.leaders[1]).toMatchObject({
      userId: 'bob',
      displayName: 'bob',
      cents: '13000000',
    });
  });

  it('marks current user as self even when displayName is missing', () => {
    useAuctionStore.getState().setSelfUserId('alice');
    useAuctionStore.getState().setLeaders([
      { userId: 'alice', amountCents: '100' },
    ]);

    const s = useAuctionStore.getState();
    expect(s.leaders).toHaveLength(1);
    expect(s.leaders[0]).toMatchObject({ userId: 'alice', displayName: 'alice', isYou: true });
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

  it('AUCTION_SOLD uses the payload winnerId/amountCents as settlement result', () => {
    useAuctionStore.getState().applyEvent(env({
      seq: 1,
      type: EventType.BID_ACCEPTED,
      data: { status: 'LIVE', amountCents: '11000000', userId: 'legacy_other', displayName: 'Legacy', endAtMs: Date.now() + 28_000 },
    }));
    expect(useAuctionStore.getState().currentCents).toBe('11000000');
    expect(useAuctionStore.getState().winnerId).toBe('legacy_other');

    useAuctionStore.getState().applyEvent(env({
      seq: 2,
      type: EventType.AUCTION_SOLD,
      data: { winnerId: 'winner_paid', amountCents: '12000000' },
    }));

    const s = useAuctionStore.getState();
    expect(s.currentCents).toBe('12000000');
    expect(s.winnerId).toBe('winner_paid');
    expect(s.hammerTrans).toBe(true);
  });

  it('AUCTION_SOLD normalizes winnerDisplayName with fallback', () => {
    useAuctionStore.getState().applyEvent(env({
      seq: 1,
      type: EventType.BID_ACCEPTED,
      data: { status: 'LIVE', amountCents: '11000000', userId: 'legacy_other', displayName: 'Legacy', endAtMs: Date.now() + 28_000 },
    }));

    useAuctionStore.getState().applyEvent(env({
      seq: 2,
      type: EventType.AUCTION_SOLD,
      data: { winnerId: 'winner_paid', winnerDisplayName: '', amountCents: '12000000' },
    }));

    const s = useAuctionStore.getState();
    expect(s.winnerId).toBe('winner_paid');
    expect(s.winnerDisplayName).toBe('winner_paid');
    expect(s.currentCents).toBe('12000000');
  });

  it('AUCTION_SOLD keeps existing price/winner when amount or winnerId is absent', () => {
    useAuctionStore.getState().applyEvent(env({
      seq: 1,
      type: EventType.BID_ACCEPTED,
      data: { status: 'LIVE', amountCents: '11000000', userId: 'legacy_other', displayName: 'Legacy', endAtMs: Date.now() + 28_000 },
    }));

    useAuctionStore.getState().applyEvent(env({
      seq: 2,
      type: EventType.AUCTION_SOLD,
      data: {},
    }));

    const s = useAuctionStore.getState();
    expect(s.currentCents).toBe('11000000');
    expect(s.winnerId).toBe('legacy_other');
  });

  it('AUCTION_NO_BID sets status without touching price', () => {
    useAuctionStore.getState().applyEvent(env({
      seq: 1,
      type: EventType.BID_ACCEPTED,
      data: { status: 'LIVE', amountCents: '11000000', userId: 'legacy_other', displayName: 'Legacy', endAtMs: Date.now() + 28_000 },
    }));

    useAuctionStore.getState().applyEvent(env({ seq: 2, type: EventType.AUCTION_NO_BID, data: {} }));
    const s = useAuctionStore.getState();
    expect(useAuctionStore.getState().status).toBe('NO_BID');
    expect(s.currentCents).toBe('11000000');
    expect(s.winnerId).toBe('legacy_other');
  });

  it('AUCTION_CANCELLED sets status without touching price', () => {
    useAuctionStore.getState().applyEvent(env({
      seq: 1,
      type: EventType.BID_ACCEPTED,
      data: { status: 'LIVE', amountCents: '11000000', userId: 'legacy_other', displayName: 'Legacy', endAtMs: Date.now() + 28_000 },
    }));

    useAuctionStore.getState().applyEvent(env({ seq: 2, type: EventType.AUCTION_CANCELLED, data: {} }));
    const s = useAuctionStore.getState();
    expect(useAuctionStore.getState().status).toBe('CANCELLED');
    expect(s.currentCents).toBe('11000000');
    expect(s.winnerId).toBe('legacy_other');
  });
});

describe('applyEvent · AI_COMMENTARY (T7-2 / proto/ai-events.md §POST /llm/auctioneer)', () => {
  beforeEach(RESET);

  it('applies trigger + text + fallback flag from the data payload', () => {
    useAuctionStore.getState().applyEvent({
      schemaVersion: 1,
      type: EventType.AI_COMMENTARY,
      serverTimeMs: Date.now(),
      // spec: seq is null for non-authoritative observability events
      seq: null,
      data: { trigger: 'open', commentary: '蓝面 5711 起拍价 ¥120,000', fallback: false },
    });
    const s = useAuctionStore.getState();
    expect(s.auctioneerTrigger).toBe('open');
    expect(s.auctioneerText).toBe('蓝面 5711 起拍价 ¥120,000');
    expect(s.auctioneerFallback).toBe(false);
  });

  it('TC-T7-201: each of 4 triggers updates the store cleanly', () => {
    const apply = useAuctionStore.getState().applyEvent;
    for (const trig of ['open', 'surge', 'cold', 'hammer']) {
      apply({
        schemaVersion: 1,
        type: EventType.AI_COMMENTARY,
        serverTimeMs: Date.now(),
        seq: null,
        data: { trigger: trig, commentary: `${trig}-text`, fallback: false },
      });
      expect(useAuctionStore.getState().auctioneerTrigger).toBe(trig);
      expect(useAuctionStore.getState().auctioneerText).toBe(`${trig}-text`);
    }
  });

  it('NEVER touches status / currentCents / lastSeq (V9 P3 non-authoritative)', () => {
    // Seed with a real bid first so we have non-default state.
    useAuctionStore.getState().applyEvent({
      schemaVersion: 1, type: EventType.BID_ACCEPTED, seq: 7, serverTimeMs: Date.now(),
      data: { status: 'LIVE', amountCents: '11000000', userId: 'u_x', displayName: 'X', endAtMs: Date.now() + 28_000 },
    });
    const before = useAuctionStore.getState();

    // Apply an AI_COMMENTARY event; state machine fields must be unchanged.
    useAuctionStore.getState().applyEvent({
      schemaVersion: 1, type: EventType.AI_COMMENTARY, seq: null, serverTimeMs: Date.now(),
      data: { trigger: 'hammer', commentary: 'this should not change status', fallback: false },
    });
    const after = useAuctionStore.getState();

    expect(after.status).toBe(before.status);
    expect(after.currentCents).toBe(before.currentCents);
    expect(after.winnerId).toBe(before.winnerId);
    expect(after.lastSeq).toBe(before.lastSeq); // null-seq must not advance watermark
    expect(after.totalBidsCount).toBe(before.totalBidsCount);

    // But the auctioneer fields DID update.
    expect(after.auctioneerText).toBe('this should not change status');
    expect(after.auctioneerTrigger).toBe('hammer');
  });

  it('fallback=true is preserved (UI can dim the bubble)', () => {
    useAuctionStore.getState().applyEvent({
      schemaVersion: 1, type: EventType.AI_COMMENTARY, seq: null, serverTimeMs: Date.now(),
      data: { trigger: 'surge', commentary: '竞争升温', fallback: true },
    });
    expect(useAuctionStore.getState().auctioneerFallback).toBe(true);
  });

  it('init() resets the auctioneer fields', () => {
    useAuctionStore.getState().applyEvent({
      schemaVersion: 1, type: EventType.AI_COMMENTARY, seq: null, serverTimeMs: Date.now(),
      data: { trigger: 'open', commentary: 'some text', fallback: false },
    });
    expect(useAuctionStore.getState().auctioneerText).toBe('some text');

    useAuctionStore.getState().init({ auctionId: 'auc_fresh' });
    const s = useAuctionStore.getState();
    expect(s.auctioneerText).toBe('');
    expect(s.auctioneerTrigger).toBeNull();
    expect(s.auctioneerFallback).toBe(false);
  });

  it('cross-PR #71↔#74: AI_COMMENTARY flips aiSidecarHealth back to "ok"', () => {
    // Elia review on #74 H2: the event itself is proof the sidecar is
    // alive — solves #71 H1 (buyer view never calls draftFacts, badge
    // stuck stale). Verify the recovery path explicitly.
    useAuctionStore.getState().setAiOffline();
    expect(useAuctionStore.getState().aiSidecarHealth).toBe('offline');

    useAuctionStore.getState().applyEvent({
      schemaVersion: 1,
      type: EventType.AI_COMMENTARY,
      serverTimeMs: Date.now(),
      seq: null,
      data: { trigger: 'open', commentary: '开拍', fallback: false },
    });
    expect(useAuctionStore.getState().aiSidecarHealth).toBe('ok');
  });

  it('TC-T7-205 regression: BID_REJECTED does NOT touch auctioneer fields', () => {
    // Trigger detection runs on backend; the frontend reducer only
    // applies AI_COMMENTARY events. This is a regression pin to make
    // sure we never accidentally synthesize an auctioneer event from a
    // reject envelope on the client.
    useAuctionStore.getState().applyReject({
      type: EventType.BID_REJECTED,
      requestId: 'req-1',
      data: { code: 'ERR_TOO_LOW' },
    });
    const s = useAuctionStore.getState();
    expect(s.auctioneerText).toBe('');
    expect(s.auctioneerTrigger).toBeNull();
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
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

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

  it('auto-clears the last reject code after timeout', () => {
    vi.useFakeTimers();
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000);

    useAuctionStore.getState().applyReject({
      type: EventType.BID_REJECTED,
      requestId: 'req-1',
      data: { code: 'ERR_RATE_LIMITED' },
    });
    expect(useAuctionStore.getState().lastRejectCode).toBe('ERR_RATE_LIMITED');
    expect(useAuctionStore.getState().lastRejectAt).toBe(1_000);

    vi.advanceTimersByTime(1_799);
    expect(useAuctionStore.getState().lastRejectCode).toBe('ERR_RATE_LIMITED');

    vi.advanceTimersByTime(1);
    expect(useAuctionStore.getState().lastRejectCode).toBeNull();
    expect(useAuctionStore.getState().lastRejectAt).toBeNull();
  });

  it('keeps latest reject when multiple rejects land in same ms', () => {
    vi.useFakeTimers();
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000);

    const reject = useAuctionStore.getState().applyReject;
    reject({ type: EventType.BID_REJECTED, requestId: 'r-1', data: { code: 'ERR_TOO_LOW' } });
    reject({ type: EventType.BID_REJECTED, requestId: 'r-2', data: { code: 'ERR_RATE_LIMITED' } });
    expect(useAuctionStore.getState().lastRejectCode).toBe('ERR_RATE_LIMITED');

    vi.advanceTimersByTime(1_799);
    expect(useAuctionStore.getState().lastRejectCode).toBe('ERR_RATE_LIMITED');

    vi.advanceTimersByTime(1);
    expect(useAuctionStore.getState().lastRejectCode).toBeNull();
  });

  it('clearLastReject resets reject state immediately', () => {
    useAuctionStore.getState().applyReject({
      type: EventType.BID_REJECTED,
      requestId: 'req-1',
      data: { code: 'ERR_INTERNAL' },
    });
    expect(useAuctionStore.getState().lastRejectCode).toBe('ERR_INTERNAL');
    useAuctionStore.getState().clearLastReject();
    expect(useAuctionStore.getState().lastRejectCode).toBeNull();
    expect(useAuctionStore.getState().lastRejectAt).toBeNull();
  });
});

describe('aiSidecarHealth (T7-3 / issue #70 §4.3)', () => {
  beforeEach(RESET);

  it('defaults to "ok" optimistically — fresh init', () => {
    expect(useAuctionStore.getState().aiSidecarHealth).toBe('ok');
  });

  it('setAiOffline() flips to "offline"', () => {
    useAuctionStore.getState().setAiOffline();
    expect(useAuctionStore.getState().aiSidecarHealth).toBe('offline');
  });

  it('setAiOk() flips back to "ok" after offline', () => {
    useAuctionStore.getState().setAiOffline();
    useAuctionStore.getState().setAiOk();
    expect(useAuctionStore.getState().aiSidecarHealth).toBe('ok');
  });

  it('TC-T7-301: bid path is NEVER affected by aiSidecarHealth flips (V9 P3)', () => {
    // Flip AI offline, then run a regular BID_ACCEPTED through the reducer.
    // currentCents / status / leaders / totalBidsCount must all update
    // exactly as they would when AI is ok.
    useAuctionStore.getState().setAiOffline();
    expect(useAuctionStore.getState().aiSidecarHealth).toBe('offline');

    useAuctionStore.getState().applyEvent({
      schemaVersion: 1,
      type: EventType.BID_ACCEPTED,
      seq: 5,
      serverTimeMs: Date.now(),
      data: { status: 'LIVE', amountCents: '11000000', userId: 'u_other', displayName: 'A', endAtMs: Date.now() + 28_000 },
    });

    const s = useAuctionStore.getState();
    expect(s.aiSidecarHealth).toBe('offline');  // unchanged by the bid
    expect(s.currentCents).toBe('11000000');     // bid applied normally
    expect(s.winnerId).toBe('u_other');
    expect(s.totalBidsCount).toBe(1);
    expect(s.leaders[0].userId).toBe('u_other');
  });

  it('init() resets aiSidecarHealth to "ok" — fresh room is optimistic', () => {
    // aiSidecarHealth lives in DEFAULT_STATE so init() resets it. Each
    // route mount re-evaluates AI health from scratch; main.jsx event
    // bridge will flip back to 'offline' on the next failed draftFacts.
    useAuctionStore.getState().setAiOffline();
    useAuctionStore.getState().init({ auctionId: 'auc_different' });
    expect(useAuctionStore.getState().aiSidecarHealth).toBe('ok');
  });
});
