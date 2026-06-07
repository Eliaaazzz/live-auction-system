package server

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/auth"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/config"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/metrics"
)

// TestHandleWSAdmissionGate pins the front-door admission behaviour: at/over the
// MAX_WS_CONNS watermark a new WS upgrade is shed with 503 + Retry-After BEFORE
// any per-conn allocation, and the rejected request must NOT reserve a slot
// (ActiveConns unchanged). This is the graceful-degradation path that replaces
// the proven ~15.7k OOM crash. Redis-free: the gate returns before any store or
// upgrade.
func TestHandleWSAdmissionGate(t *testing.T) {
	const secret = "test-secret-not-default"
	s := &Server{cfg: config.Config{JWTSecret: secret}, metrics: metrics.New(), hub: newHub()}
	tok := auth.Token(secret, "user_load_1")

	prev := maxWSConns
	maxWSConns = 3
	t.Cleanup(func() { maxWSConns = prev })
	s.metrics.ActiveConns.Store(3) // already at the watermark

	rec := httptest.NewRecorder()
	s.handleWS(rec, httptest.NewRequest(http.MethodGet, "/ws?token="+tok, nil))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("over-watermark: got %d, want 503", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Error("503 must carry a Retry-After header so clients back off")
	}
	if got := s.metrics.AdmissionRejected.Load(); got != 1 {
		t.Errorf("AdmissionRejected=%d, want 1", got)
	}
	if got := s.metrics.ActiveConns.Load(); got != 3 {
		t.Errorf("ActiveConns=%d, want 3 — a rejected upgrade must not reserve a slot", got)
	}
}

// TestTryReserveWSConcurrentDoesNotOvershootCap is the regression test for the
// admission race that matters under reconnect storms: check-then-Add can admit
// many goroutines that all observed cur<limit; tryReserveWS must CAS-reserve so
// only `limit` callers succeed, ActiveConns never rises past the cap, and every
// loser increments AdmissionRejected.
func TestTryReserveWSConcurrentDoesNotOvershootCap(t *testing.T) {
	m := metrics.New()
	const (
		limit = 1
		calls = 64
	)
	start := make(chan struct{})
	results := make(chan bool, calls)
	var wg sync.WaitGroup
	for i := 0; i < calls; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			results <- tryReserveWS(m, limit)
		}()
	}
	close(start)
	wg.Wait()
	close(results)

	successes := 0
	for ok := range results {
		if ok {
			successes++
		}
	}
	if successes != limit {
		t.Fatalf("successful reservations=%d, want %d", successes, limit)
	}
	if got := m.ActiveConns.Load(); got != int64(limit) {
		t.Fatalf("ActiveConns=%d, want capped at %d", got, limit)
	}
	if got := m.AdmissionRejected.Load(); got != int64(calls-limit) {
		t.Fatalf("AdmissionRejected=%d, want %d", got, calls-limit)
	}
	// Simulate the single admitted connection's teardown; the gauge must return
	// to zero so a later wave can be admitted.
	m.ActiveConns.Add(-int64(successes))
	if got := m.ActiveConns.Load(); got != 0 {
		t.Fatalf("ActiveConns after release=%d, want 0", got)
	}
}

// TestHandleWSAdmissionReleasesOnUpgradeFail proves the pre-upgrade slot
// reservation is released when the upgrade itself fails (here: a plain GET is
// not a valid WS handshake), so a failed/probing connection can't leak the
// ActiveConns gauge and slowly starve the admission budget.
func TestHandleWSAdmissionReleasesOnUpgradeFail(t *testing.T) {
	const secret = "test-secret-not-default"
	s := &Server{cfg: config.Config{JWTSecret: secret}, metrics: metrics.New(), hub: newHub()}
	tok := auth.Token(secret, "user_load_2")

	prev := maxWSConns
	maxWSConns = 100
	t.Cleanup(func() { maxWSConns = prev })
	s.metrics.ActiveConns.Store(1)

	rec := httptest.NewRecorder()
	s.handleWS(rec, httptest.NewRequest(http.MethodGet, "/ws?token="+tok, nil))

	if rec.Code == http.StatusServiceUnavailable {
		t.Fatalf("under watermark must not 503, got %d", rec.Code)
	}
	if got := s.metrics.AdmissionRejected.Load(); got != 0 {
		t.Errorf("AdmissionRejected=%d, want 0 under the watermark", got)
	}
	if got := s.metrics.ActiveConns.Load(); got != 1 {
		t.Errorf("ActiveConns=%d, want 1 — the reserved slot must be released on upgrade failure", got)
	}
}
