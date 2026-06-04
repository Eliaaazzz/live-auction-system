package store

// T3 hammer + cancel Lua integration tests (real Redis; skip-if-absent). Covers
// close_auction / cancel_auction return codes, the §4.1 hammer-race oracle
// (place_bid loses to close), seq gap-free closing, and cancel events.

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
	"github.com/redis/go-redis/v9"
)

func TestCloseAuctionSold(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000)
	if code, _, _, err := s.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1"); err != nil || code != model.CodeOKAccepted {
		t.Fatalf("bid: code=%s err=%v", code, err)
	}
	// expire it (test-only: production never writes hot keys outside Lua).
	if err := s.rdb.HSet(ctx, stateKey(aid), "endAtMs", 1).Err(); err != nil {
		t.Fatal(err)
	}
	code, _, err := s.CloseAuction(ctx, aid)
	if err != nil || code != model.CodeOKSold {
		t.Fatalf("close: code=%s err=%v want OK_SOLD", code, err)
	}
	snap, _ := s.Snapshot(ctx, aid)
	if snap.Status != model.StateSold || snap.WinnerID != "u1" || snap.CurrentPriceCents != "11000" {
		t.Fatalf("snapshot=%+v want SOLD/u1/11000", snap)
	}
	// stream: BID_ACCEPTED(1-0) then AUCTION_SOLD(2-0), gap-free.
	events, _, _ := s.ReadEventsAfter(ctx, aid, "")
	if len(events) != 2 || events[1].Type != model.TypeAuctionSold || events[1].ID != "2-0" || events[1].Seq != 2 {
		t.Fatalf("stream=%+v want [BID_ACCEPTED, AUCTION_SOLD@2-0]", events)
	}
	// terminal → further bids rejected ERR_NOT_LIVE.
	if code, _, _, _ := s.PlaceBid(ctx, aid, "u2", "cb2", "12000", "U2"); code != model.CodeErrNotLive {
		t.Fatalf("post-hammer bid code=%s want ERR_NOT_LIVE", code)
	}
}

func TestCloseAuctionSoldSecondPricePaysRunnerUp(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	r := defaultRules()
	r.AuctionMode = model.AuctionModeSecondPrice
	aid := liveAuction(t, s, r, 60_000)

	if code, _, _, err := s.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1"); err != nil || code != model.CodeOKAccepted {
		t.Fatalf("bid u1: code=%s err=%v", code, err)
	}
	if code, _, _, err := s.PlaceBid(ctx, aid, "u2", "cb2", "12000", "U2"); err != nil || code != model.CodeOKAccepted {
		t.Fatalf("bid u2: code=%s err=%v", code, err)
	}
	if err := s.rdb.HSet(ctx, stateKey(aid), "endAtMs", 1).Err(); err != nil {
		t.Fatal(err)
	}
	code, _, err := s.CloseAuction(ctx, aid)
	if err != nil || code != model.CodeOKSold {
		t.Fatalf("close: code=%s err=%v want OK_SOLD", code, err)
	}

	events, _, _ := s.ReadEventsAfter(ctx, aid, "")
	if len(events) != 2 || events[1].Type != model.TypeAuctionSold || events[1].ID != "2-0" || events[1].Seq != 2 {
		t.Fatalf("stream=%+v want [BID_ACCEPTED, AUCTION_SOLD@2-0]", events)
	}
	var sold model.AuctionSoldData
	if err := json.Unmarshal([]byte(events[1].Payload), &sold); err != nil {
		t.Fatal(err)
	}
	if sold.AmountCents != "11000" {
		t.Fatalf("auction sold amount=%s want runner-up 11000", sold.AmountCents)
	}
	if sold.WinnerID != "u2" {
		t.Fatalf("winner=%s want u2", sold.WinnerID)
	}
	snap, _ := s.Snapshot(ctx, aid)
	if snap.Status != model.StateSold || snap.CurrentPriceCents != "12000" {
		t.Fatalf("snapshot=%+v want SOLD @12000", snap)
	}
}

func TestCloseAuctionSecondPriceNoRunnerUpFallsBackToReserve(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	r := defaultRules()
	r.AuctionMode = model.AuctionModeSecondPrice
	aid := liveAuction(t, s, r, 60_000)

	if code, _, _, err := s.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1"); err != nil || code != model.CodeOKAccepted {
		t.Fatalf("bid: code=%s err=%v", code, err)
	}
	if err := s.rdb.HSet(ctx, stateKey(aid), "endAtMs", 1).Err(); err != nil {
		t.Fatal(err)
	}
	code, _, err := s.CloseAuction(ctx, aid)
	if err != nil || code != model.CodeOKSold {
		t.Fatalf("close: code=%s err=%v", code, err)
	}

	events, _, _ := s.ReadEventsAfter(ctx, aid, "")
	if len(events) != 2 || events[1].Type != model.TypeAuctionSold {
		t.Fatalf("stream=%+v want [BID_ACCEPTED, AUCTION_SOLD@2-0]", events)
	}
	var sold model.AuctionSoldData
	if err := json.Unmarshal([]byte(events[1].Payload), &sold); err != nil {
		t.Fatal(err)
	}
	if sold.AmountCents != "10000" {
		t.Fatalf("auction sold amount=%s want reserve/start 10000", sold.AmountCents)
	}
}

func TestCloseAuctionNoBid(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000) // no bids
	if err := s.rdb.HSet(ctx, stateKey(aid), "endAtMs", 1).Err(); err != nil {
		t.Fatal(err)
	}
	code, _, err := s.CloseAuction(ctx, aid)
	if err != nil || code != model.CodeOKNoBid {
		t.Fatalf("close: code=%s err=%v want OK_NO_BID", code, err)
	}
	if st, _ := s.rdb.HGet(ctx, stateKey(aid), "status").Result(); st != model.StateNoBid {
		t.Fatalf("status=%s want NO_BID", st)
	}
	events, _, _ := s.ReadEventsAfter(ctx, aid, "")
	if len(events) != 1 || events[0].Type != model.TypeAuctionNoBid || events[0].ID != "1-0" {
		t.Fatalf("stream=%+v want [AUCTION_NO_BID@1-0]", events)
	}
}

func TestCloseAuctionNotDue(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000) // endAtMs ~60s out
	code, endAtMs, err := s.CloseAuction(ctx, aid)
	if err != nil || code != model.CodeErrNotDue {
		t.Fatalf("close: code=%s err=%v want ERR_NOT_DUE", code, err)
	}
	if endAtMs <= 0 {
		t.Fatalf("ERR_NOT_DUE should return the current endAtMs, got %d", endAtMs)
	}
	if st, _ := s.rdb.HGet(ctx, stateKey(aid), "status").Result(); st != model.StateLive {
		t.Fatalf("status=%s want LIVE (not closed)", st)
	}
}

func TestCloseAuctionWithReasonNotDue(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000) // endAtMs ~60s out
	code, reason, endAtMs, err := s.CloseAuctionWithReason(ctx, aid)
	if err != nil || code != model.CodeErrNotDue {
		t.Fatalf("close: code=%s reason=%s err=%v", code, reason, err)
	}
	if reason != "" {
		t.Fatalf("reason for ERR_NOT_DUE should be empty, got %q", reason)
	}
	if endAtMs <= 0 {
		t.Fatalf("ERR_NOT_DUE should return the current endAtMs, got %d", endAtMs)
	}
}

func TestCloseAuctionWithReasonSeqMismatch(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000) // seq=0, stream=empty by default
	if err := s.rdb.XAdd(ctx, &redis.XAddArgs{
		Stream: streamKey(aid),
		ID:     "1-0",
		Values: map[string]interface{}{"type": "X", "seq": "1", "payload": "{}"},
	}).Err(); err != nil {
		t.Fatal(err)
	}
	if err := s.rdb.HSet(ctx, stateKey(aid), "endAtMs", 1).Err(); err != nil {
		t.Fatal(err)
	}
	code, reason, endAtMs, err := s.CloseAuctionWithReason(ctx, aid)
	if err != nil || code != model.CodeErrInternal || reason != "seq_stream_mismatch" {
		t.Fatalf("close: code=%s reason=%q err=%v want ERR_INTERNAL/seq_stream_mismatch", code, reason, err)
	}
	if endAtMs != 0 {
		t.Fatalf("ERR_INTERNAL should return endAtMs=0, got %d", endAtMs)
	}
	snap, _ := s.Snapshot(ctx, aid)
	if snap.Status != model.StateLive {
		t.Fatalf("status=%s want LIVE", snap.Status)
	}
}

func TestCloseAuctionWithReasonKeyType(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000)
	stateK := stateKey(aid)
	if err := s.rdb.Del(ctx, stateK).Err(); err != nil {
		t.Fatal(err)
	}
	if err := s.rdb.Set(ctx, stateK, "corrupt", 0).Err(); err != nil {
		t.Fatal(err)
	}
	code, reason, endAtMs, err := s.CloseAuctionWithReason(ctx, aid)
	if err != nil || code != model.CodeErrInternal || reason != "key_type" {
		t.Fatalf("close: code=%s reason=%q err=%v want ERR_INTERNAL/key_type", code, reason, err)
	}
	if endAtMs != 0 {
		t.Fatalf("ERR_INTERNAL should return endAtMs=0, got %d", endAtMs)
	}
}

func TestCloseAuctionAlreadyTerminal(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	r := defaultRules()
	r.CapPriceCents = 50000
	aid := liveAuction(t, s, r, 60_000)
	// cap-hit SOLD via place_bid (terminal already).
	if code, _, _, _ := s.PlaceBid(ctx, aid, "u1", "cb1", "50000", "U1"); code != model.CodeOKSold {
		t.Fatalf("cap bid not SOLD")
	}
	if err := s.rdb.HSet(ctx, stateKey(aid), "endAtMs", 1).Err(); err != nil {
		t.Fatal(err)
	}
	code, _, _ := s.CloseAuction(ctx, aid)
	if code != model.CodeErrAlreadyTerminal {
		t.Fatalf("close on terminal: code=%s want ERR_ALREADY_TERMINAL", code)
	}
}

// §4.1 hammer-race oracle (pinned): at now >= endAtMs a late BID_PLACE and the
// close compete → place_bid loses (ERR_AFTER_END), close wins (OK_SOLD). Hammer
// priority: the late bid never mutates state/seq.
func TestT3HammerRaceOraclePlaceBidLosesToClose(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000)
	if code, _, _, _ := s.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1"); code != model.CodeOKAccepted {
		t.Fatal("pre-expiry bid not accepted")
	}
	if err := s.rdb.HSet(ctx, stateKey(aid), "endAtMs", 1).Err(); err != nil { // now >= endAtMs
		t.Fatal(err)
	}
	// late bid racing the close → must be rejected.
	code, seq, _, _ := s.PlaceBid(ctx, aid, "u2", "cb2", "12000", "U2")
	if code != model.CodeErrAfterEnd || seq != 0 {
		t.Fatalf("late bid code=%s seq=%d want ERR_AFTER_END/0", code, seq)
	}
	// the hammer wins; winner is the pre-expiry bidder.
	if code, _, _ := s.CloseAuction(ctx, aid); code != model.CodeOKSold {
		t.Fatalf("close code=%s want OK_SOLD", code)
	}
	snap, _ := s.Snapshot(ctx, aid)
	if snap.Status != model.StateSold || snap.WinnerID != "u1" || snap.CurrentPriceCents != "11000" {
		t.Fatalf("snapshot=%+v want SOLD/u1/11000 (late bid must not have applied)", snap)
	}
	// exactly 2 stream entries: the accepted bid + the hammer. No gap, late bid absent.
	events, _, _ := s.ReadEventsAfter(ctx, aid, "")
	if len(events) != 2 || events[0].Seq != 1 || events[1].Seq != 2 || events[1].Type != model.TypeAuctionSold {
		t.Fatalf("stream=%+v want [BID_ACCEPTED@1, AUCTION_SOLD@2]", events)
	}
}

// Concurrent companion to the pinned oracle: with endAtMs already in the past, a
// late bid and the close are dispatched from two goroutines at once. Redis
// serializes the two Lua scripts, so which runs first is nondeterministic — but the
// invariant holds either way: the late bid is NEVER accepted (ERR_AFTER_END if it
// wins the dispatch, ERR_NOT_LIVE if the close already hammered), the close is
// OK_SOLD, and the winner stays the pre-expiry bidder with exactly one extra seq.
// Run under -race to stress the interleaving.
func TestT3HammerRaceConcurrentLateBidNeverWins(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000)
	if code, _, _, _ := s.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1"); code != model.CodeOKAccepted {
		t.Fatal("pre-expiry bid not accepted")
	}
	if err := s.rdb.HSet(ctx, stateKey(aid), "endAtMs", 1).Err(); err != nil { // now >= endAtMs
		t.Fatal(err)
	}
	start := make(chan struct{})
	var wg sync.WaitGroup
	var bidCode, closeCode string
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		bidCode, _, _, _ = s.PlaceBid(ctx, aid, "u2", "cb2", "12000", "U2")
	}()
	go func() {
		defer wg.Done()
		<-start
		closeCode, _, _ = s.CloseAuction(ctx, aid)
	}()
	close(start) // release both at once
	wg.Wait()

	if bidCode != model.CodeErrAfterEnd && bidCode != model.CodeErrNotLive {
		t.Fatalf("late bid code=%s want ERR_AFTER_END or ERR_NOT_LIVE (never accepted)", bidCode)
	}
	if closeCode != model.CodeOKSold {
		t.Fatalf("close code=%s want OK_SOLD", closeCode)
	}
	snap, _ := s.Snapshot(ctx, aid)
	if snap.Status != model.StateSold || snap.WinnerID != "u1" || snap.CurrentPriceCents != "11000" {
		t.Fatalf("snapshot=%+v want SOLD/u1/11000 (late bid must not have applied)", snap)
	}
	// no gap, late bid absent: BID_ACCEPTED@1 then AUCTION_SOLD@2.
	events, _, _ := s.ReadEventsAfter(ctx, aid, "")
	if len(events) != 2 || events[0].Seq != 1 || events[1].Seq != 2 || events[1].Type != model.TypeAuctionSold {
		t.Fatalf("stream=%+v want [BID_ACCEPTED@1, AUCTION_SOLD@2]", events)
	}
}

func TestCancelAuctionLive(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000) // owner = sellerTestID
	code, err := s.CancelAuction(ctx, aid, sellerTestID)
	if err != nil || code != model.CodeOKCancelled {
		t.Fatalf("cancel: code=%s err=%v want OK_CANCELLED", code, err)
	}
	if st, _ := s.rdb.HGet(ctx, stateKey(aid), "status").Result(); st != model.StateCancelled {
		t.Fatalf("status=%s want CANCELLED", st)
	}
	events, _, _ := s.ReadEventsAfter(ctx, aid, "")
	if len(events) != 1 || events[0].Type != model.TypeAuctionCancelled || events[0].ID != "1-0" {
		t.Fatalf("stream=%+v want [AUCTION_CANCELLED@1-0]", events)
	}
	// CANCELLED is terminal → bids rejected ERR_NOT_LIVE.
	if code, _, _, _ := s.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1"); code != model.CodeErrNotLive {
		t.Fatalf("post-cancel bid code=%s want ERR_NOT_LIVE", code)
	}
}

func TestCancelAuctionScheduled(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := newAID(t)
	t.Cleanup(func() { cleanupAID(s, aid) })
	if code, err := s.FreezeRules(ctx, aid, sellerTestID, defaultRules()); err != nil || code != model.CodeOKFrozen {
		t.Fatalf("freeze: code=%s err=%v", code, err)
	}
	// cancel a SCHEDULED (frozen, not started) auction.
	if code, err := s.CancelAuction(ctx, aid, sellerTestID); err != nil || code != model.CodeOKCancelled {
		t.Fatalf("cancel scheduled: code=%s err=%v want OK_CANCELLED", code, err)
	}
	if st, _ := s.rdb.HGet(ctx, stateKey(aid), "status").Result(); st != model.StateCancelled {
		t.Fatalf("status=%s want CANCELLED", st)
	}
	// freeze consumes no seq, so the cancel is the first event: AUCTION_CANCELLED@1-0.
	events, _, _ := s.ReadEventsAfter(ctx, aid, "")
	if len(events) != 1 || events[0].Type != model.TypeAuctionCancelled || events[0].ID != "1-0" || events[0].Seq != 1 {
		t.Fatalf("stream=%+v want [AUCTION_CANCELLED@1-0]", events)
	}
}

func TestCancelAuctionNotOwner(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000)
	code, err := s.CancelAuction(ctx, aid, "not_the_seller")
	if err != nil || code != model.CodeErrNotAllow {
		t.Fatalf("cancel by non-owner: code=%s err=%v want ERR_NOT_ALLOWED", code, err)
	}
	if st, _ := s.rdb.HGet(ctx, stateKey(aid), "status").Result(); st != model.StateLive {
		t.Fatalf("status=%s want LIVE (cancel rejected)", st)
	}
}

func TestCancelAuctionAlreadyTerminal(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000)
	if code, _ := s.CancelAuction(ctx, aid, sellerTestID); code != model.CodeOKCancelled {
		t.Fatal("first cancel not OK")
	}
	code, _ := s.CancelAuction(ctx, aid, sellerTestID)
	if code != model.CodeErrAlreadyTerminal {
		t.Fatalf("second cancel code=%s want ERR_ALREADY_TERMINAL", code)
	}
}
