// PR #18 contract test — asserts infra/README.md doesn't promise topology
// the current compose stack can't deliver. Eliaaazzz's PR #18 review suggested
// this exact check (Python); ported to Go so it runs in the existing
// `go test ./...` CI job.
package contractlint

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// readDoc reads a doc file relative to repo root. Helper duplicated from PR #16
// (which adds the same helper for component_docs_consistency_test.go); when PR
// #16 merges first, one of these definitions gets removed in rebase. Kept tiny
// so the duplication is harmless.
func readDoc(t *testing.T, relPath string) string {
	t.Helper()
	wd, _ := os.Getwd()
	for d := wd; d != "/" && d != ""; d = filepath.Dir(d) {
		if _, err := os.Stat(filepath.Join(d, "go.mod")); err == nil {
			b, err := os.ReadFile(filepath.Join(d, relPath))
			if err != nil {
				t.Fatalf("read %s: %v", relPath, err)
			}
			return string(b)
		}
	}
	t.Fatalf("could not find go.mod from %s", wd)
	return ""
}

// TestInfraReadmeMatchesT1Topology asserts the README compose example does not
// reference T5+ split services (which would break if copy-pasted into the
// current T1 docker-compose.yml).
func TestInfraReadmeMatchesT1Topology(t *testing.T) {
	readme := readDoc(t, "infra/README.md")

	// Split-service names from the deferred T5+ topology — these must not
	// appear in the README's runnable compose example. They CAN appear as
	// comments inside the compose-snippet describing future state, but only
	// inside an explicit "Pending"/"T5+"/"future"/"future state" context.
	badT1Services := []string{"lumen-bid-engine", "lumen-gateway"}
	for _, svc := range badT1Services {
		// Find every occurrence and check its surrounding 200-char context.
		// If any occurrence is NOT inside a "future"/"T5+"/"Pending"/"T1 prom"
		// context, fail.
		idx := 0
		for {
			at := strings.Index(readme[idx:], svc)
			if at < 0 {
				break
			}
			absolute := idx + at
			start := absolute - 200
			if start < 0 {
				start = 0
			}
			end := absolute + 200
			if end > len(readme) {
				end = len(readme)
			}
			ctx := strings.ToLower(readme[start:end])
			if !strings.Contains(ctx, "future") && !strings.Contains(ctx, "t5+") &&
				!strings.Contains(ctx, "pending") && !strings.Contains(ctx, "t5 split") &&
				!strings.Contains(ctx, "split-topology") && !strings.Contains(ctx, "split-process") {
				t.Errorf("infra/README.md references T5+ split service %q outside a future/T5/Pending context (offset %d)", svc, absolute)
				break
			}
			idx = absolute + len(svc)
		}
	}

	// Must mention the current single-service target so the example actually
	// works against today's compose.
	if !strings.Contains(readme, "lumen") {
		t.Error("infra/README.md must reference the current 'lumen' service target")
	}
}

// TestPrometheusConfigOnlyScrapesAvailableTargets asserts that scrape targets
// not yet exposed by the app binaries (lumen, ai-sidecar) appear ONLY in
// commented-out lines. Catches the "scrape target DOWN by default" regression
// where someone uncomments a future target before the binary adds /metrics.
func TestPrometheusConfigOnlyScrapesAvailableTargets(t *testing.T) {
	cfg := readDoc(t, "infra/prometheus/prometheus.yml")

	// `lumen:8080` and `ai-sidecar:9090` MUST only appear inside commented
	// lines (whitespace + leading `#`). Bare occurrences in YAML keys, list
	// items, or unquoted strings indicate the scrape is active.
	bad := []string{"lumen:8080", "ai-sidecar:9090"}
	for _, line := range strings.Split(cfg, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#") {
			continue
		}
		for _, b := range bad {
			if strings.Contains(line, b) {
				t.Errorf("prometheus.yml has active (uncommented) line targeting %q — comment out until app exposes /metrics:\n  %s", b, line)
			}
		}
	}
}
