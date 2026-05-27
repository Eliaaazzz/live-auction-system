// Hidden contract test for PR #24 CR 🟠 #3: LatencyEnvelope must FAIL when no
// bids accepted during drill — was previously a silent pass with zero samples,
// which would let an AI drill "succeed" while the WS bidder was broken.
package invariants

import (
	"context"
	"testing"
	"time"
)

func TestHiddenLatencyEnvelopeFailsOnZeroSamples(t *testing.T) {
	inv := NewLatencyEnvelope(Env{DuringEventsKey: "during"})
	// Empty ctx: no latency samples, no accepted count
	r := inv.Check(context.Background())
	if r.Passed {
		t.Fatal("LatencyEnvelope passed with zero samples — silent pass regressed (PR #24 CR 🟠 #3)")
	}
}

func TestHiddenLatencyEnvelopeFailsOnZeroAccepted(t *testing.T) {
	inv := NewLatencyEnvelope(Env{DuringEventsKey: "during"})
	// 10 samples but ZERO OK_ACCEPTED → still fail (samples are all timeouts/rejects)
	ctx := context.WithValue(context.Background(), latencyKey("during"),
		[]time.Duration{10 * time.Millisecond, 20 * time.Millisecond, 30 * time.Millisecond})
	ctx = context.WithValue(ctx, eventCountKey("during", "BID_ACCEPTED"), 0)
	r := inv.Check(ctx)
	if r.Passed {
		t.Fatalf("LatencyEnvelope passed with zero OK_ACCEPTED but 3 samples — drill claim unverified (msg=%s)", r.Message)
	}
}

func TestHiddenLatencyEnvelopePassesOnRealAccepts(t *testing.T) {
	inv := NewLatencyEnvelope(Env{DuringEventsKey: "during"})
	samples := []time.Duration{
		10 * time.Millisecond, 12 * time.Millisecond, 15 * time.Millisecond,
		18 * time.Millisecond, 20 * time.Millisecond,
	}
	ctx := context.WithValue(context.Background(), latencyKey("during"), samples)
	ctx = context.WithValue(ctx, eventCountKey("during", "BID_ACCEPTED"), len(samples))
	r := inv.Check(ctx)
	if !r.Passed {
		t.Fatalf("LatencyEnvelope failed on healthy sample set: %s", r.Message)
	}
}
