package store

// T3 hidden / edge tests (real Redis) — adversarial cases beyond the happy-path
// suite, used to validate the PR by actually running it (not static review only):
// fail-closed cancel ownership, close on a non-LIVE auction, cancel-beats-winner,
// the Lua no-rollback preflight + type guards, and double-hammer idempotency.

import (
	"context"
	"testing"

	"github.com/redis/go-redis/v9"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

// Empty/absent sellerId must FAIL CLOSED on a terminal-writing op. The pre-fix
// guard only rejected a non-empty sellerId that differed from the caller, so an
// empty sellerId let anyone cancel. Red on the old Lua, green after the fix.
func TestT3CancelFailClosedOnEmptySeller(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000)
	if err := s.rdb.HSet(ctx, stateKey(aid), "sellerId", "").Err(); err != nil {
		t.Fatal(err)
	}
	code, err := s.CancelAuction(ctx, aid, sellerTestID)
	if err != nil || code != model.CodeErrNotAllow {
		t.Fatalf("cancel with empty sellerId: code=%s err=%v want ERR_NOT_ALLOWED (fail-closed)", code, err)
	}
	if st, _ := s.rdb.HGet(ctx, stateKey(aid), "status").Result(); st != model.StateLive {
		t.Fatalf("status=%s want LIVE (cancel must have been rejected)", st)
	}
}

// close requires status==LIVE; a SCHEDULED (frozen, not started) auction is a
// no-op for the Timer (ERR_ALREADY_TERMINAL — a benign mislabel since SCHEDULED
// isn't terminal, but it never reaches close in production: it's not in the
// active index). No status change, no event written.
func TestT3CloseOnScheduledIsNoOp(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := newAID(t)
	t.Cleanup(func() { cleanupAID(s, aid) })
	if code, err := s.FreezeRules(ctx, aid, sellerTestID, defaultRules()); err != nil || code != model.CodeOKFrozen {
		t.Fatalf("freeze: %s %v", code, err)
	}
	code, _, err := s.CloseAuction(ctx, aid)
	if err != nil || code != model.CodeErrAlreadyTerminal {
		t.Fatalf("close SCHEDULED: code=%s err=%v want ERR_ALREADY_TERMINAL", code, err)
	}
	if st, _ := s.rdb.HGet(ctx, stateKey(aid), "status").Result(); st != model.StateScheduled {
		t.Fatalf("status=%s want SCHEDULED (unchanged)", st)
	}
	if n, _ := s.rdb.XLen(ctx, streamKey(aid)).Result(); n != 0 {
		t.Fatalf("stream len=%d want 0 (no event written)", n)
	}
}

// Cancel is NOT a hammer: cancelling a LIVE auction that already has a winning
// bid goes to CANCELLED (the bidder is not awarded the item), and the terminal
// event is AUCTION_CANCELLED, not AUCTION_SOLD.
func TestT3CancelLiveWithBidsGoesCancelledNotSold(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000)
	if code, _, _, _ := s.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1"); code != model.CodeOKAccepted {
		t.Fatal("bid not accepted")
	}
	if code, err := s.CancelAuction(ctx, aid, sellerTestID); err != nil || code != model.CodeOKCancelled {
		t.Fatalf("cancel: code=%s err=%v want OK_CANCELLED", code, err)
	}
	snap, _ := s.Snapshot(ctx, aid)
	if snap.Status != model.StateCancelled {
		t.Fatalf("status=%s want CANCELLED (not SOLD despite a winner)", snap.Status)
	}
	events, _, _ := s.ReadEventsAfter(ctx, aid, "")
	if last := events[len(events)-1]; last.Type != model.TypeAuctionCancelled {
		t.Fatalf("terminal event=%s want AUCTION_CANCELLED", last.Type)
	}
	if code, _, _, _ := s.PlaceBid(ctx, aid, "u2", "cb2", "12000", "U2"); code != model.CodeErrNotLive {
		t.Fatalf("post-cancel bid=%s want ERR_NOT_LIVE", code)
	}
}

// Lua has no rollback: when the stream's last seq doesn't match state.seq, close
// must reject at the preflight BEFORE any HINCRBY/HSET (no dirty write).
func TestT3CloseSeqStreamMismatchNoDirtyWrite(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000) // seq=0, empty stream
	if err := s.rdb.XAdd(ctx, &redis.XAddArgs{
		Stream: streamKey(aid), ID: "1-0",
		Values: map[string]interface{}{"type": "X", "seq": "1", "payload": "{}"},
	}).Err(); err != nil { // stream seq=1, state seq=0 → desync
		t.Fatal(err)
	}
	if err := s.rdb.HSet(ctx, stateKey(aid), "endAtMs", 1).Err(); err != nil { // make it due
		t.Fatal(err)
	}
	code, _, err := s.CloseAuction(ctx, aid)
	if err != nil || code != model.CodeErrInternal {
		t.Fatalf("close on desync: code=%s err=%v want ERR_INTERNAL", code, err)
	}
	snap, _ := s.Snapshot(ctx, aid)
	if snap.Status != model.StateLive {
		t.Fatalf("status=%s want LIVE (no dirty write)", snap.Status)
	}
	if snap.Seq != 0 {
		t.Fatalf("seq=%d want 0 (HINCRBY must not have run)", snap.Seq)
	}
}

// A wrong-typed state key must trip the type-guard on BOTH ops → ERR_INTERNAL,
// never operating on a corrupt key.
func TestT3CloseCancelKeyTypeGuard(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := newAID(t)
	t.Cleanup(func() { cleanupAID(s, aid) })
	if err := s.rdb.Set(ctx, stateKey(aid), "corrupt", 0).Err(); err != nil {
		t.Fatal(err)
	}
	if code, _, err := s.CloseAuction(ctx, aid); err != nil || code != model.CodeErrInternal {
		t.Fatalf("close wrong-typed: code=%s err=%v want ERR_INTERNAL", code, err)
	}
	if code, err := s.CancelAuction(ctx, aid, sellerTestID); err != nil || code != model.CodeErrInternal {
		t.Fatalf("cancel wrong-typed: code=%s err=%v want ERR_INTERNAL", code, err)
	}
}

// Double hammer (Timer double-fire / two instances): the second close is a clean
// no-op — ERR_ALREADY_TERMINAL, seq unchanged, exactly one terminal event.
func TestT3CloseDoubleHammerSecondAlreadyTerminal(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000)
	if code, _, _, _ := s.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1"); code != model.CodeOKAccepted {
		t.Fatal("bid not accepted")
	}
	if err := s.rdb.HSet(ctx, stateKey(aid), "endAtMs", 1).Err(); err != nil {
		t.Fatal(err)
	}
	if code, _, _ := s.CloseAuction(ctx, aid); code != model.CodeOKSold {
		t.Fatal("first close not OK_SOLD")
	}
	snap1, _ := s.Snapshot(ctx, aid)
	code, _, err := s.CloseAuction(ctx, aid)
	if err != nil || code != model.CodeErrAlreadyTerminal {
		t.Fatalf("second close: code=%s err=%v want ERR_ALREADY_TERMINAL", code, err)
	}
	snap2, _ := s.Snapshot(ctx, aid)
	if snap2.Seq != snap1.Seq {
		t.Fatalf("seq moved on no-op close: %d -> %d", snap1.Seq, snap2.Seq)
	}
	if n, _ := s.rdb.XLen(ctx, streamKey(aid)).Result(); n != 2 {
		t.Fatalf("stream len=%d want 2 (BID_ACCEPTED + one AUCTION_SOLD, no duplicate)", n)
	}
}
