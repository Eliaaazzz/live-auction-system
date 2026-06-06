import { describe, expect, it } from 'vitest';
import {
  bidActivityDeltaFromEvent,
  bidRejectCodeFromCommandError,
  nextLeaderRefreshBump,
  shouldFallbackBidCommand,
  tickerItemFromEvent,
} from './LiveRoomRoute.jsx';
import { BidErrorCode, EventType } from '../lib/types.js';

describe('LiveRoomRoute high-fanout activity helpers', () => {
  it('counts ROOM_STATE_PATCH bidCountDelta as bid activity', () => {
    expect(bidActivityDeltaFromEvent({ type: EventType.BID_ACCEPTED, data: {} })).toBe(1);
    expect(bidActivityDeltaFromEvent({
      type: EventType.ROOM_STATE_PATCH,
      data: { bidCountDelta: 5 },
    })).toBe(5);
  });

  it('uses ROOM_STATE_PATCH activity to trigger leaderboard refresh cadence', () => {
    expect(nextLeaderRefreshBump(1, {
      type: EventType.ROOM_STATE_PATCH,
      data: { bidCountDelta: 2 },
    })).toEqual({ hadBidActivity: true, shouldRefresh: true, pending: 0 });
  });

  it('maps ROOM_STATE_PATCH into ticker rows', () => {
    expect(tickerItemFromEvent({
      type: EventType.ROOM_STATE_PATCH,
      seq: 12,
      data: {
        winnerId: 'u2',
        winnerDisplayName: 'Bidder Two',
        currentPriceCents: '14500000',
      },
    })).toEqual({ id: 12, kind: 'projection', name: '价格同步', cents: '14500000' });
  });
});

describe('LiveRoomRoute HTTP bid command fallback helpers', () => {
  it('falls back only when the HTTP command lane is unavailable', () => {
    expect(shouldFallbackBidCommand({ status: 404 })).toBe(true);
    expect(shouldFallbackBidCommand({ status: 405 })).toBe(true);
    expect(shouldFallbackBidCommand({ status: 501 })).toBe(true);
    expect(shouldFallbackBidCommand({ name: 'AbortError' })).toBe(true);
    expect(shouldFallbackBidCommand({ name: 'TypeError' })).toBe(true);

    expect(shouldFallbackBidCommand({ status: 401 })).toBe(false);
    expect(shouldFallbackBidCommand({ status: 409, code: BidErrorCode.ERR_TOO_LOW })).toBe(false);
    expect(shouldFallbackBidCommand({ status: 500 })).toBe(false);
  });

  it('maps HTTP command errors to canonical bid rejection codes', () => {
    expect(bidRejectCodeFromCommandError({ status: 401, code: 'ERR_AUTH' }))
      .toBe(BidErrorCode.ERR_NOT_ALLOWED);
    expect(bidRejectCodeFromCommandError({ status: 403 }))
      .toBe(BidErrorCode.ERR_NOT_ALLOWED);
    expect(bidRejectCodeFromCommandError({ status: 409, code: BidErrorCode.ERR_TOO_LOW }))
      .toBe(BidErrorCode.ERR_TOO_LOW);
    expect(bidRejectCodeFromCommandError({ status: 500, code: 'ERR_UNKNOWN' }))
      .toBe(BidErrorCode.ERR_INTERNAL);
  });
});
