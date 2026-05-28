package server

import "testing"

// The demo-auction driver's anti-snipe trigger is only deterministic if the
// whole auction sits inside the anti-snipe window — otherwise a bid placed at
// t=0 could fall outside the tail window and never extend, making the live demo
// flaky. This fast guard pins that invariant (and the rules' basic validity) so
// a future tweak to the demo knobs can't silently break the demo path.
func TestDemoRulesValidAndDeterministic(t *testing.T) {
	r := demoRules()
	if err := r.Validate(); err != nil {
		t.Fatalf("demo rules must be valid: %v", err)
	}
	windowMs := r.ExtendWindowSec * 1000
	if windowMs < demoDurationMs {
		t.Fatalf("anti-snipe window %dms < start duration %dms — first-bid extension not deterministic",
			windowMs, demoDurationMs)
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
