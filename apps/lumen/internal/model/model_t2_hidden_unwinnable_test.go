package model

import "testing"

// Hidden regression test for PR #26 T2 atomic bid core.
//
// capPriceCents == 0 means "no buy-now ceiling". In that mode place_bid.lua
// computes the first required bid as startPriceCents + incrementCents, while the
// gateway/Lua both reject any amount above MaxMoneyCents. So a no-cap auction
// whose first required bid exceeds MaxMoneyCents is unwinnable and must be
// rejected at rule validation time.
func TestT2HiddenRulesRejectNoCapFirstBidAboveMaxMoney(t *testing.T) {
	r := Rules{
		StartPriceCents: MaxMoneyCents,
		IncrementCents:  1,
		CapPriceCents:   0,
		DurationSec:     60,
	}
	if err := r.Validate(); err == nil {
		t.Fatalf("Validate accepted unwinnable no-cap rules: first required bid is MaxMoneyCents+1")
	}
}

// A cap may legitimately clamp the first required bid down to MaxMoneyCents.
// This prevents the validation fix from accidentally reintroducing the older
// too-strict cap >= start+increment rule that PR #26 intentionally relaxed.
func TestT2HiddenRulesAllowCapToClampFirstBidAtMaxMoney(t *testing.T) {
	r := Rules{
		StartPriceCents: MaxMoneyCents - 10,
		IncrementCents:  1000,
		CapPriceCents:   MaxMoneyCents,
		DurationSec:     60,
	}
	if err := r.Validate(); err != nil {
		t.Fatalf("cap-aware rules should be valid because cap clamps first required bid to MaxMoneyCents: %v", err)
	}
}
