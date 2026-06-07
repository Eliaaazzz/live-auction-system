package server

import (
	"sync"
	"sync/atomic"
	"testing"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/metrics"
)

// TestTryReserveWSNeverOvershoots is the regression test for PDGGK review #235:
// the admission reservation MUST be atomic. Under a concurrent upgrade burst
// (reconnect storm / load ramp) a check-then-Add gate lets many goroutines all
// observe below-cap and then all increment, overshooting MAX_WS_CONNS — exactly
// when the gate is supposed to hold. The CAS reserve must admit EXACTLY `limit`,
// settle ActiveConns at `limit` (no leaked transient), and reject the rest.
func TestTryReserveWSNeverOvershoots(t *testing.T) {
	const limit = 100
	const goroutines = 2000
	m := metrics.New()

	var admitted atomic.Int64
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if tryReserveWS(m, limit) {
				admitted.Add(1) // hold the slot (never release) — simulates live conns
			}
		}()
	}
	close(start)
	wg.Wait()

	if got := admitted.Load(); got != limit {
		t.Fatalf("admitted=%d, want exactly %d (atomic reserve must not overshoot the cap)", got, limit)
	}
	if got := m.ActiveConns.Load(); got != limit {
		t.Fatalf("ActiveConns=%d, want %d (CAS must not leave a leaked over-cap reservation)", got, limit)
	}
	if got := m.AdmissionRejected.Load(); got != goroutines-limit {
		t.Fatalf("AdmissionRejected=%d, want %d", got, goroutines-limit)
	}
}

// TestTryReserveWSDisabled: limit<=0 (MAX_WS_CONNS unset) admits everyone (the
// single-gateway default) and never rejects.
func TestTryReserveWSDisabled(t *testing.T) {
	m := metrics.New()
	for i := 0; i < 50; i++ {
		if !tryReserveWS(m, 0) {
			t.Fatalf("limit=0 must admit unconditionally")
		}
	}
	if m.ActiveConns.Load() != 50 {
		t.Fatalf("ActiveConns=%d want 50", m.ActiveConns.Load())
	}
	if m.AdmissionRejected.Load() != 0 {
		t.Fatalf("AdmissionRejected=%d want 0 when disabled", m.AdmissionRejected.Load())
	}
	// nil registry is always admitted (test/alt-mode paths).
	if !tryReserveWS(nil, 5) {
		t.Fatal("nil metrics must admit")
	}
}

// TestIsLoopbackHostPort pins the pprof guard (PDGGK review #235): only a true
// loopback bind may serve /debug/pprof; any routable / wildcard bind is refused.
func TestIsLoopbackHostPort(t *testing.T) {
	cases := []struct {
		addr string
		want bool
	}{
		{"127.0.0.1:6060", true},
		{"localhost:6060", true},
		{"[::1]:6060", true},
		{"127.0.0.5:6060", true},
		{":6060", false},              // empty host => all interfaces
		{"0.0.0.0:6060", false},       // wildcard v4
		{"[::]:6060", false},          // wildcard v6
		{"115.191.76.40:6060", false}, // a real public EIP
		{"example.com:6060", false},   // DNS name could resolve routably
		{"garbage", false},            // no port
		{"", false},
	}
	for _, tc := range cases {
		if got := isLoopbackHostPort(tc.addr); got != tc.want {
			t.Errorf("isLoopbackHostPort(%q)=%v, want %v", tc.addr, got, tc.want)
		}
	}
}
