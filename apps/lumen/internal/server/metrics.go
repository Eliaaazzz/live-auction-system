package server

import (
	"crypto/subtle"
	"net/http"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/metrics"
)

// handleMetrics returns the in-process metrics snapshot as JSON (T8: V9 §10).
// Read-only; safe to expose without auth on the demo box because it reveals
// only aggregate counters/percentiles, no per-user or per-auction PII. On a
// public deploy this should be behind the operator-only gateway path.
// (Issue #1 §8 review-lens: hardening before public demo, not a P0 blocker.)
func (s *Server) handleMetrics(w http.ResponseWriter, _ *http.Request) {
	if s.metrics == nil {
		writeJSON(w, http.StatusOK, metrics.Snapshot{})
		return
	}
	writeJSON(w, http.StatusOK, s.metrics.Snapshot())
}

// handleMetricsReset is an operator-only evidence hygiene hook for public load
// runs. It is disabled unless METRICS_RESET_TOKEN is configured, and it refuses
// to reset while clients are connected so the run-window snapshot starts clean.
func (s *Server) handleMetricsReset(w http.ResponseWriter, r *http.Request) {
	if s.cfg.MetricsResetToken == "" {
		writeErr(w, http.StatusNotFound, "metrics reset disabled")
		return
	}
	// Constant-time compare so a remote operator can't probe the token by
	// observing per-byte timing differences. Token is small and ASCII so the
	// fixed-cost compare is trivial relative to the request lifecycle.
	got := r.Header.Get("X-Lumen-Metrics-Reset-Token")
	if subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.MetricsResetToken)) != 1 {
		writeErr(w, http.StatusForbidden, "forbidden")
		return
	}
	if s.metrics == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"status": "ok",
			"pre":    metrics.Snapshot{},
			"post":   metrics.Snapshot{},
		})
		return
	}
	pre := s.metrics.Snapshot()
	if pre.ActiveConns != 0 {
		writeJSON(w, http.StatusConflict, map[string]any{
			"status":      "refused_active_connections",
			"activeConns": pre.ActiveConns,
			"pre":         pre,
		})
		return
	}
	s.metrics.Reset()
	post := s.metrics.Snapshot()
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "ok",
		"pre":    pre,
		"post":   post,
	})
}
