package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/config"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/metrics"
)

func TestMetricsResetEndpointIsDisabledWithoutToken(t *testing.T) {
	s := &Server{metrics: metrics.New()}
	req := httptest.NewRequest(http.MethodPost, "/admin/metrics/reset", nil)
	rr := httptest.NewRecorder()

	s.handleMetricsReset(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("status=%d want 404", rr.Code)
	}
}

func TestMetricsResetEndpointRejectsBadToken(t *testing.T) {
	for _, gotToken := range []string{"wrong1", "x"} {
		t.Run(gotToken, func(t *testing.T) {
			m := metrics.New()
			m.AckLatency.Observe(10 * time.Millisecond)
			s := &Server{
				cfg:     config.Config{MetricsResetToken: "secret"},
				metrics: m,
			}
			req := httptest.NewRequest(http.MethodPost, "/admin/metrics/reset", nil)
			req.Header.Set("X-Lumen-Metrics-Reset-Token", gotToken)
			rr := httptest.NewRecorder()

			s.handleMetricsReset(rr, req)

			if rr.Code != http.StatusForbidden {
				t.Fatalf("status=%d want 403", rr.Code)
			}
			if snap := m.Snapshot(); snap.Ack.Count != 1 {
				t.Fatalf("bad token reset metrics: %+v", snap)
			}
		})
	}
}

func TestMetricsResetEndpointRefusesActiveConnections(t *testing.T) {
	m := metrics.New()
	m.ActiveConns.Store(1)
	s := &Server{
		cfg:     config.Config{MetricsResetToken: "secret"},
		metrics: m,
	}
	req := httptest.NewRequest(http.MethodPost, "/admin/metrics/reset", nil)
	req.Header.Set("X-Lumen-Metrics-Reset-Token", "secret")
	rr := httptest.NewRecorder()

	s.handleMetricsReset(rr, req)

	if rr.Code != http.StatusConflict {
		t.Fatalf("status=%d want 409", rr.Code)
	}
	if got := m.ActiveConns.Load(); got != 1 {
		t.Fatalf("active conns changed: got %d want 1", got)
	}
}

func TestMetricsResetEndpointClearsRunWindowMetrics(t *testing.T) {
	m := metrics.New()
	m.AckLatency.Observe(10 * time.Millisecond)
	m.BidsAccepted.Inc()
	s := &Server{
		cfg:     config.Config{MetricsResetToken: "secret"},
		metrics: m,
	}
	req := httptest.NewRequest(http.MethodPost, "/admin/metrics/reset", nil)
	req.Header.Set("X-Lumen-Metrics-Reset-Token", "secret")
	rr := httptest.NewRecorder()

	s.handleMetricsReset(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d want 200 body=%s", rr.Code, rr.Body.String())
	}
	var out struct {
		Status string           `json:"status"`
		Pre    metrics.Snapshot `json:"pre"`
		Post   metrics.Snapshot `json:"post"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "ok" || out.Pre.Ack.Count != 1 || out.Pre.BidsAccepted != 1 {
		t.Fatalf("unexpected pre response: %+v", out)
	}
	if out.Post.Ack.Count != 0 || out.Post.BidsAccepted != 0 {
		t.Fatalf("metrics not reset: %+v", out.Post)
	}
}
