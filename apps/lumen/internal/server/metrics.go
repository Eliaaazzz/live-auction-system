package server

import (
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
