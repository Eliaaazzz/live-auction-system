package server

import (
	"testing"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

// Table-driven mode recommender (issue #114). Pure-Go heuristic, no I/O — locks
// the rule semantics so a future tweak that drifts (e.g. high-value collectible
// no longer maps to Vickrey) fails this fast guard.
func TestRecommendMode(t *testing.T) {
	cases := []struct {
		name      string
		viewers   int
		value     int64
		category  string
		wantMode  string
		wantInAlt string // a string the alternatives list MUST contain
	}{
		{"high-value collectible -> Vickrey", 10, 100_000_00, "collectible", model.ModeVickrey, model.ModeSealedFirst},
		{"high-value pokemon -> Vickrey", 5, 80_000_00, "pokemon", model.ModeVickrey, model.ModeSealedFirst},
		{"high-value non-collectible -> SealedFirst", 5, 100_000_00, "everyday", model.ModeSealedFirst, model.ModeVickrey},
		{"crowded room, modest value -> English", 200, 5_000, "", model.ModeEnglish, model.ModeSuddenDeath},
		{"quiet room, modest value -> SuddenDeath", 3, 5_000, "", model.ModeSuddenDeath, model.ModeEnglish},
		{"empty inputs default to SuddenDeath bucket", 0, 0, "", model.ModeSuddenDeath, model.ModeEnglish},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := recommendMode(c.viewers, c.value, c.category)
			if r.RecommendedMode != c.wantMode {
				t.Fatalf("mode = %q, want %q (rationale: %s)", r.RecommendedMode, c.wantMode, r.Rationale)
			}
			if r.Rationale == "" {
				t.Errorf("rationale must be non-empty")
			}
			found := false
			for _, a := range r.Alternatives {
				if a == c.wantInAlt {
					found = true
					break
				}
			}
			if !found {
				t.Errorf("alternatives %v missing expected %q", r.Alternatives, c.wantInAlt)
			}
		})
	}
}

// Validate every recommendation returns an ENABLED mode (one modeFor accepts) —
// the recommender must never suggest a not-yet-built mode.
func TestRecommendModeAlwaysEnabled(t *testing.T) {
	for _, c := range []struct {
		viewers  int
		value    int64
		category string
	}{
		{1, 1, ""},
		{200, 100_000_00, "collectible"},
		{0, 1_000_000_000, "art"},
		{1000, 1, "luxury"},
	} {
		r := recommendMode(c.viewers, c.value, c.category)
		if _, ok := modeFor(r.RecommendedMode); !ok {
			t.Errorf("recommender returned not-yet-enabled mode %q for (viewers=%d, value=%d, cat=%q)",
				r.RecommendedMode, c.viewers, c.value, c.category)
		}
	}
}
