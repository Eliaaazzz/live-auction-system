package model

import "testing"

// baseRules is a minimal Rules value that passes Validate for any mode; tests
// override only Mode.
func baseRules(mode string) Rules {
	return Rules{
		Mode:            mode,
		StartPriceCents: 10000,
		IncrementCents:  1000,
		CapPriceCents:   0,
		DurationSec:     60,
		ExtendWindowSec: 10,
		ExtendSec:       10,
		MaxExtensions:   5,
	}
}

// Auction-mode plumbing (issue #114). The empty mode must normalize to ENGLISH
// so every pre-mode payload / DB row / state Hash behaves exactly as before.
func TestNormalizeAndValidMode(t *testing.T) {
	if NormalizeMode("") != ModeEnglish {
		t.Fatalf("empty mode must normalize to %q", ModeEnglish)
	}
	if NormalizeMode(ModeVickrey) != ModeVickrey {
		t.Fatalf("non-empty mode must pass through")
	}
	for _, m := range []string{"", ModeEnglish, ModeSuddenDeath, ModeSealedFirst, ModeVickrey, ModeHybridReveal, ModeAllPay, ModePrequalify} {
		if !ValidMode(m) {
			t.Errorf("mode %q should be valid", m)
		}
	}
	for _, m := range []string{"english", "DUTCH", "nonsense"} {
		if ValidMode(m) {
			t.Errorf("mode %q should be invalid", m)
		}
	}
}

func TestIsSealedMode(t *testing.T) {
	sealed := []string{ModeSealedFirst, ModeVickrey, ModeAllPay, ModePrequalify}
	open := []string{"", ModeEnglish, ModeSuddenDeath, ModeHybridReveal}
	for _, m := range sealed {
		if !IsSealedMode(m) {
			t.Errorf("mode %q should be sealed", m)
		}
	}
	for _, m := range open {
		if IsSealedMode(m) {
			t.Errorf("mode %q should not be sealed", m)
		}
	}
}

func TestRulesValidateMode(t *testing.T) {
	// Every known mode (incl. empty default) must validate with a sane base.
	for _, m := range []string{"", ModeEnglish, ModeSuddenDeath, ModeSealedFirst, ModeVickrey, ModeHybridReveal, ModeAllPay, ModePrequalify} {
		if err := baseRules(m).Validate(); err != nil {
			t.Errorf("mode %q should validate: %v", m, err)
		}
	}
	// An unknown mode is rejected at creation, not at bid time.
	if err := baseRules("DUTCH").Validate(); err == nil {
		t.Fatalf("unknown mode must fail Validate")
	}
}

// The snapshot rules must surface the (normalized) mode so the client can render
// mode-aware UI; an empty mode reports ENGLISH.
func TestRoomSnapshotRulesCarriesMode(t *testing.T) {
	if got := baseRules(ModeSealedFirst).RoomSnapshotRules().Mode; got != ModeSealedFirst {
		t.Fatalf("snapshot rules mode = %q, want %q", got, ModeSealedFirst)
	}
	if got := baseRules("").RoomSnapshotRules().Mode; got != ModeEnglish {
		t.Fatalf("empty mode must normalize to %q in snapshot, got %q", ModeEnglish, got)
	}
}
