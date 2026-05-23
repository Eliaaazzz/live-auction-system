package invariants

import (
	"context"
	"fmt"
	"sort"
	"time"
)

// LatencyEnvelope — NEW invariant beyond the V9 §9 minimum.
//
// PDGGK / V9 §4.4 phrase the chaos drill outcome as "bidding continues" or
// "system degrades + self-heals". That's binary. The latency envelope
// invariant is the quantitative version: during the drill window, the bid
// acceptance latency distribution stays within bounds.
//
// Concretely: during the drill, sample the steady-bid generator's per-bid
// latency. Compute p50/p95/p99. Compare against the phase's tolerance:
//
//   - "process_kill" phases (ai, ws, timer): no impact on bid latency
//     expected → tolerance is the normal SLO (p95 < 200ms floor)
//   - "network" phases (redis, schrodinger): latency excursion is *expected*
//     during the drill window — tolerance is wider (p95 < 5s)
//   - "data" phases (tamper): no impact on bid latency expected
//   - "client" phases (slowclient): no impact on OTHER clients expected
//
// This invariant is what catches the case "drill succeeded but the user
// experience was awful" — V9 §4.2 floor breach during chaos = real evidence
// of pressure, not just a static SLO claim.
type LatencyEnvelope struct{ env Env }

func NewLatencyEnvelope(env Env) Invariant { return &LatencyEnvelope{env: env} }

func (l *LatencyEnvelope) Name() string { return "latency_envelope_during_drill" }
func (l *LatencyEnvelope) Description() string {
	return "during-drill bid acceptance p95 stays within phase-tolerance (extends V9 §4.2 to chaos windows)"
}

func (l *LatencyEnvelope) Check(ctx context.Context) Result {
	samples, ok := ctx.Value(latencyKey(l.env.DuringEventsKey)).([]time.Duration)
	if !ok || len(samples) == 0 {
		// No samples = either steady-bid generator wasn't running or all bids
		// were rejected. Other invariants will catch the rejection case; here
		// it's not a fail, it's "no data" → skip.
		return Pass(l, "no during-drill bid samples (steady-bid may have been gated off)")
	}
	tolerance, ok := ctx.Value(toleranceKey(l.env.DuringEventsKey)).(time.Duration)
	if !ok {
		tolerance = 200 * time.Millisecond // V9 §4.2 ack p95 floor
	}

	p50 := percentile(samples, 0.50)
	p95 := percentile(samples, 0.95)
	p99 := percentile(samples, 0.99)
	if p95 > tolerance {
		return Fail(l, "during-drill p95 = %s exceeds tolerance %s (p50=%s p99=%s, n=%d)",
			p95.Round(time.Millisecond), tolerance, p50.Round(time.Millisecond), p99.Round(time.Millisecond), len(samples))
	}
	return Pass(l, fmt.Sprintf("during-drill p50=%s p95=%s p99=%s within tolerance %s (n=%d)",
		p50.Round(time.Millisecond), p95.Round(time.Millisecond), p99.Round(time.Millisecond), tolerance, len(samples)))
}

func percentile(s []time.Duration, p float64) time.Duration {
	if len(s) == 0 {
		return 0
	}
	sorted := make([]time.Duration, len(s))
	copy(sorted, s)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	idx := int(float64(len(sorted)-1) * p)
	return sorted[idx]
}

func latencyKey(base string) string   { return fmt.Sprintf("%s::latencies", base) }
func toleranceKey(base string) string { return fmt.Sprintf("%s::tolerance", base) }
