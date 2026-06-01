package server

import (
	"testing"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

// The registry-gate (PR #117 review) — modeFor MUST return ok=false for any
// mode that is a valid contract value but not yet runnable, so
// handleCreateAuction rejects it with 400 instead of silently running ENGLISH.
// Locks the contract today: PREQUALIFY is the parent-link workflow (sealed +
// spawn-formal), not a directly creatable mode.
func TestModeForRegistryGate(t *testing.T) {
	enabled := []string{
		model.ModeEnglish, model.ModeSuddenDeath, model.ModeSealedFirst,
		model.ModeVickrey, model.ModeHybridReveal, model.ModeAllPay,
	}
	for _, m := range enabled {
		if _, ok := modeFor(m); !ok {
			t.Errorf("enabled mode %q must be in the registry (modeFor.ok=true)", m)
		}
	}
	// Empty defaults to ENGLISH which IS enabled.
	if _, ok := modeFor(""); !ok {
		t.Errorf("empty mode must default to ENGLISH and be enabled")
	}
	// PREQUALIFY is a valid contract value but intentionally NOT directly
	// creatable — its workflow is SEALED_FIRST + POST /spawn-formal.
	if _, ok := modeFor(model.ModePrequalify); ok {
		t.Errorf("PREQUALIFY must NOT be directly creatable via modeFor — use SEALED_FIRST + spawn-formal")
	}
	// Unknown / malformed modes must be rejected at the registry gate.
	for _, m := range []string{"DUTCH", "PENNY", "nonsense", "ENGLISH_LITE", "english"} {
		if _, ok := modeFor(m); ok {
			t.Errorf("unknown mode %q must NOT be in the registry (modeFor.ok=false)", m)
		}
	}
}
