package server

import (
	"testing"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/config"
)

func TestTimerChaosDisableRequiresDevEnv(t *testing.T) {
	t.Setenv("LUMEN_CHAOS_DISABLE_TIMER", "1")

	disabled, err := timerDisabledByChaos(config.Config{AppEnv: "dev"}, "all")
	if err != nil {
		t.Fatalf("dev chaos timer disable should be allowed: %v", err)
	}
	if !disabled {
		t.Fatal("dev chaos timer disable should report disabled=true")
	}

	if _, err := timerDisabledByChaos(config.Config{AppEnv: "prod"}, "all"); err == nil {
		t.Fatal("prod chaos timer disable must fail fast")
	}
}

func TestTimerChaosDisableIgnoredForNonTimerModes(t *testing.T) {
	t.Setenv("LUMEN_CHAOS_DISABLE_TIMER", "1")

	disabled, err := timerDisabledByChaos(config.Config{AppEnv: "prod"}, "gateway")
	if err != nil {
		t.Fatalf("non-timer mode should ignore timer chaos knob: %v", err)
	}
	if disabled {
		t.Fatal("non-timer mode should not report timer disabled")
	}
}
