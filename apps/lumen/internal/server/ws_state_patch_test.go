package server

import (
	"encoding/json"
	"testing"
	"time"

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

	if !patches.offerBidAccepted(h, aid, bidAcceptedEvent(1, "u1", "A", "101")) {
		t.Fatal("first bid was not coalesced")
	}
	if !patches.offerBidAccepted(h, aid, bidAcceptedEvent(2, "u2", "B", "102")) {
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
			if data.CurrentPriceCents != "102" || data.WinnerID != "u2" || data.BidCountDelta != 2 {
				t.Fatalf("conn %d patch=%+v, want latest winner u2 price 102 delta 2", i, data)
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

	if patches.offerBidAccepted(h, aid, bidAcceptedEvent(1, "u1", "A", "101")) {
		t.Fatal("small room bid should keep ordinary BID_ACCEPTED broadcast")
	}
	h.join(aid, &Conn{aid: aid, done: make(chan struct{}), crit: make(chan outboundFrame, 4)})
	if patches.offerBidAccepted(h, aid, bidAcceptedEventWithStatus(2, "u2", "B", "102", model.StateSold)) {
		t.Fatal("terminal BID_ACCEPTED(status=SOLD) must not be coalesced")
	}
}

func bidAcceptedEvent(seq int64, userID, displayName, amount string) store.StreamEvent {
	return bidAcceptedEventWithStatus(seq, userID, displayName, amount, model.StateLive)
}

func bidAcceptedEventWithStatus(seq int64, userID, displayName, amount, status string) store.StreamEvent {
	data := model.BidAcceptedData{
		Seq:          seq,
		UserID:       userID,
		DisplayName:  displayName,
		AmountCents:  amount,
		EndAtMs:      123456,
		Status:       status,
		ServerTimeMs: time.Now().UnixMilli(),
	}
	b, _ := json.Marshal(data)
	return store.StreamEvent{Seq: seq, Type: model.TypeBidAccepted, Payload: string(b)}
}
