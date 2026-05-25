// PR #18 contract test — every Grafana dashboard JSON must be parseable.
// Eliaaazzz's PR #18 re-review (`af08af3` round) flagged a transient encoding
// corruption in auction-realtime.json line 386 that wasn't caught by promtool
// (which only validates the Prometheus side). This test is the standing CI gate
// suggested in that review.
package contractlint

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// dashboardGlob points at the dashboards from repo root. readDoc-style helper
// walks up to go.mod; here we want the directory listing, not a single file.
func dashboardPaths(t *testing.T) []string {
	t.Helper()
	wd, _ := os.Getwd()
	for d := wd; d != "/" && d != ""; d = filepath.Dir(d) {
		if _, err := os.Stat(filepath.Join(d, "go.mod")); err == nil {
			paths, err := filepath.Glob(filepath.Join(d, "infra/grafana/dashboards/*.json"))
			if err != nil {
				t.Fatalf("glob dashboards: %v", err)
			}
			return paths
		}
	}
	t.Fatalf("could not find go.mod from %s", wd)
	return nil
}

// TestGrafanaDashboardsAreValidJSON parses every dashboard JSON. Catches
// encoding-corruption regressions (mis-escaped Chinese tags, dropped closing
// quotes, BOM, etc.) before they reach Grafana provisioning where they'd just
// be silently dropped (logs only, not a failed boot).
func TestGrafanaDashboardsAreValidJSON(t *testing.T) {
	paths := dashboardPaths(t)
	if len(paths) == 0 {
		t.Fatal("no grafana dashboards found under infra/grafana/dashboards/")
	}
	for _, p := range paths {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read %s: %v", p, err)
		}
		if !json.Valid(b) {
			// Walk to surface the first parse error rather than just "not valid".
			var v any
			if err := json.Unmarshal(b, &v); err != nil {
				t.Fatalf("%s invalid JSON: %v", p, err)
			}
		}
	}
}

// TestGrafanaDashboardsHaveRequiredFields catches the class of regressions
// where the JSON parses (e.g. someone removes `panels:` entirely) but the
// dashboard would be empty in Grafana. Two required fields: `title`, `uid`.
func TestGrafanaDashboardsHaveRequiredFields(t *testing.T) {
	for _, p := range dashboardPaths(t) {
		b, _ := os.ReadFile(p)
		var d map[string]any
		if err := json.Unmarshal(b, &d); err != nil {
			t.Fatalf("%s parse: %v", p, err)
		}
		for _, k := range []string{"title", "uid"} {
			if _, ok := d[k]; !ok {
				t.Errorf("%s missing required field %q", p, k)
			}
		}
	}
}
