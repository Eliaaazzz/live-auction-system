package store

// T3 gap-probe tests ported from @fariZzzz's #30 test-case doc into executable CI
// gates (issue #32). These two assert current behavior (no fix needed): the Lua
// scripts are the sole writers and Redis serializes them, so any race over a single
// auction resolves to exactly one terminal event.

import (
	"context"
	"sync"
	"testing"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

// TC-T3-105 — cancel vs Timer hammer race. At now >= endAtMs a seller cancel and the
// hammer can be dispatched at the same instant. Redis serializes the two scripts, so
// which wins is nondeterministic, but the invariant holds: exactly one writes the
// terminal (the other no-ops with ERR_ALREADY_TERMINAL), the final status matches the
// winner, and the stream has exactly one terminal event after the bid (gap-free).
func TestT3CancelVsHammerRaceSingleTerminal(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000) // owner = sellerTestID
	if code, _, _, _ := s.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1"); code != model.CodeOKAccepted {
		t.Fatal("pre-expiry bid not accepted")
	}
	if err := s.rdb.HSet(ctx, stateKey(aid), "endAtMs", 1).Err(); err != nil { // due
		t.Fatal(err)
	}

	start := make(chan struct{})
	var wg sync.WaitGroup
	var cancelCode, closeCode string
	wg.Add(2)
	go func() { defer wg.Done(); <-start; cancelCode, _ = s.CancelAuction(ctx, aid, sellerTestID) }()
	go func() { defer wg.Done(); <-start; closeCode, _, _ = s.CloseAuction(ctx, aid) }()
	close(start) // release both at once
	wg.Wait()

	// Exactly one of the two performs the terminal write; the other sees it already
	// terminal. (Order is nondeterministic; both legal orderings are checked.)
	wins := 0
	switch cancelCode {
	case model.CodeOKCancelled:
		wins++
	case model.CodeErrAlreadyTerminal:
	default:
		t.Fatalf("cancel code=%s want OK_CANCELLED or ERR_ALREADY_TERMINAL", cancelCode)
	}
	switch closeCode {
	case model.CodeOKSold:
		wins++
	case model.CodeErrAlreadyTerminal:
	default:
		t.Fatalf("close code=%s want OK_SOLD or ERR_ALREADY_TERMINAL", closeCode)
	}
	if wins != 1 {
		t.Fatalf("exactly one terminal write expected; cancel=%s close=%s", cancelCode, closeCode)
	}

	// Final status + terminal event type match the winner.
	wantStatus, wantType := model.StateSold, model.TypeAuctionSold
	if cancelCode == model.CodeOKCancelled {
		wantStatus, wantType = model.StateCancelled, model.TypeAuctionCancelled
	}
	snap, _ := s.Snapshot(ctx, aid)
	if snap.Status != wantStatus {
		t.Fatalf("status=%s want %s (the race winner)", snap.Status, wantStatus)
	}
	// gap-free: BID_ACCEPTED@1 then exactly one terminal@2.
	events, _, _ := s.ReadEventsAfter(ctx, aid, "")
	if len(events) != 2 || events[0].Seq != 1 || events[1].Seq != 2 || events[1].Type != wantType {
		t.Fatalf("stream=%+v want [BID_ACCEPTED@1, %s@2] (one terminal, no gap)", events, wantType)
	}
}

// TC-T3-103 — double Timer (e.g. a --mode=all instance plus a --mode=timer instance,
// or a double-fire) closing the same due auction concurrently. Redis serializes the
// two close scripts: exactly one wins (OK_SOLD), the other no-ops
// (ERR_ALREADY_TERMINAL), and there is exactly one terminal event — no double seq, no
// gap. (Concurrent companion to TestT3CloseDoubleHammerSecondAlreadyTerminal.)
func TestT3DoubleTimerConcurrentCloseSingleTerminal(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000)
	if code, _, _, _ := s.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1"); code != model.CodeOKAccepted {
		t.Fatal("pre-expiry bid not accepted")
	}
	if err := s.rdb.HSet(ctx, stateKey(aid), "endAtMs", 1).Err(); err != nil { // due
		t.Fatal(err)
	}

	start := make(chan struct{})
	var wg sync.WaitGroup
	codes := make([]string, 2)
	for i := range codes {
		i := i
		wg.Add(1)
		go func() { defer wg.Done(); <-start; codes[i], _, _ = s.CloseAuction(ctx, aid) }()
	}
	close(start)
	wg.Wait()

	ok, terminal := 0, 0
	for _, c := range codes {
		switch c {
		case model.CodeOKSold:
			ok++
		case model.CodeErrAlreadyTerminal:
			terminal++
		default:
			t.Fatalf("close code=%s want OK_SOLD or ERR_ALREADY_TERMINAL", c)
		}
	}
	if ok != 1 || terminal != 1 {
		t.Fatalf("want exactly one OK_SOLD + one ERR_ALREADY_TERMINAL, got %v", codes)
	}
	// exactly one terminal event, gap-free: BID_ACCEPTED@1 then AUCTION_SOLD@2.
	events, _, _ := s.ReadEventsAfter(ctx, aid, "")
	if len(events) != 2 || events[1].Type != model.TypeAuctionSold || events[1].Seq != 2 {
		t.Fatalf("stream=%+v want [BID_ACCEPTED@1, AUCTION_SOLD@2] (exactly one terminal)", events)
	}
}
