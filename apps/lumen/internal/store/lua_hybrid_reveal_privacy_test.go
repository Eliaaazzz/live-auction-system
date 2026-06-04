package store

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

func TestPlaceBidHybridDoesNotExposeLiveLeaderThroughRoomSurfaces(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	r := defaultRules()
	r.Mode = model.ModeHybridReveal
	aid := liveAuction(t, s, r, 60_000)

	if code, seq, _, err := s.PlaceBidHybrid(ctx, aid, "alice", "a1", "12000", "Alice"); err != nil || code != model.CodeOKAccepted || seq != 1 {
		t.Fatalf("alice hybrid bid: code=%s seq=%d err=%v want OK_ACCEPTED/1", code, seq, err)
	}
	code, seq, ack, err := s.PlaceBidHybrid(ctx, aid, "bob", "b1", "13000", "Bob")
	if err != nil || code != model.CodeOKAccepted || seq != 2 {
		t.Fatalf("bob hybrid bid: code=%s seq=%d err=%v want OK_ACCEPTED/2", code, seq, err)
	}
	if !strings.Contains(ack, `"userId":"bob"`) || !strings.Contains(ack, `"amountCents":"13000"`) {
		t.Fatalf("private hybrid ack should include bidder's own true leader amount, got %s", ack)
	}

	events, _, err := s.ReadEventsAfter(ctx, aid, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("events=%+v want 2 BID_ACCEPTED events", events)
	}
	var roomPayload model.BidAcceptedData
	if err := json.Unmarshal([]byte(events[1].Payload), &roomPayload); err != nil {
		t.Fatalf("hybrid room payload: %v; payload=%s", err, events[1].Payload)
	}
	if roomPayload.UserID != "alice" || roomPayload.AmountCents != "12000" {
		t.Fatalf("hybrid room payload should reveal only runner-up, got %+v", roomPayload)
	}
	if roomPayload.BidCount != 2 {
		t.Fatalf("hybrid room payload bidCount=%d want 2", roomPayload.BidCount)
	}
	if strings.Contains(events[1].Payload, "bob") || strings.Contains(events[1].Payload, "13000") {
		t.Fatalf("hybrid room payload leaked true leader: %s", events[1].Payload)
	}

	lb, err := s.Leaderboard(ctx, aid, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(lb) == 0 {
		t.Fatal("hybrid leaderboard unexpectedly empty; want runner-up visible, true leader hidden")
	}
	if lb[0].UserID == "bob" || lb[0].AmountCents == "13000" {
		t.Fatalf("hybrid live leaderboard leaked true leader: %+v", lb)
	}
}
