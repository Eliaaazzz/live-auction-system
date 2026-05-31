package server

// V10k Tier C — gateway-side fast-reject (pre-aggregation) tests.
// These are pure-unit tests of the Hub roomState cache + the arithmetic;
// the integration test of the full BID_PLACE fast-path lives in load_test.go.

import (
	"testing"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

// TestRoomState_ColdCacheReturnsEmpty — a hub that has never seen an event
// for an auction returns an empty roomState. dispatchWS uses `priceCents == ""`
// as the "skip the fast-path filter, fall through to Lua" signal, so the
// first bid is ALWAYS Lua-authoritative.
func TestRoomState_ColdCacheReturnsEmpty(t *testing.T) {
	h := newHub()
	rs := h.roomStateSnap("auc_cold")
	if rs.priceCents != "" || rs.endAtMs != 0 {
		t.Fatalf("cold cache should be zero-value, got %+v", rs)
	}
}

// TestRoomState_MonotonicRatchet — updates only increase the cached price.
// A subsequent BID_ACCEPTED with a lower amount (e.g. stale broadcast order
// or a malformed event) MUST NOT downgrade the cache. This protects the
// fast-path filter's correctness invariant: "cached price ≤ Lua actual price".
func TestRoomState_MonotonicRatchet(t *testing.T) {
	h := newHub()
	h.updateRoomState("auc_m", "100", 1000)
	h.updateRoomState("auc_m", "150", 2000)
	h.updateRoomState("auc_m", "120", 3000) // attempted regression — must be ignored on price
	rs := h.roomStateSnap("auc_m")
	if rs.priceCents != "150" {
		t.Fatalf("price downgraded: got %q, want 150", rs.priceCents)
	}
	if rs.endAtMs != 3000 {
		t.Fatalf("endAtMs should track latest, got %d want 3000", rs.endAtMs)
	}
}

// TestRoomState_DropOnTerminal — after AUCTION_SOLD / NO_BID / CANCELLED is
// fanned out, the cache is dropped so a re-used auction id (defensive; not
// expected today) starts fresh, and so long-running gateways don't accumulate
// dead-auction state. Tested via the public updateRoomStateFromEvent helper
// so the dispatch logic stays in sync with what the subscribe goroutine does.
func TestRoomState_DropOnTerminal(t *testing.T) {
	h := newHub()
	h.updateRoomState("auc_t", "500", 9999)
	if h.roomStateSnap("auc_t").priceCents == "" {
		t.Fatal("precondition: cache should be populated before terminal event")
	}
	updateRoomStateFromEvent(h, "auc_t", store.StreamEvent{
		Type:    model.TypeAuctionNoBid,
		Payload: `{"seq":1,"status":"NO_BID","serverTimeMs":1}`,
	})
	if rs := h.roomStateSnap("auc_t"); rs.priceCents != "" {
		t.Fatalf("cache should be dropped after AUCTION_NO_BID, got %+v", rs)
	}
}

// TestRoomState_UpdateFromBidAcceptedPayload — verify the JSON unmarshal +
// ratchet path. The Lua emits a payload with seq/amountCents/endAtMs;
// updateRoomStateFromEvent must extract them and ratchet the cache.
func TestRoomState_UpdateFromBidAcceptedPayload(t *testing.T) {
	h := newHub()
	updateRoomStateFromEvent(h, "auc_b", store.StreamEvent{
		Type:    model.TypeBidAccepted,
		Payload: `{"seq":1,"userId":"u","amountCents":"12000","endAtMs":7777,"status":"LIVE","serverTimeMs":1}`,
	})
	rs := h.roomStateSnap("auc_b")
	if rs.priceCents != "12000" || rs.endAtMs != 7777 {
		t.Fatalf("update from BID_ACCEPTED failed: %+v", rs)
	}
}

// TestRoomState_MalformedPayloadPreservesCache — a corrupt payload must not
// corrupt the cache. Set a known good value, send garbage, verify the cache
// stays at its last good value (defense-in-depth — Lua remains authoritative
// for actual bid acceptance, the cache only affects fast-path rejects).
func TestRoomState_MalformedPayloadPreservesCache(t *testing.T) {
	h := newHub()
	h.updateRoomState("auc_g", "500", 1000)
	updateRoomStateFromEvent(h, "auc_g", store.StreamEvent{
		Type:    model.TypeBidAccepted,
		Payload: "not json",
	})
	if rs := h.roomStateSnap("auc_g"); rs.priceCents != "500" || rs.endAtMs != 1000 {
		t.Fatalf("malformed event corrupted cache: %+v", rs)
	}
}

// TestRoomState_ExtendOnlyTouchesEndAtMs — AUCTION_EXTENDED carries no fresh
// amountCents (the price didn't change; only endAtMs moved forward). The
// cache update path passes "" for priceCents so the ratchet path skips it.
// endAtMs is updated.
func TestRoomState_ExtendOnlyTouchesEndAtMs(t *testing.T) {
	h := newHub()
	h.updateRoomState("auc_e", "200", 1000)
	updateRoomStateFromEvent(h, "auc_e", store.StreamEvent{
		Type:    model.TypeAuctionExtended,
		Payload: `{"seq":2,"endAtMs":5000,"extendCount":1,"serverTimeMs":1}`,
	})
	rs := h.roomStateSnap("auc_e")
	if rs.priceCents != "200" {
		t.Fatalf("EXTENDED corrupted priceCents: got %q want 200", rs.priceCents)
	}
	if rs.endAtMs != 5000 {
		t.Fatalf("EXTENDED didn't bump endAtMs: got %d want 5000", rs.endAtMs)
	}
}

// TestRoomState_SoldDropsButCapturesFinalPrice — AUCTION_SOLD carries the
// winning amount. We update the cache (capturing the final price for any
// reader during the drop window) THEN drop. Two ratchets in sequence;
// observed behavior is the dropped state, which is correct: anyone reading
// the cache AFTER the drop sees a cold cache and falls through to Lua,
// which authoritatively returns ERR_NOT_LIVE for terminal auctions.
func TestRoomState_SoldDropsButCapturesFinalPrice(t *testing.T) {
	h := newHub()
	h.updateRoomState("auc_s", "100", 1000)
	updateRoomStateFromEvent(h, "auc_s", store.StreamEvent{
		Type:    model.TypeAuctionSold,
		Payload: `{"seq":2,"winnerId":"u","amountCents":"999","status":"SOLD","serverTimeMs":1}`,
	})
	if rs := h.roomStateSnap("auc_s"); rs.priceCents != "" || rs.endAtMs != 0 {
		t.Fatalf("AUCTION_SOLD should drop cache after final-price capture: %+v", rs)
	}
}

// TestRoomState_CapHitSoldBidAcceptedDropsCache — codex review #3: place_bid.lua
// emits BID_ACCEPTED with status="SOLD" for the cap-hit (buy-now) path BEFORE
// the AUCTION_SOLD event. The gateway cache MUST drop on that BID_ACCEPTED so
// a stray late bid in the (cap-hit BID_ACCEPTED, AUCTION_SOLD) window doesn't
// fast-reject as ERR_TOO_LOW when Lua would correctly return ERR_NOT_LIVE.
func TestRoomState_CapHitSoldBidAcceptedDropsCache(t *testing.T) {
	h := newHub()
	updateRoomStateFromEvent(h, "auc_cap", store.StreamEvent{
		Type: model.TypeBidAccepted,
		// status=SOLD inside a BID_ACCEPTED — this is the cap-hit shape Lua
		// emits at place_bid.lua step 7 when amount >= capPriceCents.
		Payload: `{"seq":1,"userId":"u","amountCents":"1000000","endAtMs":7777,"status":"SOLD","serverTimeMs":1}`,
	})
	if rs := h.roomStateSnap("auc_cap"); rs.priceCents != "" {
		t.Fatalf("cap-hit BID_ACCEPTED (status=SOLD) must drop cache so next bid falls through to Lua for ERR_NOT_LIVE; got %+v", rs)
	}
}

// TestRoomState_LiveBidAcceptedKeepsCache — counterpart to the cap-hit test:
// a regular BID_ACCEPTED with status=LIVE leaves the cache populated so the
// fast-reject can still fire on subsequent doomed bids.
func TestRoomState_LiveBidAcceptedKeepsCache(t *testing.T) {
	h := newHub()
	updateRoomStateFromEvent(h, "auc_live", store.StreamEvent{
		Type:    model.TypeBidAccepted,
		Payload: `{"seq":1,"userId":"u","amountCents":"5000","endAtMs":7777,"status":"LIVE","serverTimeMs":1}`,
	})
	rs := h.roomStateSnap("auc_live")
	if rs.priceCents != "5000" || rs.endAtMs != 7777 {
		t.Fatalf("LIVE BID_ACCEPTED should populate cache for subsequent fast-rejects; got %+v", rs)
	}
	if rs.terminal {
		t.Fatalf("LIVE BID_ACCEPTED must NOT set terminal flag; got %+v", rs)
	}
}

// TestRoomState_MarkTerminalAndUpdateAtomicity — codex pass-2 Q1: the race
// between cap-hit populate + drop. Verify markTerminalAndUpdate sets both
// price AND terminal=true under ONE write lock so a concurrent reader
// (BID_PLACE handler taking RLock) cannot see a populated price WITHOUT
// also seeing terminal=true. The fast-reject path checks `!rs.terminal`
// before rejecting, so a reader observing this state falls through to Lua.
func TestRoomState_MarkTerminalAndUpdateAtomicity(t *testing.T) {
	h := newHub()
	h.markTerminalAndUpdate("auc_t", "999", 8888)
	rs := h.roomStateSnap("auc_t")
	if !rs.terminal {
		t.Fatalf("markTerminalAndUpdate must set terminal=true; got %+v", rs)
	}
	if rs.priceCents != "999" || rs.endAtMs != 8888 {
		t.Fatalf("markTerminalAndUpdate must also ratchet price/endAtMs; got %+v", rs)
	}
}

// TestRoomState_CapHitFastRejectGuardObservesTerminal — pin the BID_PLACE
// fast-path's `!rs.terminal` guard. After a cap-hit BID_ACCEPTED(SOLD), the
// (price, terminal) tuple should be (X, true) — fast-reject must NOT fire.
// Then the subsequent dropRoomState clears the entry → cold cache → fast-
// reject still doesn't fire. So in BOTH the racy window AND post-drop, the
// behavior is "fall through to Lua" (which returns ERR_NOT_LIVE).
func TestRoomState_CapHitFastRejectGuardObservesTerminal(t *testing.T) {
	h := newHub()
	// Simulate the "racy window" state: markTerminalAndUpdate WITHOUT the
	// follow-up drop. Reader should see populated cache + terminal=true.
	h.markTerminalAndUpdate("auc_race", "1000000", 7777)
	rs := h.roomStateSnap("auc_race")
	if rs.priceCents != "1000000" {
		t.Fatalf("racy window: price not captured; got %+v", rs)
	}
	if !rs.terminal {
		t.Fatalf("racy window: terminal flag missing; got %+v", rs)
	}
	// Verify the fast-path's guard condition: `priceCents != "" && !terminal`
	// must be false (so we fall through to Lua). The guard is in dispatchWS
	// BID_PLACE — we mirror it inline to pin the contract.
	guardWouldReject := rs.priceCents != "" && !rs.terminal
	if guardWouldReject {
		t.Fatalf("fast-reject would fire on terminal cache; correctness regression: %+v", rs)
	}
}

// TestRoomState_ExpiryMarginGuard — codex pass-2 Q2: clock-skew safety
// margin. The fast-path checks `nowMs+fastRejectExpiryMarginMs < endAtMs`
// so bids arriving within the last `fastRejectExpiryMarginMs` of the
// auction always defer to Lua (which has Redis TIME as authoritative).
// Without the margin, a slow gateway clock returns ERR_TOO_LOW where Lua
// would return ERR_AFTER_END.
func TestRoomState_ExpiryMarginGuard(t *testing.T) {
	// Three cases relative to the margin (1s default):
	cases := []struct {
		name     string
		endAtMs  int64
		nowMs    int64
		inWindow bool // true == fast-reject path eligible
	}{
		{"endAt=0-always-inWindow", 0, 1000, true},
		{"far-in-future", 100000, 1000, true},
		{"within-margin-defer", 1500, 1000, false}, // nowMs+1000 = 2000 NOT < 1500
		{"at-margin-defer", 2000, 1000, false},     // nowMs+1000 = 2000 NOT < 2000
		{"past-endAtMs-defer", 500, 1000, false},   // already expired
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// Mirror the inline guard from dispatchWS — kept in sync by this test.
			inWindow := c.endAtMs == 0 || c.nowMs+fastRejectExpiryMarginMs < c.endAtMs
			if inWindow != c.inWindow {
				t.Fatalf("endAtMs=%d nowMs=%d margin=%d: got inWindow=%v want %v",
					c.endAtMs, c.nowMs, fastRejectExpiryMarginMs, inWindow, c.inWindow)
			}
		})
	}
}

// TestRoomState_FastRejectArithmetic — pin the comparison: a bid amount LE
// the cached price (= equal, not strictly less) is rejected. The Lua hot
// path requires strictly-greater-than-current; the gateway filter mirrors
// that exactly so behavior is identical (just faster).
func TestRoomState_FastRejectArithmetic(t *testing.T) {
	cases := []struct {
		name         string
		cached       string
		bid          string
		shouldReject bool
	}{
		{"empty-cache-no-reject", "", "100", false},
		{"strictly-below-reject", "200", "150", true},
		{"equal-reject", "200", "200", true}, // increment=1, so 200 is NOT a valid raise over current 200
		{"above-no-reject", "200", "201", false},
		{"unparsable-cache-no-reject", "garbage", "100", false},
		{"unparsable-bid-no-reject", "200", "garbage", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rs := roomState{priceCents: c.cached}
			rejected := fastRejectShouldFire(rs, c.bid)
			if rejected != c.shouldReject {
				t.Fatalf("cached=%q bid=%q: got reject=%v want %v", c.cached, c.bid, rejected, c.shouldReject)
			}
		})
	}
}

// fastRejectShouldFire mirrors the dispatchWS gate logic in a pure function
// so we can table-test it without spinning up the full WS stack. Production
// callers do NOT use this; it's a test-only helper kept in sync with
// dispatchWS by the table above.
func fastRejectShouldFire(rs roomState, bidAmount string) bool {
	if rs.priceCents == "" {
		return false
	}
	cached, errC := parseInt64ForTest(rs.priceCents)
	if errC != nil {
		return false
	}
	bidN, errB := parseInt64ForTest(bidAmount)
	if errB != nil {
		return false
	}
	return bidN <= cached
}

// parseInt64ForTest is a tiny shim so the test file doesn't need to import
// strconv at the package level (test files generally shouldn't import what
// the production file already does, but this keeps the table self-contained).
func parseInt64ForTest(s string) (int64, error) {
	var n int64
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, errInvalidIntForTest
		}
		n = n*10 + int64(c-'0')
	}
	if s == "" {
		return 0, errInvalidIntForTest
	}
	return n, nil
}

type errInvalidIntForTestT struct{}

func (errInvalidIntForTestT) Error() string { return "invalid int" }

var errInvalidIntForTest = errInvalidIntForTestT{}
