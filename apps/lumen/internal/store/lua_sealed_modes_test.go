package store

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

// Sealed bids have two deliberately different surfaces:
//   - the originating bidder's private ack includes their own amount;
//   - the room-visible Stream/PubSub payload must not leak amount/userId/commit.
//
// This pins the privacy boundary directly against the real Redis Lua script. It
// is intentionally more adversarial than the demo gate: it checks the durable
// Stream payload, the public leaderboard, the public snapshot, and duplicate
// replay behavior after a higher retry amount.
func TestPlaceBidSealedRedactsEveryRoomVisibleSurface(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	r := defaultRules()
	r.Mode = model.ModeSealedFirst
	aid := liveAuction(t, s, r, 60_000)

	code, seq, ack, err := s.PlaceBidSealed(ctx, aid, "alice-secret-id", "cb1", "12000", "Alice")
	if err != nil || code != model.CodeOKAccepted || seq != 1 {
		t.Fatalf("sealed bid: code=%s seq=%d err=%v want OK_ACCEPTED/1", code, seq, err)
	}
	if !strings.Contains(ack, `"amountCents":"12000"`) || !strings.Contains(ack, `"userId":"alice-secret-id"`) {
		t.Fatalf("private ack must include the bidder's own amount + userId, got %s", ack)
	}

	events, _, err := s.ReadEventsAfter(ctx, aid, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Type != model.TypeSealedBidReceived || events[0].Seq != 1 {
		t.Fatalf("events=%+v want exactly one SEALED_BID_RECEIVED seq=1", events)
	}
	payload := events[0].Payload
	for _, forbidden := range []string{"12000", "amountCents", "userId", "alice-secret-id", "commit"} {
		if strings.Contains(payload, forbidden) {
			t.Fatalf("sealed room-visible payload leaked %q: %s", forbidden, payload)
		}
	}
	var recv map[string]any
	if err := json.Unmarshal([]byte(payload), &recv); err != nil {
		t.Fatalf("sealed payload is not valid JSON: %v; payload=%s", err, payload)
	}
	for _, forbiddenKey := range []string{"amountCents", "userId", "commit"} {
		if _, ok := recv[forbiddenKey]; ok {
			t.Fatalf("sealed payload contains forbidden key %q: %s", forbiddenKey, payload)
		}
	}
	if recv["displayName"] != "Alice" || int64(recv["count"].(float64)) != 1 {
		t.Fatalf("sealed payload should keep suspense-only fields, got %s", payload)
	}

	lb, err := s.Leaderboard(ctx, aid, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(lb) != 0 {
		t.Fatalf("sealed bid populated public leaderboard: %+v", lb)
	}
	snap, err := s.Snapshot(ctx, aid)
	if err != nil {
		t.Fatal(err)
	}
	if snap.CurrentPriceCents != "10000" || snap.WinnerID != "" || snap.Seq != 1 {
		t.Fatalf("sealed bid leaked into public snapshot: %+v", snap)
	}

	dupCode, dupSeq, dupAck, err := s.PlaceBidSealed(ctx, aid, "alice-secret-id", "cb1", "99000", "Alice")
	if err != nil || dupCode != model.CodeDuplicate || dupSeq != 0 {
		t.Fatalf("sealed duplicate: code=%s seq=%d err=%v want DUPLICATE/0", dupCode, dupSeq, err)
	}
	if dupAck != ack {
		t.Fatalf("sealed duplicate did not replay byte-identical private ack:\norig=%s\ndup =%s", ack, dupAck)
	}
	if n, err := s.StreamLen(ctx, aid); err != nil || n != 1 {
		t.Fatalf("sealed duplicate mutated stream len=%d err=%v want 1/nil", n, err)
	}
	if score, err := s.rdb.ZScore(ctx, sealedKey(aid), "alice-secret-id").Result(); err != nil || int64(score) != 12000 {
		t.Fatalf("sealed duplicate mutated private max bid: score=%v err=%v want 12000/nil", score, err)
	}
}
