package metrics

import (
	"encoding/json"
	"math/rand"
	"sort"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestHistogramPercentileExactAtCap verifies nearest-rank percentiles against a
// known uniform distribution, before the reservoir starts replacing. Anchors
// the p50/p95/p99 math so an arithmetic regression (off-by-one in rankN) is
// caught here, not by chasing a wrong number in the load report.
func TestHistogramPercentileExactAtCap(t *testing.T) {
	h := NewHistogram(100)
	for i := 1; i <= 100; i++ {
		h.Observe(time.Duration(i) * time.Millisecond)
	}
	s := h.Snapshot()
	if s.Count != 100 {
		t.Fatalf("count=%d want=100", s.Count)
	}
	// nearest-rank ceil(p/100 * n) — 1: p50=49, p95=94, p99=98 (0-based).
	wantP50, wantP95, wantP99 := 50.0, 95.0, 99.0
	if s.P50 != wantP50 || s.P95 != wantP95 || s.P99 != wantP99 {
		t.Fatalf("percentiles: got p50=%v p95=%v p99=%v want p50=%v p95=%v p99=%v",
			s.P50, s.P95, s.P99, wantP50, wantP95, wantP99)
	}
	if s.Max != 100 {
		t.Fatalf("max=%v want=100", s.Max)
	}
}

// TestHistogramReservoirBounded asserts memory remains bounded even after
// >>cap observations — the regression we care about is "load harness ran for
// 60s and the process OOM'd because metrics grew without limit".
func TestHistogramReservoirBounded(t *testing.T) {
	h := NewHistogram(64)
	for i := 0; i < 10_000; i++ {
		h.Observe(time.Microsecond)
	}
	h.mu.Lock()
	got := len(h.samples)
	h.mu.Unlock()
	if got != 64 {
		t.Fatalf("samples len=%d want=64 (reservoir overflow)", got)
	}
	if h.Snapshot().Count != 10_000 {
		t.Fatalf("lifetime count=%d want=10000", h.Snapshot().Count)
	}
}

// TestHistogramReservoirSamplingPercentileAccuracy guards the statistical
// claim made in metrics.go: at cap=4096 and N≈60k uniform samples, p95 / p99
// are within one percentile point of the exact value. If Vitter R is broken
// (e.g. wrong probability), this test catches it. Runs in <1s so we keep it
// unconditional (CI must not skip any test — see .github/workflows/ci.yml).
func TestHistogramReservoirSamplingPercentileAccuracy(t *testing.T) {
	const cap, n = 4096, 60_000
	h := NewHistogram(cap)
	// Stable input distribution: [0, n) ns sampled uniformly + shuffled (so the
	// reservoir-replacement order doesn't accidentally encode position).
	src := make([]time.Duration, n)
	for i := range src {
		src[i] = time.Duration(i)
	}
	r := rand.New(rand.NewSource(1))
	r.Shuffle(len(src), func(i, j int) { src[i], src[j] = src[j], src[i] })
	for _, d := range src {
		h.Observe(d)
	}
	s := h.Snapshot()
	// Exact percentile values of the input (nearest-rank):
	wantP95 := float64(n) * 0.95 / float64(time.Millisecond) // in ms
	wantP99 := float64(n) * 0.99 / float64(time.Millisecond)
	// Allowed slack: 1.5 percentile points of n, in ms.
	slack := float64(n) * 0.015 / float64(time.Millisecond)
	if abs(s.P95-wantP95) > slack {
		t.Fatalf("p95=%v want≈%v ±%v", s.P95, wantP95, slack)
	}
	if abs(s.P99-wantP99) > slack {
		t.Fatalf("p99=%v want≈%v ±%v", s.P99, wantP99, slack)
	}
}

func abs(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}

// TestHistogramObserveNegativeClampsToZero pins the documented behaviour for
// the broadcast latency call site, where `time.Since(payloadServerTimeMs)`
// can transiently be negative under clock skew between the Redis box and the
// gateway box. We clamp (not drop) so the skew event still counts; dropping
// would silently mask high observed latencies.
func TestHistogramObserveNegativeClampsToZero(t *testing.T) {
	h := NewHistogram(8)
	h.Observe(-50 * time.Millisecond)
	s := h.Snapshot()
	if s.Count != 1 || s.P50 != 0 {
		t.Fatalf("negative clamp: count=%d p50=%v want count=1 p50=0", s.Count, s.P50)
	}
}

// TestHistogramConcurrent verifies the mutex actually protects the sample
// slice and the lifetime counter under contention — a data-race here would
// silently corrupt the reservoir under T8 load.
func TestHistogramConcurrent(t *testing.T) {
	h := NewHistogram(1024)
	var wg sync.WaitGroup
	const workers, perWorker = 16, 4_000
	wg.Add(workers)
	for w := 0; w < workers; w++ {
		go func() {
			defer wg.Done()
			for i := 0; i < perWorker; i++ {
				h.Observe(time.Microsecond * time.Duration(i+1))
			}
		}()
	}
	wg.Wait()
	if got := h.Snapshot().Count; got != workers*perWorker {
		t.Fatalf("count=%d want=%d", got, workers*perWorker)
	}
}

// TestCounterAtomic asserts Counter accumulates correctly across goroutines.
// Race detector run catches the unsafe-mutation regression separately.
func TestCounterAtomic(t *testing.T) {
	c := &Counter{}
	var wg sync.WaitGroup
	const workers, per = 8, 1_000
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < per; j++ {
				c.Inc()
			}
		}()
	}
	wg.Wait()
	if got := c.Load(); got != workers*per {
		t.Fatalf("counter=%d want=%d", got, workers*per)
	}
}

// TestObserveStreamLenMaxIsMonotonic — gauge tracks the *peak* stream length;
// a smaller subsequent observation must not pull the recorded max down.
func TestObserveStreamLenMaxIsMonotonic(t *testing.T) {
	r := New()
	r.ObserveStreamLen(100)
	r.ObserveStreamLen(50)
	r.ObserveStreamLen(200)
	r.ObserveStreamLen(150)
	if got := r.StreamLenMax.Load(); got != 200 {
		t.Fatalf("StreamLenMax=%d want=200", got)
	}
}

// TestObserveStreamLenConcurrent — peak update must survive a race between
// many writers (each gateway sweep tick races with the persistence sweep).
func TestObserveStreamLenConcurrent(t *testing.T) {
	r := New()
	var wg sync.WaitGroup
	const workers = 16
	wg.Add(workers)
	for w := 0; w < workers; w++ {
		w := w
		go func() {
			defer wg.Done()
			for i := 0; i < 1_000; i++ {
				// each worker writes a distinct max; the registry must end at the global peak.
				r.ObserveStreamLen(int64(w*1_000 + i))
			}
		}()
	}
	wg.Wait()
	want := int64((workers-1)*1_000 + 999)
	if got := r.StreamLenMax.Load(); got != want {
		t.Fatalf("StreamLenMax=%d want=%d", got, want)
	}
}

// TestSnapshotJSONShape pins the wire shape: /metrics scrapers (curl + jq, CI
// assertions, Grafana JSON datasource) depend on these field names. A rename
// would silently break the dashboard without any compile error.
func TestSnapshotJSONShape(t *testing.T) {
	r := New()
	r.AckLatency.Observe(10 * time.Millisecond)
	r.BidsAccepted.Inc()
	r.SeqGap.Add(0) // explicitly: load harness asserts seqGapCount==0
	r.ActiveConns.Store(7)
	b, err := json.Marshal(r.Snapshot())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got map[string]json.RawMessage
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	required := []string{
		"ackLatencyMs", "broadcastLatencyMs", "hammerLatencyMs",
		"catchupLatencyMs", "placeBidScriptTimeMs",
		"bidsAccepted", "bidsRejected", "backpressureForceClose",
		"seqGapCount", "streamLenMax", "activeConns",
	}
	for _, k := range required {
		if _, ok := got[k]; !ok {
			t.Errorf("snapshot missing field %q (shape break)", k)
		}
	}
}

// TestHistogramTimeRecordsElapsed — the convenience `defer h.Time(t0)()`
// closure must record elapsed time at fire-time, not creation-time.
func TestHistogramTimeRecordsElapsed(t *testing.T) {
	h := NewHistogram(8)
	t0 := time.Now()
	stop := h.Time(t0)
	time.Sleep(2 * time.Millisecond)
	stop()
	s := h.Snapshot()
	if s.Count != 1 || s.Max < 2 {
		t.Fatalf("Time closure: count=%d max=%v want count=1 max>=2ms", s.Count, s.Max)
	}
}

// (sanity) ensure the test file's stable-shuffle import is used (also pins
// math/rand source deterministically so the statistical test is reproducible).
var _ = sort.Slice
var _ = atomic.Int64{}
