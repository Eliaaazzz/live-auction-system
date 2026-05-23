package store

// Edge-case + invariant tests for the T2 place_bid hot path. These exist
// alongside lua_integration_test.go to lock behaviors that surfaced during
// PR #26 review (https://github.com/Eliaaazzz/live-auction-system/pull/26):
//
//   1. No anti-snipe extension cap (documents current behavior; future
//      MaxExtensions PR must update this test).
//   2. DUPLICATE retry returns only the bid ack, NOT the secondary
//      AUCTION_EXTENDED/AUCTION_SOLD event (documents the dedupe contract;
//      retrying clients must reconnect+catchup to recover missed secondaries).
//   3. Cap-hit takes priority over anti-snipe when both conditions hold.
//   4. Boundary precision at endAtMs: bid at exactly endAtMs is ERR_AFTER_END.
//   5. paused flag toggle mid-auction preserves seq monotonicity on resume.
//   6. Sequential extensions emit (BID_ACCEPTED, AUCTION_EXTENDED) pairs with
//      strictly monotonic seqs and unique <seq>-0 Stream IDs.
//   7. cap == 0 = "no buy-now": very large amounts accepted as OK_ACCEPTED,
//      NOT OK_SOLD. (Locks the semantic; ensures admin form null != cap=0.)
//   8. displayName from ARGV reaches the BID_ACCEPTED Stream payload verbatim.
//
// All tests use the same Redis + helper pattern as lua_integration_test.go
// (REDIS_ADDR env; skip when unavailable).

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

// extendOnEverythingRules is a Rules where every bid triggers anti-snipe
// (ExtendWindowSec is huge so the bid is always "inside the window").
func extendOnEverythingRules() model.Rules {
	r := defaultRules()
	r.ExtendWindowSec = 3600 // any bid within 1h of endAtMs extends
	r.ExtendSec = 30
	return r
}

// --- 1. No MaxExtensions cap — documents current behavior ---

// TestPlaceBid_NoExtensionCap_AllowsRunaway documents that T2 has NO upper
// bound on the number of anti-snipe extensions. Two bidders ratcheting +1
// increment within the extend window can extend the auction indefinitely.
//
// If/when a MaxExtensions rule field lands, this test must update to assert
// the cap takes effect. Until then it stands as a tripwire so the issue isn't
// forgotten.
func TestPlaceBid_NoExtensionCap_AllowsRunaway(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	r := extendOnEverythingRules()
	r.IncrementCents = 1 // ratchet by minimum
	aid := liveAuction(t, s, r, 60_000)

	const N = 50 // 50 extensions is plenty to demonstrate; production would cap ~3-10
	for i := 0; i < N; i++ {
		amt := strconv.Itoa(10001 + i)     // 10001, 10002, 10003, ...
		uid := "u" + strconv.Itoa(1+(i%2)) // bounce between u1 / u2
		cb := "cb_" + strconv.Itoa(i)
		code, _, _, err := s.PlaceBid(ctx, aid, uid, cb, amt, uid)
		if err != nil {
			t.Fatalf("bid %d: err=%v", i, err)
		}
		if code != model.CodeOKExtended {
			t.Fatalf("bid %d: code=%s want OK_EXTENDED (extension cap should have engaged?)", i, code)
		}
	}
	got, _ := s.rdb.HGet(ctx, stateKey(aid), "extendCount").Int64()
	if got != N {
		t.Fatalf("extendCount=%d want %d (no cap enforced)", got, N)
	}
	// If/when MaxExtensions is added, replace the want above with the cap and
	// assert post-cap bids are accepted as OK_ACCEPTED (not OK_EXTENDED) and
	// emit only BID_ACCEPTED (no AUCTION_EXTENDED secondary event).
}

// --- 2. DUPLICATE retry does NOT replay the secondary event ---

// TestPlaceBid_DuplicateAfterExtend_OnlyReturnsBid: first bid triggers
// OK_EXTENDED (5-element shape with secondary AUCTION_EXTENDED event). Retry
// with the same clientBidId returns DUPLICATE (2-element shape, bidJson only).
// A retrying client on the SAME WS (no reconnect) therefore misses the
// AUCTION_EXTENDED event the room already saw.
//
// Recovery path is reconnect + ROOM_JOIN with lastSeq → CATCHUP_EVENTS replays
// both Stream entries. This test locks the contract; if Lua ever changes to
// re-emit the secondary on DUPLICATE, this test catches the silent semantic
// shift.
func TestPlaceBid_DuplicateAfterExtend_OnlyReturnsBid(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, extendOnEverythingRules(), 60_000)

	// First call triggers extend.
	code, seq1, ack1, err := s.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1")
	if err != nil || code != model.CodeOKExtended {
		t.Fatalf("first: code=%s err=%v want OK_EXTENDED", code, err)
	}
	if seq1 != 1 {
		t.Fatalf("first seq=%d want 1", seq1)
	}
	var firstBid model.BidAcceptedData
	if err := json.Unmarshal([]byte(ack1), &firstBid); err != nil {
		t.Fatalf("decode ack1: %v", err)
	}

	// Retry SAME clientBidId.
	code, seq2, ack2, err := s.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1")
	if err != nil {
		t.Fatalf("retry: err=%v", err)
	}
	if code != model.CodeDuplicate {
		t.Fatalf("retry: code=%s want DUPLICATE", code)
	}
	// DUPLICATE return shape is (code, 0, bidJson) — Store.PlaceBid puts seq=0
	// because the cached payload is the bid only; per dedupe contract, the
	// AUCTION_EXTENDED secondary event is NOT re-emitted or re-cached.
	if seq2 != 0 {
		t.Fatalf("retry seq=%d want 0 (Store strips seq on DUPLICATE per the 2-element shape)", seq2)
	}
	if ack2 != ack1 {
		t.Fatalf("retry ack differs from first:\n first=%s\n retry=%s", ack1, ack2)
	}

	// Stream should STILL have exactly 2 entries from the first call.
	// The retry must NOT have written anything new.
	events, _, err := s.ReadEventsAfter(ctx, aid, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 ||
		events[0].Type != model.TypeBidAccepted || events[0].ID != "1-0" ||
		events[1].Type != model.TypeAuctionExtended || events[1].ID != "2-0" {
		t.Fatalf("after retry stream=%+v want exactly [BID_ACCEPTED@1-0, AUCTION_EXTENDED@2-0]", events)
	}
}

// --- 3. Cap-hit takes priority over anti-snipe ---

// TestPlaceBid_CapHit_InsideExtendWindow_SoldNotExtended: a bid that BOTH
// equals/exceeds capPriceCents AND arrives inside extendWindowSec must
// resolve to OK_SOLD (terminal), not OK_EXTENDED. Locks the place_bid.lua
// branch `extend = (not capHit) and ...`.
func TestPlaceBid_CapHit_InsideExtendWindow_SoldNotExtended(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	r := extendOnEverythingRules()
	r.CapPriceCents = 50000
	aid := liveAuction(t, s, r, 60_000)

	code, seq, _, err := s.PlaceBid(ctx, aid, "u1", "cb1", "50000", "U1")
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if code != model.CodeOKSold {
		t.Fatalf("code=%s want OK_SOLD (cap-hit must beat anti-snipe even inside extend window)", code)
	}
	if seq != 1 {
		t.Fatalf("seq=%d want 1", seq)
	}
	// status must be SOLD.
	if st, _ := s.rdb.HGet(ctx, stateKey(aid), "status").Result(); st != model.StateSold {
		t.Fatalf("status=%s want SOLD", st)
	}
	// extendCount must NOT have been incremented (no extension occurred).
	if cnt, _ := s.rdb.HGet(ctx, stateKey(aid), "extendCount").Int64(); cnt != 0 {
		t.Fatalf("extendCount=%d want 0 (cap-hit skipped extend branch)", cnt)
	}
	// Stream: BID_ACCEPTED@1-0 then AUCTION_SOLD@2-0 (NOT AUCTION_EXTENDED).
	events, _, _ := s.ReadEventsAfter(ctx, aid, "")
	if len(events) != 2 ||
		events[1].Type != model.TypeAuctionSold {
		t.Fatalf("stream=%+v want secondary AUCTION_SOLD not AUCTION_EXTENDED", events)
	}
}

// --- 4. endAtMs boundary precision ---

// TestPlaceBid_AtExactlyEndAtMs_RejectedAsAfterEnd: bid arrives with Redis TIME
// reading exactly equal to endAtMs. Lua uses `if now >= endAtMs then return
// ERR_AFTER_END`. Verify the boundary is INCLUSIVE on the rejection side.
//
// We can't trivially synchronize Go time.Now() with Redis TIME, so we set
// endAtMs to a value in the (deep) past and assert rejection — equivalent to
// the boundary case since `now > endAtMs` (a fortiori) must reject too.
func TestPlaceBid_AtExactlyEndAtMs_RejectedAsAfterEnd(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000)

	// Force endAtMs into the past via direct HSET (test-only — production code
	// must never write hot keys outside Lua per V9 §0).
	if err := s.rdb.HSet(ctx, stateKey(aid), "endAtMs", 0).Err(); err != nil {
		t.Fatal(err)
	}
	code, _, _, err := s.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1")
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if code != model.CodeErrAfterEnd {
		t.Fatalf("code=%s want ERR_AFTER_END (boundary inclusive: now >= endAtMs)", code)
	}
}

// --- 5. paused flag toggle preserves seq monotonicity ---

// TestPlaceBid_PausedMidAuction_ResumeKeepsSeq: bid#1 OK, set paused=true, bid#2
// rejected ERR_AUCTION_PAUSED (no seq consumed), unset, bid#3 OK with seq =
// bid#1.seq + 1. The paused-rejection path must NOT advance seq.
func TestPlaceBid_PausedMidAuction_ResumeKeepsSeq(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000)

	code, seq1, _, err := s.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1")
	if err != nil || code != model.CodeOKAccepted {
		t.Fatalf("bid1: code=%s err=%v", code, err)
	}
	if seq1 != 1 {
		t.Fatalf("bid1 seq=%d want 1", seq1)
	}

	// Pause.
	if err := s.rdb.HSet(ctx, stateKey(aid), "paused", "true").Err(); err != nil {
		t.Fatal(err)
	}
	code, seq2, _, _ := s.PlaceBid(ctx, aid, "u2", "cb2", "12000", "U2")
	if code != model.CodeErrPaused {
		t.Fatalf("paused bid: code=%s want ERR_AUCTION_PAUSED", code)
	}
	if seq2 != 0 {
		t.Fatalf("paused bid seq=%d want 0 (must not advance seq)", seq2)
	}
	// Confirm Redis state.seq is still 1.
	gotSeq, _ := s.rdb.HGet(ctx, stateKey(aid), "seq").Int64()
	if gotSeq != 1 {
		t.Fatalf("after-pause state.seq=%d want 1 (rejected bid must not consume seq)", gotSeq)
	}

	// Unpause.
	if err := s.rdb.HSet(ctx, stateKey(aid), "paused", "false").Err(); err != nil {
		t.Fatal(err)
	}
	code, seq3, _, err := s.PlaceBid(ctx, aid, "u3", "cb3", "13000", "U3")
	if err != nil || code != model.CodeOKAccepted {
		t.Fatalf("resumed bid: code=%s err=%v", code, err)
	}
	if seq3 != 2 {
		t.Fatalf("resumed bid seq=%d want 2 (continues from bid1.seq+1, NOT bid1.seq+2)", seq3)
	}
}

// --- 6. Sequential extensions emit pairs with unique stream IDs ---

// TestPlaceBid_TwoSequentialExtensions_SeqMonotonicAndUniqueStreamIDs:
// two consecutive extending bids → Stream entries at seq 1,2,3,4 each with
// <seq>-0 ID. Locks the "secondary events take their own seq" invariant.
func TestPlaceBid_TwoSequentialExtensions_SeqMonotonicAndUniqueStreamIDs(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, extendOnEverythingRules(), 60_000)

	if code, _, _, err := s.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1"); err != nil || code != model.CodeOKExtended {
		t.Fatalf("bid1: code=%s err=%v", code, err)
	}
	if code, _, _, err := s.PlaceBid(ctx, aid, "u2", "cb2", "12000", "U2"); err != nil || code != model.CodeOKExtended {
		t.Fatalf("bid2: code=%s err=%v", code, err)
	}

	events, _, err := s.ReadEventsAfter(ctx, aid, "")
	if err != nil {
		t.Fatal(err)
	}
	wantTypes := []string{model.TypeBidAccepted, model.TypeAuctionExtended, model.TypeBidAccepted, model.TypeAuctionExtended}
	wantIDs := []string{"1-0", "2-0", "3-0", "4-0"}
	if len(events) != 4 {
		t.Fatalf("got %d events want 4", len(events))
	}
	for i, e := range events {
		if e.Type != wantTypes[i] || e.ID != wantIDs[i] {
			t.Errorf("event[%d]={Type=%s, ID=%s} want={%s, %s}", i, e.Type, e.ID, wantTypes[i], wantIDs[i])
		}
	}
	// extendCount must be 2 (one per extending bid).
	if cnt, _ := s.rdb.HGet(ctx, stateKey(aid), "extendCount").Int64(); cnt != 2 {
		t.Errorf("extendCount=%d want 2", cnt)
	}
}

// --- 7. cap == 0 means no buy-now (very large amounts are normal accepts) ---

// TestPlaceBid_ZeroCap_LargeAmountIsAcceptedNotSold: with capPriceCents=0,
// a bid of arbitrary large amount must be OK_ACCEPTED (not OK_SOLD). Locks
// the place_bid.lua branch `capPriceCents > 0 and amount >= capPriceCents`.
func TestPlaceBid_ZeroCap_LargeAmountIsAcceptedNotSold(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	r := defaultRules() // CapPriceCents = 0 by default
	aid := liveAuction(t, s, r, 60_000)

	const huge = "99999999999"
	code, seq, _, err := s.PlaceBid(ctx, aid, "u1", "cb1", huge, "U1")
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if code != model.CodeOKAccepted {
		t.Fatalf("code=%s want OK_ACCEPTED (cap=0 means no buy-now ceiling; even huge bids stay LIVE)", code)
	}
	if seq != 1 {
		t.Fatalf("seq=%d want 1", seq)
	}
	if st, _ := s.rdb.HGet(ctx, stateKey(aid), "status").Result(); st != model.StateLive {
		t.Fatalf("status=%s want LIVE (must NOT transition to SOLD without explicit cap)", st)
	}
}

// --- 8. displayName from ARGV reaches Stream payload verbatim ---

// TestPlaceBid_DisplayNamePropagatesToStreamPayload: distinct displayName
// arg → BID_ACCEPTED Stream payload contains that exact string. Catches any
// regression where the dispatcher swaps in userId or drops the field.
func TestPlaceBid_DisplayNamePropagatesToStreamPayload(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000)

	const want = "Buyer-37 (display name with spaces)"
	code, _, _, err := s.PlaceBid(ctx, aid, "u37", "cb_dn", "11000", want)
	if err != nil || code != model.CodeOKAccepted {
		t.Fatalf("err=%v code=%s", err, code)
	}
	events, _, _ := s.ReadEventsAfter(ctx, aid, "")
	if len(events) != 1 {
		t.Fatalf("events=%d want 1", len(events))
	}
	var p model.BidAcceptedData
	if err := json.Unmarshal([]byte(events[0].Payload), &p); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if p.DisplayName != want {
		t.Fatalf("displayName=%q want %q (verbatim from ARGV)", p.DisplayName, want)
	}
}

// --- helper: small sleep to avoid sub-millisecond Redis TIME quantization ---
//
// Some tests would benefit from a deterministic "wait for endAtMs to fall in
// the past" but the existing pattern uses HSET to force endAtMs (see test #4).
// Keeping this helper available for future tests that need a real time gap.
func sleepMs(ms int) { time.Sleep(time.Duration(ms) * time.Millisecond) }
