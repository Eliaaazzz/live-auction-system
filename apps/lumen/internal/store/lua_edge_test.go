package store

// Hidden / edge-case suite for the Lua hot path — the cases that diff-only review
// tends to miss: idempotency *under concurrency*, the terminal transition under a
// stampede, per-user dedupe isolation, exact accept/reject boundaries, and the
// gateway↔Lua money-string canonicalization contract. Real Redis (skip if absent).
//
// Handed to CI as a standalone file; it shares helpers with lua_integration_test.go
// (same package): newTestStore / liveAuction / defaultRules / cleanupAID / newAID.

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

// Concurrent retries of the SAME (user, clientBidId) must yield exactly one
// accept; every other caller gets DUPLICATE replaying the byte-identical ack, and
// the seq advances exactly once. (Idempotency must hold under a race, not just
// sequentially.)
func TestPlaceBidConcurrentSameClientBidIdIdempotent(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000)

	const N = 32
	var wg sync.WaitGroup
	var accepted, dup int64
	payloads := make([]string, N)
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			code, _, payload, err := s.PlaceBid(ctx, aid, "u1", "same-cb", "11000", "U1")
			if err != nil {
				t.Errorf("bid %d: %v", i, err)
				return
			}
			payloads[i] = payload
			switch code {
			case model.CodeOKAccepted:
				atomic.AddInt64(&accepted, 1)
			case model.CodeDuplicate:
				atomic.AddInt64(&dup, 1)
			default:
				t.Errorf("unexpected code %s", code)
			}
		}(i)
	}
	wg.Wait()

	if accepted != 1 || dup != N-1 {
		t.Fatalf("accepted=%d dup=%d want 1/%d", accepted, dup, N-1)
	}
	// every caller (accept + all dups) saw the same ack bytes.
	for i, p := range payloads {
		if p != payloads[0] {
			t.Fatalf("payload[%d] != payload[0]:\n %s\n %s", i, p, payloads[0])
		}
	}
	if seq, _ := s.rdb.HGet(ctx, stateKey(aid), "seq").Int64(); seq != 1 {
		t.Fatalf("seq=%d want 1 (idempotent retries must not advance seq)", seq)
	}
	if events, _, _ := s.ReadEventsAfter(ctx, aid, ""); len(events) != 1 {
		t.Fatalf("stream len=%d want 1", len(events))
	}
}

// A stampede of cap-hitting bids must produce exactly one SOLD (atomic terminal
// transition): one OK_SOLD, the rest ERR_NOT_LIVE (lost to the terminal state),
// one AUCTION_SOLD event, status SOLD.
func TestPlaceBidConcurrentCapHitSingleWinner(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	r := defaultRules()
	r.CapPriceCents = 50000
	aid := liveAuction(t, s, r, 60_000)

	const N = 32
	var wg sync.WaitGroup
	var sold, notLive int64
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			uid := fmt.Sprintf("u%d", i)
			code, _, _, err := s.PlaceBid(ctx, aid, uid, "cb_"+uid, "50000", uid) // == cap
			if err != nil {
				t.Errorf("bid %d: %v", i, err)
				return
			}
			switch code {
			case model.CodeOKSold:
				atomic.AddInt64(&sold, 1)
			case model.CodeErrNotLive:
				atomic.AddInt64(&notLive, 1)
			default:
				t.Errorf("unexpected code %s", code)
			}
		}(i)
	}
	wg.Wait()

	if sold != 1 || notLive != N-1 {
		t.Fatalf("sold=%d notLive=%d want 1/%d", sold, notLive, N-1)
	}
	if st, _ := s.rdb.HGet(ctx, stateKey(aid), "status").Result(); st != model.StateSold {
		t.Fatalf("status=%s want SOLD", st)
	}
	events, _, _ := s.ReadEventsAfter(ctx, aid, "")
	if len(events) != 2 || events[0].Type != model.TypeBidAccepted || events[1].Type != model.TypeAuctionSold {
		t.Fatalf("stream=%+v want [BID_ACCEPTED AUCTION_SOLD]", events)
	}
}

// Dedupe is keyed per (auction, userId): the same clientBidId from two different
// users are independent bids, both accepted.
func TestPlaceBidDedupeIsPerUser(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000)

	c1, s1, _, err := s.PlaceBid(ctx, aid, "alice", "shared-id", "11000", "Alice")
	if err != nil || c1 != model.CodeOKAccepted || s1 != 1 {
		t.Fatalf("alice: code=%s seq=%d err=%v", c1, s1, err)
	}
	// same clientBidId, different user -> NOT a duplicate.
	c2, s2, _, err := s.PlaceBid(ctx, aid, "bob", "shared-id", "12000", "Bob")
	if err != nil || c2 != model.CodeOKAccepted || s2 != 2 {
		t.Fatalf("bob: code=%s seq=%d err=%v want OK_ACCEPTED seq=2", c2, s2, err)
	}
}

// Exact increment boundary: minAccept = current+increment. minAccept-1 rejected,
// minAccept accepted; the boundary moves up after each accept.
func TestPlaceBidAmountBoundary(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000) // start 10000, increment 1000

	// minAccept = 11000
	if c, _, _, _ := s.PlaceBid(ctx, aid, "u1", "a", "10999", "U1"); c != model.CodeErrTooLow {
		t.Fatalf("10999 -> %s want ERR_TOO_LOW", c)
	}
	if c, _, _, _ := s.PlaceBid(ctx, aid, "u1", "b", "11000", "U1"); c != model.CodeOKAccepted {
		t.Fatalf("11000 -> %s want OK_ACCEPTED", c)
	}
	// boundary moved: minAccept = 12000
	if c, _, _, _ := s.PlaceBid(ctx, aid, "u2", "c", "11999", "U2"); c != model.CodeErrTooLow {
		t.Fatalf("11999 -> %s want ERR_TOO_LOW", c)
	}
	if c, _, _, _ := s.PlaceBid(ctx, aid, "u2", "d", "12000", "U2"); c != model.CodeOKAccepted {
		t.Fatalf("12000 -> %s want OK_ACCEPTED", c)
	}
}

// place_bid.lua echoes the amount string VERBATIM into the ack/Stream/broadcast
// (no canonicalization in Lua). This pins that contract — and is exactly why the
// gateway must canonicalize "0123"/"+123" before EVALSHA (server.canonicalAmount).
func TestPlaceBidStoresAmountVerbatim(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000)

	// "011000" == 11000 (passes the increment check) but is non-canonical.
	_, _, payload, err := s.PlaceBid(ctx, aid, "u1", "cb1", "011000", "U1")
	if err != nil {
		t.Fatal(err)
	}
	if want := `"amountCents":"011000"`; !contains(payload, want) {
		t.Fatalf("ack=%s; expected verbatim %s (gateway must canonicalize before Lua)", payload, want)
	}
}

// Seller may not bid on their own auction (anti shill-bidding; review F7/H4).
func TestPlaceBidSellerCannotBidOwnAuction(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000) // owner = sellerTestID

	code, seq, _, err := s.PlaceBid(ctx, aid, sellerTestID, "cb1", "11000", "Seller")
	if err != nil || code != model.CodeErrNotAllow || seq != 0 {
		t.Fatalf("seller self-bid: code=%s seq=%d err=%v want ERR_NOT_ALLOWED/0", code, seq, err)
	}
	if got, _ := s.rdb.HGet(ctx, stateKey(aid), "seq").Int64(); got != 0 {
		t.Fatalf("seller self-bid advanced seq=%d want 0", got)
	}
	// a different user bids normally.
	code, seq, _, err = s.PlaceBid(ctx, aid, "buyer1", "cb2", "11000", "Buyer")
	if err != nil || code != model.CodeOKAccepted || seq != 1 {
		t.Fatalf("buyer bid: code=%s seq=%d err=%v want OK_ACCEPTED/1", code, seq, err)
	}
}

// cap-aware required price: a bid exactly at cap must close even when
// current+increment overshoots the cap (review F2). Without the fix this is
// rejected as ERR_TOO_LOW and the cap becomes unreachable.
func TestPlaceBidCapReachableWhenIncrementOvershoots(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	r := defaultRules()
	r.StartPriceCents, r.IncrementCents, r.CapPriceCents = 10000, 7000, 20000
	aid := liveAuction(t, s, r, 60_000)

	if code, seq, _, err := s.PlaceBid(ctx, aid, "u1", "cb1", "17000", "U1"); err != nil || code != model.CodeOKAccepted || seq != 1 {
		t.Fatalf("bid1: code=%s seq=%d err=%v want OK_ACCEPTED/1", code, seq, err)
	}
	// current=17000, current+increment=24000 > cap=20000; a bid at cap must SOLD.
	code, seq, _, err := s.PlaceBid(ctx, aid, "u2", "cb2", "20000", "U2")
	if err != nil || code != model.CodeOKSold || seq != 2 {
		t.Fatalf("cap bid: code=%s seq=%d err=%v want OK_SOLD/2", code, seq, err)
	}
	snap, _ := s.Snapshot(ctx, aid)
	if snap.CurrentPriceCents != "20000" || snap.WinnerID != "u2" || snap.Status != model.StateSold {
		t.Fatalf("snapshot=%+v want price=20000 winner=u2 SOLD", snap)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
