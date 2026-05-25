package invariants

// PR #24 CR P1-2 hidden test: LatencyEnvelope must fail when
// RequireAcceptDuringInjection is true but zero accepts occurred during the
// injection window. Confirms the "bidding continued under fault" claim isn't
// satisfied by a post-uninject recovery flurry.

import (
	"context"
	"testing"
	"time"
)

func TestLatencyEnvelopeFailsWhenAllAcceptsArePostUninject(t *testing.T) {
	env := Env{
		LumenBaseURL:                 "http://localhost:8080",
		AuctionID:                    "auc_demo",
		DuringEventsKey:              "during",
		RequireAcceptDuringInjection: true,
	}
	l := NewLatencyEnvelope(env).(*LatencyEnvelope)

	ctx := context.Background()
	ctx = context.WithValue(ctx, latencyKey(env.DuringEventsKey), []time.Duration{
		2 * time.Millisecond, 3 * time.Millisecond, 5 * time.Millisecond,
	})
	ctx = context.WithValue(ctx, eventCountKey(env.DuringEventsKey, "BID_ACCEPTED"), 3) // total accepts
	ctx = context.WithValue(ctx, eventCountKey(env.DuringEventsKey, "BID_ACCEPTED_INJECTION_WINDOW"), 0)
	ctx = context.WithValue(ctx, toleranceKey(env.DuringEventsKey), 200*time.Millisecond)

	r := l.Check(ctx)
	if r.Passed {
		t.Fatalf("expected FAIL when accepts only arrive after uninject; got PASS: %s", r.Message)
	}
}

func TestLatencyEnvelopePassesWhenAcceptsDuringWindow(t *testing.T) {
	env := Env{
		LumenBaseURL:                 "http://localhost:8080",
		AuctionID:                    "auc_demo",
		DuringEventsKey:              "during",
		RequireAcceptDuringInjection: true,
	}
	l := NewLatencyEnvelope(env).(*LatencyEnvelope)

	ctx := context.Background()
	ctx = context.WithValue(ctx, latencyKey(env.DuringEventsKey), []time.Duration{
		2 * time.Millisecond, 3 * time.Millisecond, 5 * time.Millisecond,
	})
	ctx = context.WithValue(ctx, eventCountKey(env.DuringEventsKey, "BID_ACCEPTED"), 3)
	ctx = context.WithValue(ctx, eventCountKey(env.DuringEventsKey, "BID_ACCEPTED_INJECTION_WINDOW"), 3)
	ctx = context.WithValue(ctx, toleranceKey(env.DuringEventsKey), 200*time.Millisecond)

	r := l.Check(ctx)
	if !r.Passed {
		t.Fatalf("expected PASS when accepts arrive in injection window; got FAIL: %s", r.Message)
	}
}

func TestLatencyEnvelopeExemptsNetworkPhases(t *testing.T) {
	// Network phases (redis/schrodinger) get RequireAcceptDuringInjection=false
	// from For(): partial pause is the documented degrade, so we don't demand
	// during-window accepts. Confirms the exemption path.
	env := Env{
		LumenBaseURL:                 "http://localhost:8080",
		AuctionID:                    "auc_demo",
		DuringEventsKey:              "during",
		RequireAcceptDuringInjection: false,
	}
	l := NewLatencyEnvelope(env).(*LatencyEnvelope)

	ctx := context.Background()
	ctx = context.WithValue(ctx, latencyKey(env.DuringEventsKey), []time.Duration{
		2 * time.Millisecond, 3 * time.Millisecond, 5 * time.Millisecond,
	})
	ctx = context.WithValue(ctx, eventCountKey(env.DuringEventsKey, "BID_ACCEPTED"), 3)
	ctx = context.WithValue(ctx, eventCountKey(env.DuringEventsKey, "BID_ACCEPTED_INJECTION_WINDOW"), 0)
	ctx = context.WithValue(ctx, toleranceKey(env.DuringEventsKey), 200*time.Millisecond)

	r := l.Check(ctx)
	if !r.Passed {
		t.Fatalf("network-phase exemption should PASS even with 0 during-injection accepts; got FAIL: %s", r.Message)
	}
}
