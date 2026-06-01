package metrics

import (
	"testing"
	"time"
)

// BenchmarkHistogramObserve is the #92 G5 regression hook for the T8/V100k hot
// path: every accepted bid, broadcast, Lua script span, and handler span records
// through Histogram.Observe. It keeps the reservoir full so the benchmark
// includes the steady-state Vitter R replacement branch rather than just the
// initial append-only warmup.
func BenchmarkHistogramObserve(b *testing.B) {
	h := NewHistogram(4096)
	for i := 0; i < 4096; i++ {
		h.Observe(time.Duration(i) * time.Microsecond)
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		h.Observe(time.Duration(i&1023) * time.Microsecond)
	}
}

// BenchmarkHistogramSnapshotFullReservoir covers the /metrics scrape side of
// the same T8 path: Snapshot copies and sorts the bounded reservoir. This should
// stay comfortably off the bid hot path, but a larger cap or accidental unbound
// sample slice would show up immediately in benchstat.
func BenchmarkHistogramSnapshotFullReservoir(b *testing.B) {
	h := NewHistogram(4096)
	for i := 0; i < 60_000; i++ {
		h.Observe(time.Duration(i&4095) * time.Microsecond)
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = h.Snapshot()
	}
}
