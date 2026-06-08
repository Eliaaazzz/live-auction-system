package server

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/metrics"
)

// TestRecoverGoroutineCountsPanic: the deferred firewall recovers a panic (the
// test process survives the call) and increments goroutinePanics for alerting.
func TestRecoverGoroutineCountsPanic(t *testing.T) {
	m := metrics.New()
	func() {
		defer recoverGoroutine("unit", m)
		panic("boom") // would crash the process without the firewall
	}()
	if got := m.GoroutinePanics.Load(); got != 1 {
		t.Fatalf("GoroutinePanics=%d, want 1", got)
	}
	// no panic when nothing went wrong
	func() { defer recoverGoroutine("clean", m) }()
	if got := m.GoroutinePanics.Load(); got != 1 {
		t.Fatalf("GoroutinePanics=%d after clean run, want still 1", got)
	}
}

// TestRecoverGoroutineNilMetricsSafe: nil registry (test/alt-mode paths) must not
// itself panic while recovering.
func TestRecoverGoroutineNilMetricsSafe(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("recoverGoroutine(nil) must not re-panic, got %v", r)
		}
	}()
	func() {
		defer recoverGoroutine("nil-metrics", nil)
		panic("boom")
	}()
}

// TestGoSupervisedRestartsAfterPanic is the regression for the spec deep-review
// stability gap: a panicking long-lived worker must be recovered AND restarted,
// not crash the gateway. fn panics on its first run, then blocks until ctx is
// cancelled on the restart — we assert it ran at least twice (restarted) and the
// panic was counted, then that cancelling ctx stops the loop.
func TestGoSupervisedRestartsAfterPanic(t *testing.T) {
	old := goSupervisedBackoff
	goSupervisedBackoff = 5 * time.Millisecond
	defer func() { goSupervisedBackoff = old }()

	m := metrics.New()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var runs atomic.Int64
	ran := make(chan int64, 8)
	goSupervised(ctx, "test-worker", m, func(c context.Context) {
		n := runs.Add(1)
		ran <- n
		if n == 1 {
			panic("first run boom") // must be recovered + restarted
		}
		<-c.Done() // healthy run: block like a real worker until shutdown
	})

	// first run
	select {
	case <-ran:
	case <-time.After(2 * time.Second):
		t.Fatal("worker never started")
	}
	// restart after the panic (proves the process survived + the loop re-ran)
	select {
	case <-ran:
	case <-time.After(2 * time.Second):
		t.Fatal("worker did not restart after panic — gateway would have crashed")
	}
	if got := m.GoroutinePanics.Load(); got < 1 {
		t.Fatalf("GoroutinePanics=%d, want >=1", got)
	}

	cancel() // graceful shutdown: the supervised loop must exit, not restart forever
	time.Sleep(20 * time.Millisecond)
	before := runs.Load()
	time.Sleep(30 * time.Millisecond)
	if after := runs.Load(); after != before {
		t.Fatalf("worker kept restarting after ctx cancel: runs %d -> %d", before, after)
	}
}
