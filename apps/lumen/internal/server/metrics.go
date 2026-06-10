package server

import (
	"net/http"
	"os"
	"strings"

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

// handleMetricsReset resets in-process metrics for a clean harness run.
//
// This endpoint is intentionally constrained to APP_ENV=dev so production
// deployments do not expose a writable observability control path.
func (s *Server) handleMetricsReset(w http.ResponseWriter, r *http.Request) {
	if s.cfg.AppEnv != "dev" {
		http.Error(w, "metrics reset forbidden", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.metrics == nil {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		return
	}
	resetToken := strings.TrimSpace(os.Getenv("LUMEN_METRICS_RESET_TOKEN"))
	if resetToken != "" && strings.TrimSpace(r.Header.Get("X-Lumen-Metrics-Reset")) != resetToken {
		http.Error(w, "bad reset token", http.StatusUnauthorized)
		return
	}
	s.metrics.ResetForLoadRun()
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}
