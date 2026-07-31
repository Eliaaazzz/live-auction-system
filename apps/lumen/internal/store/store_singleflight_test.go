package store

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

// TestSnapFlightCollapsesConcurrent proves a reconnect-storm of concurrent
// Snapshot(aid) reads collapses to far fewer underlying executions (cache-stampede protection),
// and that every caller still gets the same correct result.
func TestSnapFlightCollapsesConcurrent(t *testing.T) {
	var f snapFlight
	var calls atomic.Int64
	const n = 50
	start := make(chan struct{})
	results := make([]model.RoomSnapshotData, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			v, err := f.Do("auc_1", func() (model.RoomSnapshotData, error) {
				calls.Add(1)
				time.Sleep(20 * time.Millisecond) // hold the in-flight window open
				return model.RoomSnapshotData{Seq: 42, Status: "LIVE"}, nil
			})
			if err != nil {
				t.Errorf("Do: %v", err)
			}
			results[i] = v
		}(i)
	}
	close(start)
	wg.Wait()

	if got := calls.Load(); got < 1 || got >= int64(n) {
		t.Fatalf("fn invoked %d times, want far fewer than %d (single-flight collapse)", got, n)
	}
	for i, v := range results {
		if v.Seq != 42 || v.Status != "LIVE" {
			t.Fatalf("result[%d]=%+v, want shared {Seq:42,Status:LIVE}", i, v)
		}
	}
}

// TestSnapFlightFreshAfterCompletion proves there is NO caching/staleness: once
// the in-flight window closes, the next call re-executes fn (a fresh Redis read).
func TestSnapFlightFreshAfterCompletion(t *testing.T) {
	var f snapFlight
	var calls atomic.Int64
	do := func() (model.RoomSnapshotData, error) {
		return model.RoomSnapshotData{Seq: calls.Add(1)}, nil
	}
	v1, _ := f.Do("a", do)
	v2, _ := f.Do("a", do)
	if calls.Load() != 2 {
		t.Fatalf("sequential calls invoked fn %d times, want 2 (no caching)", calls.Load())
	}
	if v1.Seq == v2.Seq {
		t.Fatalf("fresh reads must differ: v1.Seq=%d v2.Seq=%d", v1.Seq, v2.Seq)
	}
}
