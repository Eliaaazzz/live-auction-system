package server

import "testing"

// The demo-auction driver fires AUCTION_EXTENDED for BOTH bids only if every
// bid satisfies place_bid.lua's in-window check `(endAtMs - now) <= window`.
// Because the extend is ACCUMULATIVE (endAtMs += ExtendSec), the first snipe
// pushes endAtMs out, so the window must exceed the start duration PLUS all the
// extensions it can accumulate — otherwise the second bid lands outside the
// window and never extends (the exact flake this replaced). This fast guard
// pins that condition (+ the rules' basic validity) without a live stack.
func TestDemoRulesValidAndDeterministic(t *testing.T) {
	r := demoRules()
	if err := r.Validate(); err != nil {
		t.Fatalf("demo rules must be valid: %v", err)
	}
	windowMs := r.ExtendWindowSec * 1000
	// Worst case: bid lands at ~start (now≈start) after endAtMs was already
	// bumped by every extension → (endAtMs-now) ≈ duration + ExtendSec*MaxExt.
	maxReach := int64(demoDurationMs) + int64(demoExtendSec)*1000*int64(demoMaxExtensions)
	if int64(windowMs) < maxReach {
		t.Fatalf("anti-snipe window %dms < duration+extensions %dms — second-bid extension not deterministic",
			windowMs, maxReach)
	}
	if r.MaxExtensions <= 0 {
		t.Fatalf("MaxExtensions must be > 0 so the auction still hammers to SOLD (got %d)", r.MaxExtensions)
	}
	// The two demo bids (11000 then 12000) must each be a valid raise: the first
	// >= start+increment, the second >= first+increment.
	const firstBid, secondBid = 10000 + 1000, 10000 + 1000 + 1000
	if int64(r.StartPriceCents)+int64(r.IncrementCents) > firstBid {
		t.Fatalf("first demo bid %d below required raise %d", firstBid, int64(r.StartPriceCents)+int64(r.IncrementCents))
	}
	if firstBid+int64(r.IncrementCents) > secondBid {
		t.Fatalf("second demo bid %d below required raise over first", secondBid)
	}
}
