// Package metrics is the in-process observability surface for T8 (V9 plan §10).
// It is intentionally dep-free (no Prometheus / OpenTelemetry SDK):
//
//   - the bid hot path is mutex-light and pays no allocation per observation
//     beyond a single uint64 add and an occasional reservoir replacement;
//   - the snapshot shape is plain JSON so /metrics can be scraped by anything
//     (curl + jq, a CI assertion, a Grafana JSON datasource, a make target).
//
// Reservoir sampling (Vitter R) keeps a bounded, uniform sample of every
// observation seen since process start; Snapshot sorts a copy of that sample
// and computes p50/p95/p99 by nearest-rank. The reservoir size is fixed at
// construction; with cap=4096 the standard error on p99 is well under one
// percentile point at the volumes T8 produces (60s × ~100 bids/s ≈ 6k samples).
package metrics

import (
	"math/rand"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// Registry owns the named instruments wired into the lumen process. It is
// constructed once at server startup and read by /metrics + the load harness.
// All instruments are safe for concurrent use; instrument lookup itself is
// constant-time (struct fields, not a map) so the hot path never traverses
// the registry on a write.
type Registry struct {
	// Hot-path latencies (V9 §4.2). p95 budgets:
	//   AckLatency       < 80ms  (P0 gate)
	//   BroadcastLatency < 150ms (P0 gate; Bid Engine → last viewer)
	//   HammerLatency    < 500ms (P0 gate; scan→fanout)
	//   CatchupLatency   < 1s    (P0 gate; 200-event replay)
	//   ScriptTime       < 5ms   (P0 *pre-gate*; place_bid.lua exec)
	//   HandlerOverhead  < 5ms   (P8; BID_PLACE Go-side work MINUS the
	//                             PlaceBid/Redis span — decode + canonicalize
	//                             + ack push. Isolates synchronous handler
	//                             work from the network RTT, which AckLatency
	//                             already covers.)
	AckLatency       *Histogram
	BroadcastLatency *Histogram
	HammerLatency    *Histogram
	CatchupLatency   *Histogram
	ScriptTime       *Histogram
	HandlerOverhead  *Histogram

	// Counters (monotonic). SeqGap=0 is the correctness invariant (§4.1).
	BidsAccepted     *Counter
	BidsRejected     *Counter
	BackpressureDrop *Counter
	SeqGap           *Counter
	// V10k Tier C: count of BID_PLACE rejected by the gateway-side fast-path
	// pre-aggregation filter (eventually-consistent room price cache; see
	// hub.roomStateSnap). High value relative to BidsRejected indicates the
	// filter is effective; low value indicates light bid contention. Always
	// also bumps BidsRejected so the aggregate stays consistent.
	BidsRejectedFastPath *Counter

	// Gauges (point-in-time). StreamLen is sampled by the gateway sweep;
	// ActiveConns is incremented/decremented on WS connect/disconnect.
	StreamLenMax atomic.Int64 // peak observed stream length since start
	ActiveConns  atomic.Int64
}

// New constructs a fresh registry with sensible reservoir caps. T8 observations
// (~60k per histogram at 500/50) are well within memory budget at cap=4096.
func New() *Registry {
	return &Registry{
		AckLatency:           NewHistogram(4096),
		BroadcastLatency:     NewHistogram(4096),
		HammerLatency:        NewHistogram(4096),
		CatchupLatency:       NewHistogram(4096),
		ScriptTime:           NewHistogram(4096),
		HandlerOverhead:      NewHistogram(4096),
		BidsAccepted:         &Counter{},
		BidsRejected:         &Counter{},
		BidsRejectedFastPath: &Counter{},
		BackpressureDrop:     &Counter{},
		SeqGap:               &Counter{},
	}
}

// ObserveStreamLen records a new max if n exceeds the recorded peak. Cheap
// fast-path read avoids a CAS when nothing has changed.
func (r *Registry) ObserveStreamLen(n int64) {
	for {
		cur := r.StreamLenMax.Load()
		if n <= cur {
			return
		}
		if r.StreamLenMax.CompareAndSwap(cur, n) {
			return
		}
	}
}

// Snapshot is the JSON shape returned by /metrics. Field tags match the
// proto/observed.md (T8 will materialize a doc; the field names here are the
// source). Histograms render as {p50,p95,p99,count} in milliseconds.
type Snapshot struct {
	Ack                  HistogramSnapshot `json:"ackLatencyMs"`
	Broadcast            HistogramSnapshot `json:"broadcastLatencyMs"`
	Hammer               HistogramSnapshot `json:"hammerLatencyMs"`
	Catchup              HistogramSnapshot `json:"catchupLatencyMs"`
	ScriptTime           HistogramSnapshot `json:"placeBidScriptTimeMs"`
	HandlerOverhead      HistogramSnapshot `json:"bidHandlerOverheadMs"`
	BidsAccepted         int64             `json:"bidsAccepted"`
	BidsRejected         int64             `json:"bidsRejected"`
	BidsRejectedFastPath int64             `json:"bidsRejectedFastPath"`
	BackpressureDrop     int64             `json:"backpressureForceClose"`
	SeqGap               int64             `json:"seqGapCount"`
	StreamLenMax         int64             `json:"streamLenMax"`
	ActiveConns          int64             `json:"activeConns"`
}

// Snapshot is non-blocking from the writer side: each histogram takes its own
// mutex briefly to copy + sort a sample slice; counters/gauges are atomic.
func (r *Registry) Snapshot() Snapshot {
	return Snapshot{
		Ack:                  r.AckLatency.Snapshot(),
		Broadcast:            r.BroadcastLatency.Snapshot(),
		Hammer:               r.HammerLatency.Snapshot(),
		Catchup:              r.CatchupLatency.Snapshot(),
		ScriptTime:           r.ScriptTime.Snapshot(),
		HandlerOverhead:      r.HandlerOverhead.Snapshot(),
		BidsAccepted:         r.BidsAccepted.Load(),
		BidsRejected:         r.BidsRejected.Load(),
		BidsRejectedFastPath: r.BidsRejectedFastPath.Load(),
		BackpressureDrop:     r.BackpressureDrop.Load(),
		SeqGap:               r.SeqGap.Load(),
		StreamLenMax:         r.StreamLenMax.Load(),
		ActiveConns:          r.ActiveConns.Load(),
	}
}

// Counter is a monotonic uint64. Inc is allocation-free and lock-free.
type Counter struct{ n atomic.Int64 }

func (c *Counter) Inc()        { c.n.Add(1) }
func (c *Counter) Add(n int64) { c.n.Add(n) }
func (c *Counter) Load() int64 { return c.n.Load() }

// Histogram is a fixed-capacity reservoir-sampled latency distribution. Past
// `cap` observations, each new sample replaces a uniformly-random existing one
// (Vitter R), keeping the sample unbiased relative to the full stream while
// bounding memory to ~16 KiB at cap=4096.
type Histogram struct {
	mu      sync.Mutex
	cap     int
	samples []time.Duration
	n       int64 // total observations (lifetime)
	r       *rand.Rand
}

// NewHistogram constructs a histogram with the given reservoir cap. cap=0
// disables sampling (the histogram records nothing — used by tests that want
// to assert "no observation occurred").
func NewHistogram(cap int) *Histogram {
	if cap < 0 {
		cap = 0
	}
	return &Histogram{
		cap:     cap,
		samples: make([]time.Duration, 0, cap),
		// Non-crypto rand: this is a sample selection coin-flip, not a security
		// boundary. Seeding from UnixNano keeps test runs independent without a
		// global lock.
		r: rand.New(rand.NewSource(time.Now().UnixNano())),
	}
}

// Observe records one latency sample. Negative durations are clamped to 0 (a
// clock-skew artifact from `time.Since(payloadTs)` when the Lua-stamped
// serverTimeMs sits in the future relative to the gateway's local clock; the
// alternative — dropping — would mask real broadcast skew, while clamping
// surfaces it as p50≈0 without poisoning the percentile math).
func (h *Histogram) Observe(d time.Duration) {
	if h.cap == 0 {
		return
	}
	if d < 0 {
		d = 0
	}
	h.mu.Lock()
	h.n++
	if len(h.samples) < h.cap {
		h.samples = append(h.samples, d)
	} else {
		// Vitter R: with probability cap/n, replace a uniformly-random existing
		// sample. Equivalent to picking idx in [0, n); if idx < cap, replace.
		idx := h.r.Int63n(h.n)
		if idx < int64(h.cap) {
			h.samples[idx] = d
		}
	}
	h.mu.Unlock()
}

// HistogramSnapshot is the JSON shape per histogram. Durations are milliseconds
// (float for sub-ms resolution at low traffic).
type HistogramSnapshot struct {
	Count int64   `json:"count"`
	P50   float64 `json:"p50"`
	P95   float64 `json:"p95"`
	P99   float64 `json:"p99"`
	Max   float64 `json:"max"`
}

// Snapshot returns the current p50/p95/p99 + max + lifetime count. Cheap: one
// mutex acquire, one slice copy, one sort. Empty input yields zeros.
func (h *Histogram) Snapshot() HistogramSnapshot {
	h.mu.Lock()
	n := h.n
	cp := append([]time.Duration(nil), h.samples...)
	h.mu.Unlock()
	if len(cp) == 0 {
		return HistogramSnapshot{Count: n}
	}
	sort.Slice(cp, func(i, j int) bool { return cp[i] < cp[j] })
	return HistogramSnapshot{
		Count: n,
		P50:   ms(cp[rankN(len(cp), 50)]),
		P95:   ms(cp[rankN(len(cp), 95)]),
		P99:   ms(cp[rankN(len(cp), 99)]),
		Max:   ms(cp[len(cp)-1]),
	}
}

// rankN maps a percentile to a 0-based index (nearest-rank, clamped) over a
// sample of size n. Mirrors apps/lumen/internal/server/perf.go::rank so
// percentiles reported by perf-smoke and load are computed identically.
func rankN(n, p int) int {
	idx := (p*n + 99) / 100 // ceil(p/100 * n)
	if idx < 1 {
		idx = 1
	}
	if idx > n {
		idx = n
	}
	return idx - 1
}

// ms converts a duration to fractional milliseconds.
func ms(d time.Duration) float64 { return float64(d) / float64(time.Millisecond) }

// Time is a small helper for the call site: `defer m.AckLatency.Time(time.Now())()`
// records elapsed when the deferred close-over fires. Allocates the closure
// (~32B) so prefer explicit `m.AckLatency.Observe(time.Since(t0))` on the
// per-bid hot path; keep Time() for less-frequent paths (hammer, catchup).
func (h *Histogram) Time(t0 time.Time) func() {
	return func() { h.Observe(time.Since(t0)) }
}
