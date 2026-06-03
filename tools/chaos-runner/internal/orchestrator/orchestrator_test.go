package orchestrator

import (
	"context"
	"testing"
	"time"

	"github.com/Eliaaazzz/live-auction-system/tools/chaos-runner/internal/artifact"
	"github.com/Eliaaazzz/live-auction-system/tools/chaos-runner/internal/phases"
)

type testPhase struct {
	kind string
}

func (p testPhase) Name() string { return "test-phase" }
func (p testPhase) Kind() string { return p.kind }
func (p testPhase) Inject(context.Context, phases.Env) (func(context.Context) error, error) {
	return func(context.Context) error { return nil }, nil
}
func (p testPhase) ExpectedDegradeWireCodes() []string { return nil }
func (p testPhase) RecoveryDeadline() string           { return "30s" }

func TestPhaseDuringTolerance(t *testing.T) {
	if got, want := phaseDuringTolerance(testPhase{kind: "network"}), 5*time.Second; got != want {
		t.Fatalf("phaseDuringTolerance(network)=%s, want %s", got, want)
	}
	if got, want := phaseDuringTolerance(testPhase{kind: "process_kill"}), 200*time.Millisecond; got != want {
		t.Fatalf("phaseDuringTolerance(process_kill)=%s, want %s", got, want)
	}
}

func TestBuildInvariantContextIncludesDuringTolerance(t *testing.T) {
	rec := &artifact.Recorder{
		AckLatencies: []time.Duration{10 * time.Millisecond},
	}
	ctx := buildInvariantContext(context.Background(), rec, testPhase{kind: "network"}, 30*time.Second)
	tolerance, ok := ctx.Value(toleranceKey("during")).(time.Duration)
	if !ok {
		t.Fatalf("invariant context missing during tolerance")
	}
	if tolerance != 5*time.Second {
		t.Fatalf("during tolerance=%s, want %s", tolerance, 5*time.Second)
	}
}
