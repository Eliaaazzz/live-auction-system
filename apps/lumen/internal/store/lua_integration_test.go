package store

// Integration tests for the Redis Lua hot path (place_bid / freeze_rules /
// start_auction). They exercise the REAL scripts against a REAL Redis so the
// atomic adjudication, seq monotonicity and every return code are covered
// (V9 §9 "Lua harness covering every return code"; §4.1 correctness suite).
//
// They connect to REDIS_ADDR (default 127.0.0.1:6379) and t.Skip when Redis is
// unreachable, so `go test ./...` stays green on a bare machine. CI provides a
// redis service so these run as a real gate (.github/workflows/ci.yml).

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

var aidCounter int64

// sellerTestID is the auction owner used by liveAuction; tests bid as other ids,
// so the seller-self-bid guard never trips unless a test deliberately bids as it.
const sellerTestID = "seller_test"

func newTestStore(t *testing.T) *Store {
	t.Helper()
	addr := os.Getenv("REDIS_ADDR")
	if addr == "" {
		addr = "127.0.0.1:6379"
	}
	rdb := redis.NewClient(&redis.Options{Addr: addr})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		_ = rdb.Close()
		t.Skipf("redis not available at %s: %v (set REDIS_ADDR to run Lua integration tests)", addr, err)
	}
	s := &Store{rdb: rdb}
	if err := s.loadScripts(context.Background()); err != nil {
		_ = rdb.Close()
		t.Fatalf("load scripts: %v", err)
	}
	t.Cleanup(func() { _ = rdb.Close() })
	return s
}

func newAID(t *testing.T) string {
	t.Helper()
	aid := fmt.Sprintf("test_%d_%d", time.Now().UnixNano(), atomic.AddInt64(&aidCounter, 1))
	return aid
}

func cleanupAID(s *Store, aid string) {
	ctx := context.Background()
	keys, _ := s.rdb.Keys(ctx, "auction:{"+aid+"}:*").Result()
	if len(keys) > 0 {
		_ = s.rdb.Del(ctx, keys...).Err()
	}
}

// liveAuction freezes + starts a fresh auction and returns its id.
func liveAuction(t *testing.T, s *Store, r model.Rules, durationMs int64) string {
	t.Helper()
	ctx := context.Background()
	aid := newAID(t)
	t.Cleanup(func() { cleanupAID(s, aid) })
	if code, err := s.FreezeRules(ctx, aid, sellerTestID, r); err != nil || code != model.CodeOKFrozen {
		t.Fatalf("freeze: code=%s err=%v", code, err)
	}
	if code, _, err := s.StartAuction(ctx, aid, durationMs); err != nil || code != model.CodeOKLive {
		t.Fatalf("start: code=%s err=%v", code, err)
	}
	return aid
}

func defaultRules() model.Rules {
	return model.Rules{
		StartPriceCents: 10000, IncrementCents: 1000, CapPriceCents: 0,
		DurationSec: 0, ExtendWindowSec: 0, ExtendSec: 0,
	}
}

// --- happy path + seq ---

func TestPlaceBidAcceptAndMonotonicSeq(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000)

	code, seq, payload, err := s.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1")
	if err != nil || code != model.CodeOKAccepted || seq != 1 {
		t.Fatalf("first bid: code=%s seq=%d err=%v", code, seq, err)
	}
	if payload == "" {
		t.Fatal("expected non-empty ack payload")
	}
	code, seq, _, err = s.PlaceBid(ctx, aid, "u2", "cb2", "12000", "U2")
	if err != nil || code != model.CodeOKAccepted || seq != 2 {
		t.Fatalf("second bid: code=%s seq=%d err=%v", code, seq, err)
	}
	snap, _ := s.Snapshot(ctx, aid)
	if snap.CurrentPriceCents != "12000" || snap.WinnerID != "u2" || snap.Seq != 2 {
		t.Fatalf("snapshot=%+v", snap)
	}
}

// §4.1: same client_bid_id retry returns the byte-identical original ack (NOT an
// error), and has no side effect (price unchanged even with a higher amount).
func TestPlaceBidDuplicateReturnsOriginalAck(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000)

	code1, seq1, p1, err := s.PlaceBid(ctx, aid, "u1", "cbX", "11000", "U1")
	if err != nil || code1 != model.CodeOKAccepted || seq1 != 1 {
		t.Fatalf("orig: code=%s seq=%d err=%v", code1, seq1, err)
	}
	// retry with the SAME clientBidId but a different amount: must replay p1.
	code2, seq2, p2, err := s.PlaceBid(ctx, aid, "u1", "cbX", "99000", "U1")
	if err != nil {
		t.Fatal(err)
	}
	if code2 != model.CodeDuplicate {
		t.Fatalf("retry code=%s want DUPLICATE", code2)
	}
	if seq2 != 0 {
		t.Fatalf("duplicate seq=%d want 0 (store signals no new seq)", seq2)
	}
	if p2 != p1 {
		t.Fatalf("duplicate ack not byte-identical:\n orig=%s\n dup =%s", p1, p2)
	}
	snap, _ := s.Snapshot(ctx, aid)
	if snap.CurrentPriceCents != "11000" {
		t.Fatalf("duplicate mutated price: %s want 11000", snap.CurrentPriceCents)
	}
}

// --- rejections (each ERR_ return code) ---

func TestPlaceBidTooLowBelowIncrement(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000)
	// current=10000, increment=1000 => minAccept=11000; 10500 is too low.
	code, _, _, err := s.PlaceBid(ctx, aid, "u1", "cb1", "10500", "U1")
	if err != nil || code != model.CodeErrTooLow {
		t.Fatalf("code=%s err=%v want ERR_TOO_LOW", code, err)
	}
}

func TestPlaceBidTooLowOverCap(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	r := defaultRules()
	r.CapPriceCents = 20000
	aid := liveAuction(t, s, r, 60_000)
	// 25000 > cap(20000) => ERR_TOO_LOW (single namespace per error-codes.md).
	code, _, _, err := s.PlaceBid(ctx, aid, "u1", "cb1", "25000", "U1")
	if err != nil || code != model.CodeErrTooLow {
		t.Fatalf("code=%s err=%v want ERR_TOO_LOW", code, err)
	}
}

func TestPlaceBidNotLiveWhenScheduled(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := newAID(t)
	t.Cleanup(func() { cleanupAID(s, aid) })
	if code, err := s.FreezeRules(ctx, aid, sellerTestID, defaultRules()); err != nil || code != model.CodeOKFrozen {
		t.Fatalf("freeze: code=%s err=%v", code, err)
	}
	// SCHEDULED (not started) => bids rejected ERR_NOT_LIVE.
	code, _, _, err := s.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1")
	if err != nil || code != model.CodeErrNotLive {
		t.Fatalf("code=%s err=%v want ERR_NOT_LIVE", code, err)
	}
}

func TestPlaceBidAfterEnd(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	// Track far in the future, then force state.endAtMs into the past (same pattern as
	// the T3 hammer-race tests). Putting the past time only in state — not the active
	// index — means a Timer Worker from a concurrently-running server-package test won't
	// hammer this auction over shared Redis (its index score stays 60s out, so a close
	// would see ERR_NOT_DUE). Deterministic + no sleep.
	aid := liveAuction(t, s, defaultRules(), 60_000)
	if err := s.rdb.HSet(ctx, stateKey(aid), "endAtMs", 1).Err(); err != nil {
		t.Fatal(err)
	}
	code, _, _, err := s.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1")
	if err != nil || code != model.CodeErrAfterEnd {
		t.Fatalf("code=%s err=%v want ERR_AFTER_END", code, err)
	}
}

func TestPlaceBidPaused(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000)
	if err := s.rdb.HSet(ctx, stateKey(aid), "paused", "true").Err(); err != nil {
		t.Fatal(err)
	}
	code, _, _, err := s.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1")
	if err != nil || code != model.CodeErrPaused {
		t.Fatalf("code=%s err=%v want ERR_AUCTION_PAUSED", code, err)
	}
}

// type-guard fires before any mutation when a hot key has the wrong type.
func TestPlaceBidTypeGuard(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000)
	// poison the leaderboard key with a string (should be a ZSET).
	if err := s.rdb.Set(ctx, lbKey(aid), "not-a-zset", 0).Err(); err != nil {
		t.Fatal(err)
	}
	code, _, _, err := s.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1")
	if err != nil || code != model.CodeErrInternal {
		t.Fatalf("code=%s err=%v want ERR_INTERNAL", code, err)
	}
	// seq must NOT have advanced (validate-before-write).
	if seq, _ := s.rdb.HGet(ctx, stateKey(aid), "seq").Int64(); seq != 0 {
		t.Fatalf("type-guard mutated seq=%d want 0", seq)
	}
}

// --- anti-snipe (OK_EXTENDED) ---

func TestPlaceBidAntiSnipeExtends(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	r := defaultRules()
	r.ExtendWindowSec = 60 // any bid is within the window
	r.ExtendSec = 30
	aid := liveAuction(t, s, r, 2000) // endAtMs = now+2s, inside the 60s window
	before, _ := s.rdb.HGet(ctx, stateKey(aid), "endAtMs").Int64()

	code, seq, _, err := s.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1")
	if err != nil || code != model.CodeOKExtended || seq != 1 {
		t.Fatalf("code=%s seq=%d err=%v want OK_EXTENDED seq=1", code, seq, err)
	}
	after, _ := s.rdb.HGet(ctx, stateKey(aid), "endAtMs").Int64()
	if after != before+30_000 {
		t.Fatalf("endAtMs=%d want %d (before %d + 30000)", after, before+30_000, before)
	}
	if cnt, _ := s.rdb.HGet(ctx, stateKey(aid), "extendCount").Int64(); cnt != 1 {
		t.Fatalf("extendCount=%d want 1", cnt)
	}
	// stream carries BID_ACCEPTED(seq1) then AUCTION_EXTENDED(seq2), each <seq>-0.
	events, _, err := s.ReadEventsAfter(ctx, aid, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 ||
		events[0].Type != model.TypeBidAccepted || events[0].ID != "1-0" ||
		events[1].Type != model.TypeAuctionExtended || events[1].ID != "2-0" {
		t.Fatalf("stream=%+v", events)
	}
}

// --- cap-hit (OK_SOLD) ---

func TestPlaceBidCapHitSells(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	r := defaultRules()
	r.CapPriceCents = 50000
	aid := liveAuction(t, s, r, 60_000)

	code, seq, _, err := s.PlaceBid(ctx, aid, "u1", "cb1", "50000", "U1") // == cap
	if err != nil || code != model.CodeOKSold || seq != 1 {
		t.Fatalf("code=%s seq=%d err=%v want OK_SOLD seq=1", code, seq, err)
	}
	if st, _ := s.rdb.HGet(ctx, stateKey(aid), "status").Result(); st != model.StateSold {
		t.Fatalf("status=%s want SOLD", st)
	}
	// stream: BID_ACCEPTED(1-0) + AUCTION_SOLD(2-0).
	events, _, _ := s.ReadEventsAfter(ctx, aid, "")
	if len(events) != 2 ||
		events[0].Type != model.TypeBidAccepted || events[0].ID != "1-0" ||
		events[1].Type != model.TypeAuctionSold || events[1].ID != "2-0" {
		t.Fatalf("stream=%+v", events)
	}
	// terminal => further bids rejected ERR_NOT_LIVE.
	code, _, _, _ = s.PlaceBid(ctx, aid, "u2", "cb2", "60000", "U2")
	if code != model.CodeErrNotLive {
		t.Fatalf("post-SOLD bid code=%s want ERR_NOT_LIVE", code)
	}
}

// Anti-snipe respects maxExtensions: once the cap is hit, an in-window bid is a
// normal accept (no endAtMs bump, no AUCTION_EXTENDED) — bounds auction lifetime.
func TestPlaceBidAntiSnipeRespectsMaxExtensions(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	r := defaultRules()
	r.ExtendWindowSec, r.ExtendSec, r.MaxExtensions = 60, 30, 1 // any bid in-window, cap 1
	aid := liveAuction(t, s, r, 2000)

	// bid 1: in-window -> extends (extendCount 0 -> 1).
	if code, _, _, err := s.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1"); err != nil || code != model.CodeOKExtended {
		t.Fatalf("bid1 code=%s err=%v want OK_EXTENDED", code, err)
	}
	endAfter1, _ := s.rdb.HGet(ctx, stateKey(aid), "endAtMs").Int64()

	// bid 2: still in-window and higher, but the cap (1) is reached -> normal accept.
	code, _, _, err := s.PlaceBid(ctx, aid, "u2", "cb2", "12000", "U2")
	if err != nil || code != model.CodeOKAccepted {
		t.Fatalf("bid2 code=%s err=%v want OK_ACCEPTED (extension capped)", code, err)
	}
	endAfter2, _ := s.rdb.HGet(ctx, stateKey(aid), "endAtMs").Int64()
	if endAfter2 != endAfter1 {
		t.Fatalf("endAtMs moved past the extension cap: %d -> %d", endAfter1, endAfter2)
	}
	if cnt, _ := s.rdb.HGet(ctx, stateKey(aid), "extendCount").Int64(); cnt != 1 {
		t.Fatalf("extendCount=%d want 1 (capped)", cnt)
	}
	// stream: BID_ACCEPTED(1) AUCTION_EXTENDED(2) BID_ACCEPTED(3) — no 2nd extension event.
	events, _, _ := s.ReadEventsAfter(ctx, aid, "")
	if len(events) != 3 || events[1].Type != model.TypeAuctionExtended ||
		events[2].Type != model.TypeBidAccepted {
		t.Fatalf("stream=%+v want [BID_ACCEPTED AUCTION_EXTENDED BID_ACCEPTED]", events)
	}
}

// DUPLICATE retry after an extend replays the cached ack (which carries the
// already-extended endAtMs) and has NO side effect — it does not re-extend or
// re-emit AUCTION_EXTENDED. Recovery of the missed AUCTION_EXTENDED event is
// reconnect+catchup only (XRANGE replays both entries). (review #3)
func TestPlaceBidDuplicateAfterExtend(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	r := defaultRules()
	r.ExtendWindowSec, r.ExtendSec = 60, 30
	aid := liveAuction(t, s, r, 2000)

	_, _, origPayload, err := s.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1")
	if err != nil {
		t.Fatal(err)
	}
	endAfter, _ := s.rdb.HGet(ctx, stateKey(aid), "endAtMs").Int64()

	// retry same clientBidId -> DUPLICATE, byte-identical ack, no new events.
	code, _, dupPayload, err := s.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1")
	if err != nil || code != model.CodeDuplicate || dupPayload != origPayload {
		t.Fatalf("retry code=%s identical=%v err=%v", code, dupPayload == origPayload, err)
	}
	// the cached ack carries the EXTENDED endAtMs (not stale).
	var ack model.BidAcceptedData
	if err := json.Unmarshal([]byte(dupPayload), &ack); err != nil {
		t.Fatal(err)
	}
	if ack.EndAtMs != endAfter {
		t.Fatalf("dup ack endAtMs=%d want extended %d", ack.EndAtMs, endAfter)
	}
	// no re-extend, no new stream entry.
	if cnt, _ := s.rdb.HGet(ctx, stateKey(aid), "extendCount").Int64(); cnt != 1 {
		t.Fatalf("extendCount=%d want 1 (retry must not re-extend)", cnt)
	}
	if events, _, _ := s.ReadEventsAfter(ctx, aid, ""); len(events) != 2 {
		t.Fatalf("stream len=%d want 2 (BID_ACCEPTED + AUCTION_EXTENDED, no dup side effects)", len(events))
	}
}

// --- concurrency: seq strictly monotonic, no gap, no dup ---

func TestPlaceBidConcurrentSeqNoGap(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000) // no cap, no extend => 1 event/accept

	const N = 64
	var wg sync.WaitGroup
	var mu sync.Mutex
	accepted := make([]int64, 0, N)
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			uid := fmt.Sprintf("u%d", i)
			amt := strconv.Itoa(11000 + i*1000) // distinct, increasing
			code, seq, _, err := s.PlaceBid(ctx, aid, uid, "cb_"+uid, amt, uid)
			if err != nil {
				t.Errorf("bid %d err: %v", i, err)
				return
			}
			if code == model.CodeOKAccepted {
				mu.Lock()
				accepted = append(accepted, seq)
				mu.Unlock()
			}
		}(i)
	}
	wg.Wait()

	if len(accepted) == 0 {
		t.Fatal("no bids accepted")
	}
	sort.Slice(accepted, func(a, b int) bool { return accepted[a] < accepted[b] })
	for i, sq := range accepted { // contiguous 1..K, no gap, no dup
		if sq != int64(i+1) {
			t.Fatalf("seq gap/dup: %v (index %d = %d)", accepted, i, sq)
		}
	}
	// stream length == accepted count; ids are <seq>-0 monotonic.
	events, _, err := s.ReadEventsAfter(ctx, aid, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != len(accepted) {
		t.Fatalf("stream len %d != accepted %d", len(events), len(accepted))
	}
	for i, e := range events {
		if e.Seq != int64(i+1) || e.ID != fmt.Sprintf("%d-0", e.Seq) || e.Type != model.TypeBidAccepted {
			t.Fatalf("event[%d]=%+v", i, e)
		}
	}
}

// Contended ladder: N bidders each retry (read price → bid price+increment)
// until they land exactly one accepted bid. Unlike the distinct-amount stampede
// (where most lose to a higher price and only a few accept), this guarantees N
// acceptances under heavy contention and proves the seq is a gap-free 1..N with
// no duplicates — the core §4.1 invariant "under concurrency".
func TestPlaceBidContendedLadderNoGap(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000) // no cap, no extend

	const N = 40
	var wg sync.WaitGroup
	var mu sync.Mutex
	seqs := make([]int64, 0, N)
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			uid := fmt.Sprintf("u%d", i)
			for attempt := 0; attempt < 500; attempt++ {
				snap, err := s.Snapshot(ctx, aid)
				if err != nil {
					t.Errorf("snapshot: %v", err)
					return
				}
				price := parseInt(snap.CurrentPriceCents)
				amt := strconv.FormatInt(price+1000, 10) // current + increment
				cb := fmt.Sprintf("cb_%s_%d", uid, attempt)
				code, seq, _, err := s.PlaceBid(ctx, aid, uid, cb, amt, uid)
				if err != nil {
					t.Errorf("bid: %v", err)
					return
				}
				if code == model.CodeOKAccepted {
					mu.Lock()
					seqs = append(seqs, seq)
					mu.Unlock()
					return
				}
				// ERR_TOO_LOW: another bidder raised the price first — retry.
			}
			t.Errorf("%s never landed an accepted bid", uid)
		}(i)
	}
	wg.Wait()

	if len(seqs) != N {
		t.Fatalf("accepted %d bids, want %d", len(seqs), N)
	}
	sort.Slice(seqs, func(a, b int) bool { return seqs[a] < seqs[b] })
	for i, sq := range seqs { // strict 1..N, no gap, no duplicate
		if sq != int64(i+1) {
			t.Fatalf("seq gap/dup at index %d: got %d, want %d (all=%v)", i, sq, i+1, seqs)
		}
	}
	// final price = startPrice + N*increment; stream has exactly N BID_ACCEPTED.
	snap, _ := s.Snapshot(ctx, aid)
	if want := strconv.Itoa(10000 + N*1000); snap.CurrentPriceCents != want {
		t.Fatalf("final price=%s want %s", snap.CurrentPriceCents, want)
	}
	events, _, _ := s.ReadEventsAfter(ctx, aid, "")
	if len(events) != N {
		t.Fatalf("stream len=%d want %d", len(events), N)
	}
}

// Same-amount stampede: exactly one bid wins at a price level; the rest are
// ERR_TOO_LOW. Proves atomic adjudication (no double-accept at the same price).
func TestPlaceBidConcurrentSameAmountSingleWinner(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000)

	const N = 32
	var wg sync.WaitGroup
	var accepted, tooLow int64
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			uid := fmt.Sprintf("u%d", i)
			code, _, _, err := s.PlaceBid(ctx, aid, uid, "cb_"+uid, "11000", uid)
			if err != nil {
				t.Errorf("bid %d err: %v", i, err)
				return
			}
			switch code {
			case model.CodeOKAccepted:
				atomic.AddInt64(&accepted, 1)
			case model.CodeErrTooLow:
				atomic.AddInt64(&tooLow, 1)
			default:
				t.Errorf("unexpected code %s", code)
			}
		}(i)
	}
	wg.Wait()
	if accepted != 1 || tooLow != N-1 {
		t.Fatalf("accepted=%d tooLow=%d want 1/%d", accepted, tooLow, N-1)
	}
	if seq, _ := s.rdb.HGet(ctx, stateKey(aid), "seq").Int64(); seq != 1 {
		t.Fatalf("seq=%d want 1 (single accept)", seq)
	}
}

// --- leaderboard ---

func TestLeaderboardTopN(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000)
	// u1: 11000 then 13000 (max 13000); u2: 12000.
	s.PlaceBid(ctx, aid, "u1", "a1", "11000", "U1")
	s.PlaceBid(ctx, aid, "u2", "a2", "12000", "U2")
	s.PlaceBid(ctx, aid, "u1", "a3", "13000", "U1")

	lb, err := s.Leaderboard(ctx, aid, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(lb) != 2 {
		t.Fatalf("leaderboard len=%d want 2: %+v", len(lb), lb)
	}
	if lb[0].UserID != "u1" || lb[0].AmountCents != "13000" {
		t.Fatalf("top=%+v want u1/13000", lb[0])
	}
	if lb[1].UserID != "u2" || lb[1].AmountCents != "12000" {
		t.Fatalf("second=%+v want u2/12000", lb[1])
	}
}

// --- Pub/Sub fanout payloads (the wire the gateway subscriber consumes) ---

func subscribePub(t *testing.T, s *Store, aid string) <-chan *redis.Message {
	t.Helper()
	ctx := context.Background()
	sub := s.rdb.Subscribe(ctx, PubChannel(aid))
	if _, err := sub.Receive(ctx); err != nil { // wait for subscribe confirmation
		t.Fatalf("subscribe: %v", err)
	}
	t.Cleanup(func() { _ = sub.Close() })
	return sub.Channel()
}

func collectPubs(t *testing.T, ch <-chan *redis.Message, n int) []model.PubMessage {
	t.Helper()
	out := make([]model.PubMessage, 0, n)
	deadline := time.After(2 * time.Second)
	for len(out) < n {
		select {
		case msg := <-ch:
			var pm model.PubMessage
			if err := json.Unmarshal([]byte(msg.Payload), &pm); err != nil {
				t.Fatalf("bad pub payload %q: %v", msg.Payload, err)
			}
			out = append(out, pm)
		case <-deadline:
			t.Fatalf("timed out: got %d/%d pub messages", len(out), n)
		}
	}
	return out
}

func TestPlaceBidPublishesBidAccepted(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := liveAuction(t, s, defaultRules(), 60_000)
	ch := subscribePub(t, s, aid)
	if code, _, _, err := s.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1"); err != nil || code != model.CodeOKAccepted {
		t.Fatalf("code=%s err=%v", code, err)
	}
	got := collectPubs(t, ch, 1)
	// the pub seq must match the Stream seq so the client seq-guard stays in sync.
	if got[0].Type != model.TypeBidAccepted || got[0].Seq != 1 {
		t.Fatalf("pub[0]=%+v want BID_ACCEPTED seq=1", got[0])
	}
}

func TestPlaceBidPublishesExtended(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	r := defaultRules()
	r.ExtendWindowSec, r.ExtendSec = 60, 30
	aid := liveAuction(t, s, r, 2000)
	ch := subscribePub(t, s, aid)
	if code, _, _, err := s.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1"); err != nil || code != model.CodeOKExtended {
		t.Fatalf("code=%s err=%v", code, err)
	}
	got := collectPubs(t, ch, 2)
	if got[0].Type != model.TypeBidAccepted || got[0].Seq != 1 {
		t.Fatalf("pub[0]=%+v want BID_ACCEPTED seq=1", got[0])
	}
	// the extension event consumes its own seq (gap-free monotonic log).
	if got[1].Type != model.TypeAuctionExtended || got[1].Seq != 2 {
		t.Fatalf("pub[1]=%+v want AUCTION_EXTENDED seq=2", got[1])
	}
}

func TestPlaceBidPublishesSold(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	r := defaultRules()
	r.CapPriceCents = 50000
	aid := liveAuction(t, s, r, 60_000)
	ch := subscribePub(t, s, aid)
	if code, _, _, err := s.PlaceBid(ctx, aid, "u1", "cb1", "50000", "U1"); err != nil || code != model.CodeOKSold {
		t.Fatalf("code=%s err=%v", code, err)
	}
	got := collectPubs(t, ch, 2)
	if got[0].Type != model.TypeBidAccepted || got[0].Seq != 1 {
		t.Fatalf("pub[0]=%+v want BID_ACCEPTED seq=1", got[0])
	}
	if got[1].Type != model.TypeAuctionSold || got[1].Seq != 2 {
		t.Fatalf("pub[1]=%+v want AUCTION_SOLD seq=2", got[1])
	}
}

// --- freeze / start return codes (Lua harness completeness) ---

func TestFreezeStartReturnCodes(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	aid := newAID(t)
	t.Cleanup(func() { cleanupAID(s, aid) })

	if code, err := s.FreezeRules(ctx, aid, sellerTestID, defaultRules()); err != nil || code != model.CodeOKFrozen {
		t.Fatalf("freeze fresh: code=%s err=%v", code, err)
	}
	// freezing again (now SCHEDULED) is illegal.
	if code, err := s.FreezeRules(ctx, aid, sellerTestID, defaultRules()); err != nil || code != model.CodeErrBadState {
		t.Fatalf("re-freeze: code=%s err=%v want ERR_BAD_STATE", code, err)
	}
	if code, _, err := s.StartAuction(ctx, aid, 60_000); err != nil || code != model.CodeOKLive {
		t.Fatalf("start: code=%s err=%v", code, err)
	}
	// starting again (now LIVE) is illegal.
	if code, _, err := s.StartAuction(ctx, aid, 60_000); err != nil || code != model.CodeErrBadState {
		t.Fatalf("re-start: code=%s err=%v want ERR_BAD_STATE", code, err)
	}
}
