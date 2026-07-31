package server

import (
	"testing"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

// TestNormalizeRulesBoundsInfiniteAntiSnipe is the regression for spec deep-review
// rule 4 ("auto-extension needs an upper bound so it cannot run forever"): the engine treats MaxExtensions==0 as
// UNLIMITED, so an anti-snipe auction created without a cap could extend forever.
// NormalizeRules must inject a finite cap when anti-snipe is on but the cap is
// left open — and must NOT touch off/already-capped configs.
func TestNormalizeRulesBoundsInfiniteAntiSnipe(t *testing.T) {
	eng := baseMode{model.ModeEnglish}

	t.Run("anti-snipe ON + maxExtensions 0 gets a finite cap", func(t *testing.T) {
		out := eng.NormalizeRules(model.Rules{ExtendWindowSec: 30, ExtendSec: 10, MaxExtensions: 0})
		if out.MaxExtensions != antiSnipeMaxExtensionsDefault {
			t.Fatalf("MaxExtensions=%d, want %d (infinite extension must be bounded)", out.MaxExtensions, antiSnipeMaxExtensionsDefault)
		}
		// resulting rules must be valid + finite
		if out.MaxExtensions <= 0 {
			t.Fatal("bounded auction must have MaxExtensions > 0")
		}
	})

	t.Run("explicit maxExtensions is preserved (no shrink of operator choice)", func(t *testing.T) {
		out := eng.NormalizeRules(model.Rules{ExtendWindowSec: 30, ExtendSec: 10, MaxExtensions: 3})
		if out.MaxExtensions != 3 {
			t.Fatalf("MaxExtensions=%d, want 3 preserved", out.MaxExtensions)
		}
	})

	t.Run("anti-snipe OFF leaves maxExtensions 0 (no extensions happen anyway)", func(t *testing.T) {
		out := eng.NormalizeRules(model.Rules{ExtendWindowSec: 0, ExtendSec: 0, MaxExtensions: 0})
		if out.MaxExtensions != 0 {
			t.Fatalf("MaxExtensions=%d, want 0 when anti-snipe disabled", out.MaxExtensions)
		}
		// window without seconds (or vice versa) = anti-snipe effectively off → no cap
		half := eng.NormalizeRules(model.Rules{ExtendWindowSec: 30, ExtendSec: 0, MaxExtensions: 0})
		if half.MaxExtensions != 0 {
			t.Fatalf("MaxExtensions=%d, want 0 when extendSec=0", half.MaxExtensions)
		}
	})

	t.Run("sudden death disables anti-snipe so no cap is injected", func(t *testing.T) {
		sd := suddenDeathMode{baseMode{model.ModeSuddenDeath}}
		out := sd.NormalizeRules(model.Rules{ExtendWindowSec: 30, ExtendSec: 10, MaxExtensions: 0})
		if out.ExtendWindowSec != 0 || out.ExtendSec != 0 {
			t.Fatalf("sudden death must zero anti-snipe, got window=%d sec=%d", out.ExtendWindowSec, out.ExtendSec)
		}
		if out.MaxExtensions != 0 {
			t.Fatalf("MaxExtensions=%d, want 0 (anti-snipe off → never extends)", out.MaxExtensions)
		}
	})

	t.Run("bounded result passes Validate", func(t *testing.T) {
		out := eng.NormalizeRules(model.Rules{
			Mode: model.ModeEnglish, StartPriceCents: 0, IncrementCents: 50000,
			DurationSec: 1800, ExtendWindowSec: 30, ExtendSec: 10, MaxExtensions: 0,
		})
		if err := out.Validate(); err != nil {
			t.Fatalf("normalized rules must validate: %v", err)
		}
	})
}
