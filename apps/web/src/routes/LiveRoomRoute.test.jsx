import { describe, expect, it } from 'vitest';
import {
  bidActivityDeltaFromEvent,
  nextLeaderRefreshBump,
  tickerItemFromEvent,
} from './LiveRoomRoute.jsx';
import { EventType } from '../lib/types.js';

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
    })).toEqual({ id: 12, name: 'Bidder Two', cents: '14500000' });
  });
});
