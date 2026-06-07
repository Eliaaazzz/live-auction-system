package server

import (
	"fmt"
	"testing"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/metrics"
)

// TestObserveBroadcastLatencySkipsReplays pins the fix for the frozen
// broadcastLatencyMs garbage (p99≈775,000ms on the 2026-06-07 dashboard): a
// fresh fanout event is recorded, but a replay/sweep re-broadcast of an old
// event (age >= maxBroadcastObserveAge) and an event missing serverTimeMs are
// both skipped — keeping p95/p99 honest. Nil metrics must not panic.
func TestObserveBroadcastLatencySkipsReplays(t *testing.T) {
	m := metrics.New()
	nowMs := time.Now().UnixMilli()

	observeBroadcastLatency(m, fmt.Sprintf(`{"serverTimeMs":%d}`, nowMs-50)) // fresh (50ms) → recorded
	if c := m.BroadcastLatency.Snapshot().Count; c != 1 {
		t.Fatalf("fresh event: count=%d want 1", c)
	}

	old := nowMs - int64(maxBroadcastObserveAge/time.Millisecond) - 10_000
	observeBroadcastLatency(m, fmt.Sprintf(`{"serverTimeMs":%d}`, old)) // replay → skipped
	if c := m.BroadcastLatency.Snapshot().Count; c != 1 {
		t.Fatalf("replay re-broadcast must be skipped: count=%d want 1", c)
	}

	observeBroadcastLatency(m, `{"type":"X"}`) // no serverTimeMs → skipped
	if c := m.BroadcastLatency.Snapshot().Count; c != 1 {
		t.Fatalf("missing serverTimeMs must be skipped: count=%d want 1", c)
	}

	observeBroadcastLatency(nil, fmt.Sprintf(`{"serverTimeMs":%d}`, nowMs)) // nil → no panic
}
