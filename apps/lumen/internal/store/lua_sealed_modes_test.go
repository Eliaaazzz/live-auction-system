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

// ALL_PAY is the money-safety mode: the close script must reveal the sealed bids,
// emit exactly one runner-up forfeiture before SOLD, expose the post-close
// leaderboard, and delete the private sealed keys. This test attacks the script
// sequencing directly, independent of the higher-level demo.
func TestCloseAllPayEmitsForfeitBeforeSoldAndScrubsPrivateKeys(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	r := defaultRules()
	r.Mode = model.ModeAllPay
	aid := liveAuction(t, s, r, 60_000)

	if code, seq, _, err := s.PlaceBidSealed(ctx, aid, "alice", "a1", "12000", "Alice"); err != nil || code != model.CodeOKAccepted || seq != 1 {
		t.Fatalf("alice sealed bid: code=%s seq=%d err=%v want OK_ACCEPTED/1", code, seq, err)
	}
	if code, seq, _, err := s.PlaceBidSealed(ctx, aid, "bob", "b1", "11000", "Bob"); err != nil || code != model.CodeOKAccepted || seq != 2 {
		t.Fatalf("bob sealed bid: code=%s seq=%d err=%v want OK_ACCEPTED/2", code, seq, err)
	}
	if err := s.rdb.HSet(ctx, stateKey(aid), "endAtMs", 1).Err(); err != nil {
		t.Fatal(err)
	}

	code, _, err := s.CloseAuction(ctx, aid)
	if err != nil || code != model.CodeOKSold {
		t.Fatalf("close ALL_PAY: code=%s err=%v want OK_SOLD/nil", code, err)
	}

	events, _, err := s.ReadEventsAfter(ctx, aid, "")
	if err != nil {
		t.Fatal(err)
	}
	gotTypes := make([]string, 0, len(events))
	for _, e := range events {
		gotTypes = append(gotTypes, e.Type)
	}
	wantTypes := []string{
		model.TypeSealedBidReceived,
		model.TypeSealedBidReceived,
		model.TypeAuctionRevealed,
		model.TypeAllPayForfeit,
		model.TypeAuctionSold,
	}
	if strings.Join(gotTypes, ",") != strings.Join(wantTypes, ",") {
		t.Fatalf("event types=%v want %v", gotTypes, wantTypes)
	}
	for i, e := range events {
		wantSeq := int64(i + 1)
		if e.Seq != wantSeq {
			t.Fatalf("event[%d] seq=%d want %d (%+v)", i, e.Seq, wantSeq, events)
		}
	}

	var reveal struct {
		Bids        []model.RevealedBid `json:"bids"`
		WinnerID    string              `json:"winnerId"`
		AmountCents string              `json:"amountCents"`
	}
	if err := json.Unmarshal([]byte(events[2].Payload), &reveal); err != nil {
		t.Fatalf("reveal payload: %v; payload=%s", err, events[2].Payload)
	}
	if reveal.WinnerID != "alice" || reveal.AmountCents != "12000" || len(reveal.Bids) != 2 || reveal.Bids[0].UserID != "alice" || reveal.Bids[1].UserID != "bob" {
		t.Fatalf("bad ALL_PAY reveal payload: %+v", reveal)
	}

	var forfeit model.AllPayForfeitData
	if err := json.Unmarshal([]byte(events[3].Payload), &forfeit); err != nil {
		t.Fatalf("forfeit payload: %v; payload=%s", err, events[3].Payload)
	}
	if forfeit.UserID != "bob" || forfeit.CoinsForfeit != "11000" || forfeit.Seq != 4 {
		t.Fatalf("bad ALL_PAY_FORFEIT payload: %+v", forfeit)
	}
	var sold model.AuctionSoldData
	if err := json.Unmarshal([]byte(events[4].Payload), &sold); err != nil {
		t.Fatalf("sold payload: %v; payload=%s", err, events[4].Payload)
	}
	if sold.WinnerID != "alice" || sold.AmountCents != "12000" || sold.Status != model.StateSold || sold.Seq != 5 {
		t.Fatalf("bad ALL_PAY sold payload: %+v", sold)
	}

	if exists, err := s.rdb.Exists(ctx, sealedKey(aid), sealedNamesKey(aid)).Result(); err != nil || exists != 0 {
		t.Fatalf("ALL_PAY close left private sealed keys behind: exists=%d err=%v", exists, err)
	}
	lb, err := s.Leaderboard(ctx, aid, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(lb) != 2 || lb[0].UserID != "alice" || lb[0].AmountCents != "12000" || lb[1].UserID != "bob" || lb[1].AmountCents != "11000" {
		t.Fatalf("post-close ALL_PAY leaderboard=%+v", lb)
	}
	snap, err := s.Snapshot(ctx, aid)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Status != model.StateSold || snap.WinnerID != "alice" || snap.CurrentPriceCents != "12000" || snap.Seq != 5 {
		t.Fatalf("post-close ALL_PAY snapshot=%+v", snap)
	}
}
