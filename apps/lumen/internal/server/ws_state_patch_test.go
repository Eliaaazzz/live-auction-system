package server

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/metrics"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

func TestRoomStatePatchCoalescesLargeRoomBidAccepted(t *testing.T) {
	h := newHub()
	const aid = "auc_patch"
	conns := []*Conn{
		{aid: aid, done: make(chan struct{}), crit: make(chan outboundFrame, 4)},
		{aid: aid, done: make(chan struct{}), crit: make(chan outboundFrame, 4)},
	}
	for _, c := range conns {
		h.join(aid, c)
	}
	patches := newRoomStatePatchCoalescer(roomStatePatchConfig{interval: 50 * time.Millisecond, minViewers: 2})

	if !patches.offer(h, aid, bidAcceptedEvent(1, "u1", "A", "101")) {
		t.Fatal("first bid was not coalesced")
	}
	if !patches.offer(h, aid, bidAcceptedEvent(2, "u2", "B", "102")) {
		t.Fatal("second bid was not coalesced")
	}
	patches.flushAll(h, nil)

	for i, c := range conns {
		select {
		case f := <-c.crit:
			var env model.Envelope
			if err := json.Unmarshal(f.raw, &env); err != nil {
				t.Fatalf("conn %d patch envelope: %v", i, err)
			}
			if env.Type != model.TypeRoomStatePatch || env.Seq != 2 {
				t.Fatalf("conn %d env=(%s,%d), want ROOM_STATE_PATCH seq=2", i, env.Type, env.Seq)
			}
			var data model.RoomStatePatchData
			if err := json.Unmarshal(env.Data, &data); err != nil {
				t.Fatalf("conn %d patch data: %v", i, err)
			}
			if data.FromSeq != 1 || data.CurrentPriceCents != "102" || data.WinnerID != "u2" || data.BidCountDelta != 2 || data.BidCountTotal != 2 {
				t.Fatalf("conn %d patch=%+v, want from=1 latest winner u2 price 102 delta/total 2", i, data)
			}
		default:
			t.Fatalf("conn %d did not receive coalesced patch", i)
		}
	}
}

func TestRoomStatePatchSkipsSmallRoomAndTerminalBid(t *testing.T) {
	h := newHub()
	const aid = "auc_patch_small"
	h.join(aid, &Conn{aid: aid, done: make(chan struct{}), crit: make(chan outboundFrame, 4)})
	patches := newRoomStatePatchCoalescer(roomStatePatchConfig{interval: 50 * time.Millisecond, minViewers: 2})

	if patches.offer(h, aid, bidAcceptedEvent(1, "u1", "A", "101")) {
		t.Fatal("small room bid should keep ordinary BID_ACCEPTED broadcast")
	}
	h.join(aid, &Conn{aid: aid, done: make(chan struct{}), crit: make(chan outboundFrame, 4)})
	if patches.offer(h, aid, bidAcceptedEventWithStatus(2, "u2", "B", "102", model.StateSold)) {
		t.Fatal("terminal BID_ACCEPTED(status=SOLD) must not be coalesced")
	}
}

func TestRoomStatePatchCoalescesAntiSnipeExtension(t *testing.T) {
	h := newHub()
	const aid = "auc_patch_ext"
	c := &Conn{aid: aid, done: make(chan struct{}), crit: make(chan outboundFrame, 4)}
	h.join(aid, c)
	patches := newRoomStatePatchCoalescer(roomStatePatchConfig{interval: 50 * time.Millisecond, minViewers: 1})

	if !patches.offer(h, aid, bidAcceptedEvent(1, "u1", "A", "101")) {
		t.Fatal("bid was not coalesced")
	}
	if !patches.offer(h, aid, auctionExtendedEvent(2, 999999, 1)) {
		t.Fatal("extension was not folded into pending patch")
	}
	patches.flushAll(h, nil)

	select {
	case f := <-c.crit:
		var env model.Envelope
		if err := json.Unmarshal(f.raw, &env); err != nil {
			t.Fatalf("patch envelope: %v", err)
		}
		if env.Type != model.TypeRoomStatePatch || env.Seq != 2 {
			t.Fatalf("env=(%s,%d), want ROOM_STATE_PATCH seq=2", env.Type, env.Seq)
		}
		var data model.RoomStatePatchData
		if err := json.Unmarshal(env.Data, &data); err != nil {
			t.Fatalf("patch data: %v", err)
		}
		if data.EndAtMs != 999999 || data.ExtendCount != 1 {
			t.Fatalf("patch=%+v, want extension state folded in", data)
		}
	default:
		t.Fatal("conn did not receive coalesced extension patch")
	}
}

func TestRoomStatePatchRecordsDedicatedMetrics(t *testing.T) {
	h := newHub()
	const aid = "auc_patch_metrics"
	h.join(aid, &Conn{aid: aid, done: make(chan struct{}), crit: make(chan outboundFrame, 4)})
	m := metrics.New()
	patches := newRoomStatePatchCoalescer(roomStatePatchConfig{interval: 50 * time.Millisecond, minViewers: 1})

	if !patches.offer(h, aid, bidAcceptedEvent(1, "u1", "A", "101")) {
		t.Fatal("bid was not coalesced")
	}
	patches.flushAll(h, m)

	snap := m.Snapshot()
	if snap.RoomStatePatches != 1 || snap.RoomStatePatchBids != 1 || snap.RoomStatePatch.Count != 1 {
		t.Fatalf("patch metrics=%+v, want one patch carrying one bid", snap)
	}
}

func TestRoomStatePatchUsesAuthoritativeBidCount(t *testing.T) {
	h := newHub()
	const aid = "auc_patch_bid_count"
	c := &Conn{aid: aid, done: make(chan struct{}), crit: make(chan outboundFrame, 4)}
	h.join(aid, c)
	patches := newRoomStatePatchCoalescer(roomStatePatchConfig{interval: 50 * time.Millisecond, minViewers: 1})

	if !patches.offer(h, aid, bidAcceptedEventWithCount(9, 42, "u1", "A", "101")) {
		t.Fatal("bid was not coalesced")
	}
	patches.flushAll(h, nil)

	select {
	case f := <-c.crit:
		var env model.Envelope
		if err := json.Unmarshal(f.raw, &env); err != nil {
			t.Fatalf("patch envelope: %v", err)
		}
		var data model.RoomStatePatchData
		if err := json.Unmarshal(env.Data, &data); err != nil {
			t.Fatalf("patch data: %v", err)
		}
		if data.BidCountTotal != 42 {
			t.Fatalf("bidCountTotal=%d want authoritative bidCount=42", data.BidCountTotal)
		}
	default:
		t.Fatal("conn did not receive coalesced patch")
	}
}

func TestRoomStatePatchFallsBackToWinnerIDForEmptyDisplayName(t *testing.T) {
	h := newHub()
	const aid = "auc_patch_display_name"
	c := &Conn{aid: aid, done: make(chan struct{}), crit: make(chan outboundFrame, 4)}
	h.join(aid, c)
	patches := newRoomStatePatchCoalescer(roomStatePatchConfig{interval: 50 * time.Millisecond, minViewers: 1})

	if !patches.offer(h, aid, bidAcceptedEvent(1, "u1", "", "101")) {
		t.Fatal("bid was not coalesced")
	}
	patches.flushAll(h, nil)

	select {
	case f := <-c.crit:
		var env model.Envelope
		if err := json.Unmarshal(f.raw, &env); err != nil {
			t.Fatalf("patch envelope: %v", err)
		}
		var data model.RoomStatePatchData
		if err := json.Unmarshal(env.Data, &data); err != nil {
			t.Fatalf("patch data: %v", err)
		}
		if data.WinnerDisplayName != "u1" {
			t.Fatalf("winnerDisplayName=%q want fallback winner id", data.WinnerDisplayName)
		}
	default:
		t.Fatal("conn did not receive coalesced patch")
	}
}

func TestRoomStatePatchClearsBidTotalOnTerminalEvent(t *testing.T) {
	h := newHub()
	const aid = "auc_patch_terminal"
	c := &Conn{aid: aid, done: make(chan struct{}), crit: make(chan outboundFrame, 4)}
	h.join(aid, c)
	patches := newRoomStatePatchCoalescer(roomStatePatchConfig{interval: 50 * time.Millisecond, minViewers: 1})

	if !patches.offer(h, aid, bidAcceptedEventWithCount(1, 10, "u1", "A", "101")) {
		t.Fatal("bid was not coalesced")
	}
	if patches.offer(h, aid, auctionSoldEvent(2, "u1", "101")) {
		t.Fatal("terminal AUCTION_SOLD must not be coalesced")
	}
	if _, ok := patches.bidTotals[aid]; ok {
		t.Fatal("bid total was not cleared on terminal event")
	}
	patches.flushAll(h, nil)

	select {
	case f := <-c.crit:
		var env model.Envelope
		if err := json.Unmarshal(f.raw, &env); err != nil {
			t.Fatalf("patch envelope: %v", err)
		}
		if env.Type != model.TypeRoomStatePatch || env.Seq != 1 {
			t.Fatalf("env=(%s,%d), want pending ROOM_STATE_PATCH seq=1", env.Type, env.Seq)
		}
	default:
		t.Fatal("pending patch was dropped by terminal cleanup")
	}
}

func bidAcceptedEvent(seq int64, userID, displayName, amount string) store.StreamEvent {
	return bidAcceptedEventWithCount(seq, seq, userID, displayName, amount)
}

func bidAcceptedEventWithCount(seq, bidCount int64, userID, displayName, amount string) store.StreamEvent {
	return bidAcceptedEventWithStatusAndCount(seq, bidCount, userID, displayName, amount, model.StateLive)
}

func bidAcceptedEventWithStatus(seq int64, userID, displayName, amount, status string) store.StreamEvent {
	return bidAcceptedEventWithStatusAndCount(seq, seq, userID, displayName, amount, status)
}

func bidAcceptedEventWithStatusAndCount(seq, bidCount int64, userID, displayName, amount, status string) store.StreamEvent {
	data := model.BidAcceptedData{
		Seq:          seq,
		UserID:       userID,
		DisplayName:  displayName,
		AmountCents:  amount,
		EndAtMs:      123456,
		Status:       status,
		BidCount:     bidCount,
		ServerTimeMs: time.Now().UnixMilli(),
	}
	b, _ := json.Marshal(data)
	return store.StreamEvent{Seq: seq, Type: model.TypeBidAccepted, Payload: string(b)}
}

func auctionExtendedEvent(seq, endAtMs, extendCount int64) store.StreamEvent {
	data := model.AuctionExtendedData{
		Seq:          seq,
		EndAtMs:      endAtMs,
		ExtendCount:  extendCount,
		ServerTimeMs: time.Now().UnixMilli(),
	}
	b, _ := json.Marshal(data)
	return store.StreamEvent{Seq: seq, Type: model.TypeAuctionExtended, Payload: string(b)}
}

func auctionSoldEvent(seq int64, winnerID, amount string) store.StreamEvent {
	data := model.AuctionSoldData{
		Seq:          seq,
		WinnerID:     winnerID,
		AmountCents:  amount,
		Status:       model.StateSold,
		ServerTimeMs: time.Now().UnixMilli(),
	}
	b, _ := json.Marshal(data)
	return store.StreamEvent{Seq: seq, Type: model.TypeAuctionSold, Payload: string(b)}
}
