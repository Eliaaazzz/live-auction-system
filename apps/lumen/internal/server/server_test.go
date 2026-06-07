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

func TestSafePprofListenAddrAllowsLoopbackOnly(t *testing.T) {
	for _, raw := range []string{
		"127.0.0.1:6060",
		"localhost:6060",
		"[::1]:6060",
		" 127.0.0.1:6060 ",
	} {
		t.Run("allow_"+raw, func(t *testing.T) {
			if got, ok := safePprofListenAddr(raw); !ok || got == "" {
				t.Fatalf("safePprofListenAddr(%q)=(%q,%v), want allowed", raw, got, ok)
			}
		})
	}

	for _, raw := range []string{
		"",
		":6060",
		"0.0.0.0:6060",
		"[::]:6060",
		"115.191.76.40:6060",
		"example.com:6060",
		"127.0.0.1",
		"not-a-host-port",
	} {
		t.Run("reject_"+raw, func(t *testing.T) {
			if got, ok := safePprofListenAddr(raw); ok || got != "" {
				t.Fatalf("safePprofListenAddr(%q)=(%q,%v), want rejected", raw, got, ok)
			}
		})
	}
}
