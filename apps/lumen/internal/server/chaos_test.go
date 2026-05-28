package server

// Unit tests for the T9 chaos harness pure helpers. The phase-dispatch tests
// hit the validation paths only (no live stack) — the wire-level assertions are
// exercised end-to-end by the `make chaos` Make targets (which require a
// running docker-compose stack and live in CI under `chaos-smoke`).

import (
	"strings"
	"testing"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

func TestIsAcceptCode(t *testing.T) {
	// OK_ACCEPTED / OK_EXTENDED / OK_SOLD all land as BID_ACCEPTED on the wire.
	// DUPLICATE replays the original ack but the wire frame is still BID_ACCEPTED,
	// however the chaos drill never expects DUPLICATE directly (it expects the
	// observable code the first bid produces), so it is intentionally NOT in
	// isAcceptCode — would mask a real test regression where DUPLICATE leaked
	// into the place where OK_ACCEPTED was expected.
	for _, code := range []string{model.CodeOKAccepted, model.CodeOKExtended, model.CodeOKSold} {
		if !isAcceptCode(code) {
			t.Errorf("isAcceptCode(%q) = false, want true", code)
		}
	}
	for _, code := range []string{
		model.CodeErrPaused,
		model.CodeErrAfterEnd,
		model.CodeErrNotLive,
		model.CodeErrTooLow,
		model.CodeDuplicate,
		"",
		"UNKNOWN",
	} {
		if isAcceptCode(code) {
			t.Errorf("isAcceptCode(%q) = true, want false", code)
		}
	}
}

func TestShortTruncates(t *testing.T) {
	long := strings.Repeat("a", 200)
	got := short(long)
	if len(got) <= 80 {
		t.Errorf("short() did not truncate: len=%d want >80 with ellipsis", len(got))
	}
	if !strings.HasSuffix(got, "…") {
		t.Errorf("short() missing ellipsis suffix: %q", got)
	}
	if s := "short message"; short(s) != s {
		t.Errorf("short() altered a short string: got %q want %q", short(s), s)
	}
}

// TestRunChaosDispatchValidation covers the early-return branches without a
// live target. RunChaos must error on empty target, unknown phase, and the
// required-flag branches in each phase.
func TestRunChaosDispatchValidation(t *testing.T) {
	cases := []struct {
		name    string
		opts    ChaosOptions
		wantSub string
	}{
		{
			name:    "missing target",
			opts:    ChaosOptions{Phase: PhaseSetup},
			wantSub: "TARGET required",
		},
		{
			name:    "unknown phase",
			opts:    ChaosOptions{Target: "http://x", Phase: "bogus"},
			wantSub: "unknown phase",
		},
		{
			name:    "bid-expect missing aid",
			opts:    ChaosOptions{Target: "http://x", Phase: PhaseBidExpect, Code: "OK_ACCEPTED"},
			wantSub: "--aid and --code required",
		},
		{
			name:    "bid-expect missing code",
			opts:    ChaosOptions{Target: "http://x", Phase: PhaseBidExpect, AID: "auc_x"},
			wantSub: "--aid and --code required",
		},
		{
			name:    "state-expect missing aid",
			opts:    ChaosOptions{Target: "http://x", Phase: PhaseStateExpect, State: "LIVE"},
			wantSub: "--aid and --state required",
		},
		{
			name:    "state-expect missing state",
			opts:    ChaosOptions{Target: "http://x", Phase: PhaseStateExpect, AID: "auc_x"},
			wantSub: "--aid and --state required",
		},
		{
			name:    "catchup-expect missing aid",
			opts:    ChaosOptions{Target: "http://x", Phase: PhaseCatchup, WantSeq: 1},
			wantSub: "--aid required",
		},
		{
			name:    "wait-events missing want-seq",
			opts:    ChaosOptions{Target: "http://x", Phase: PhaseWaitEvents, AID: "auc_x"},
			wantSub: "--aid and --want-seq required",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// keep the timeout tiny so any phase that slipped past validation
			// doesn't actually try to make a network call for 10s.
			c.opts.Timeout = 100 * time.Millisecond
			err := RunChaos(c.opts)
			if err == nil {
				t.Fatalf("RunChaos(%+v) = nil, want error containing %q", c.opts, c.wantSub)
			}
			if !strings.Contains(err.Error(), c.wantSub) {
				t.Errorf("RunChaos error = %q, want substring %q", err.Error(), c.wantSub)
			}
		})
	}
}
