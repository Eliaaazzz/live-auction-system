package server

import (
	"crypto/sha256"
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
	// Hash both values first, then compare the fixed-size digests. Go's
	// ConstantTimeCompare returns early on length mismatch, so comparing raw
	// strings would still leak token length; digest comparison avoids that while
	// keeping this operator-only path simple.
	gotDigest := sha256.Sum256([]byte(r.Header.Get("X-Lumen-Metrics-Reset-Token")))
	wantDigest := sha256.Sum256([]byte(s.cfg.MetricsResetToken))
	if subtle.ConstantTimeCompare(gotDigest[:], wantDigest[:]) != 1 {
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
