// Hidden tests for the leaderboard REST reconcile (跨端排名一致). THE red line:
// a late/stale REST /leaderboard response must NEVER regress a row the user
// watched climb via ROOM_STATE_PATCH. mergeLeadersMax must merge-MAX per user,
// add unseen rows, never wholesale-overwrite, never drop a live-only row; and
// setLeaders must drop an out-of-order (older snapSeq) REST apply.

import { describe, it, expect, beforeEach } from 'vitest';
import { mergeLeadersMax, useAuctionStore } from './auction.js';
import { AuctionStatus } from '../lib/types.js';

describe('mergeLeadersMax · merge-max never regresses (排名红线)', () => {
  it('does NOT lower a row when a stale REST reports a smaller amount', () => {
    const live = [{ userId: 'u1', displayName: 'Ann', cents: '1000' }];
    const out = mergeLeadersMax(live, [{ userId: 'u1', amountCents: '500' }], null);
    expect(out.find((l) => l.userId === 'u1').cents).toBe('1000'); // kept the higher live value
  });

  it('raises a row when REST reports a larger amount', () => {
    const live = [{ userId: 'u1', cents: '500' }];
    const out = mergeLeadersMax(live, [{ userId: 'u1', amountCents: '1000' }], null);
    expect(out.find((l) => l.userId === 'u1').cents).toBe('1000');
  });

  it('adds rows it has not seen and keeps live-only rows, sorted desc', () => {
    const live = [{ userId: 'u1', cents: '1000' }, { userId: 'u2', cents: '900' }];
    const out = mergeLeadersMax(live, [{ userId: 'u3', amountCents: '950' }], null);
    expect(out.map((l) => l.userId)).toEqual(['u1', 'u3', 'u2']); // u2 (live-only) NOT dropped
  });

  it('flags isYou and falls back displayName to prev/userId', () => {
    const live = [{ userId: 'u2', displayName: 'Bob', cents: '900' }];
    const out = mergeLeadersMax(live, [{ userId: 'u2', amountCents: '900' }], 'u2');
    const row = out.find((l) => l.userId === 'u2');
    expect(row.isYou).toBe(true);
    expect(row.displayName).toBe('Bob'); // REST had none → kept prev's
  });

  it('compares cents as BigInt (no float truncation past 2^53)', () => {
    const big = '9007199254740993'; // 2^53 + 1
    const out = mergeLeadersMax([{ userId: 'u1', cents: '9007199254740992' }],
      [{ userId: 'u1', amountCents: big }], null);
    expect(out[0].cents).toBe(big);
  });

  it('caps at the leaderboard size', () => {
    const rest = Array.from({ length: 12 }, (_, i) => ({ userId: `u${i}`, amountCents: String(1000 - i) }));
    const out = mergeLeadersMax([], rest, null);
    expect(out.length).toBe(10);
    expect(out[0].cents).toBe('1000'); // highest first
  });

  it('tolerates null/garbage rows without throwing', () => {
    const out = mergeLeadersMax([{ userId: 'u1', cents: '5' }], [null, { foo: 'bar' }, { userId: 'u2', amountCents: '7' }], null);
    expect(out.map((l) => l.userId).sort()).toEqual(['u1', 'u2']);
  });
});

describe('setLeaders · snapSeq gating (out-of-order REST)', () => {
  beforeEach(() => {
    useAuctionStore.getState().init({
      auctionId: 'auc_lb', status: AuctionStatus.LIVE,
      currentCents: '0', stepCents: '1', capCents: '0', startCents: '0',
      endAtMs: Date.now() + 30_000, yourUserId: 'u_me',
    });
    useAuctionStore.setState({ leaders: [], leadersSeq: 0 });
  });

  it('applies a newer REST snapshot and advances leadersSeq', () => {
    useAuctionStore.getState().setLeaders([{ userId: 'u1', amountCents: '1000' }], 5);
    expect(useAuctionStore.getState().leadersSeq).toBe(5);
    expect(useAuctionStore.getState().leaders.find((l) => l.userId === 'u1').cents).toBe('1000');
  });

  it('IGNORES an out-of-order older REST snapshot (cannot clobber newer state)', () => {
    useAuctionStore.getState().setLeaders([{ userId: 'u1', amountCents: '1000' }], 5);
    useAuctionStore.getState().setLeaders([{ userId: 'u1', amountCents: '200' }], 3); // stale
    expect(useAuctionStore.getState().leadersSeq).toBe(5);
    expect(useAuctionStore.getState().leaders.find((l) => l.userId === 'u1').cents).toBe('1000');
  });

  it('still merges when snapSeq is absent (older backend, no regression via merge-max)', () => {
    useAuctionStore.getState().setLeaders([{ userId: 'u1', amountCents: '1000' }], 5);
    useAuctionStore.getState().setLeaders([{ userId: 'u1', amountCents: '200' }]); // no seq
    expect(useAuctionStore.getState().leaders.find((l) => l.userId === 'u1').cents).toBe('1000'); // merge-max kept higher
  });
});
