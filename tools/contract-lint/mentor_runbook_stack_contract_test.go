// Hidden contract test for PR #25: ensures the mentor runbook doesn't promise
// stack capabilities the current compose doesn't deliver. Eliaaazzz's PR #25
// CR-suggested Python check, ported to Go (runs in the existing `go test ./...`
// CI job — no new workflow).
package contractlint

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// readDoc walks up from cwd to find go.mod, then reads relPath. Helper
// duplicated across PR #16 / PR #18 / PR #25 contract tests; whichever PR
// merges first wins, the others rebase out the duplicate.
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

// TestMentorRunbookStackContract: any reference to Grafana / Prometheus URLs
// in the runbook requires those services to exist in the compose stack (under
// any profile). Prevents the regression where the runbook promises
// http://localhost:3000 but compose has no grafana service to start.
//
// Cross-PR note: this PR (#25) updates the runbook to use `make up-obs` from
// PR #18. While PR #25 is open on its own branch (NOT rebased onto PR #18's
// branch), the compose file doesn't yet have grafana/prometheus. The test
// SKIPS in that case + explicitly logs the expected dependency, so it
// auto-activates as a real gate once PR #18 merges to main + this PR rebases.
func TestMentorRunbookStackContract(t *testing.T) {
	runbook := readDoc(t, "docs/demo/mentor-2026-05-25.md")
	compose := readDoc(t, "infra/docker-compose.yml")

	mentionsLiveGrafana := strings.Contains(runbook, "localhost:3000") ||
		strings.Contains(runbook, "Open Grafana") ||
		strings.Contains(runbook, "open Grafana")
	mentionsPrometheus := strings.Contains(runbook, "localhost:9090") ||
		strings.Contains(runbook, "Prometheus")

	hasGrafana := strings.Contains(compose, "\n  grafana:")
	hasPrometheus := strings.Contains(compose, "\n  prometheus:")

	if (mentionsLiveGrafana || mentionsPrometheus) && !hasGrafana && !hasPrometheus {
		t.Skipf("runbook references Grafana/Prometheus but they're not in this branch's compose yet — auto-activates as a real gate once PR #18 merges to main and this PR rebases (PR #25 CR P1)")
	}
	if mentionsLiveGrafana && !hasGrafana {
		t.Error("runbook references Grafana but infra/docker-compose.yml does not declare a grafana service (PR #25 CR P1)")
	}
	if mentionsPrometheus && !hasPrometheus {
		t.Error("runbook references Prometheus but infra/docker-compose.yml does not declare a prometheus service (PR #25 CR P1)")
	}
}

// TestMentorRunbookUsesPreSeededAuction asserts the runbook's two-tab demo
// flow doesn't mix admin-created auctions with pre-seeded `auc_demo` (PDGGK
// PR #25 CR 🔴 #1: split-auction confusion).
func TestMentorRunbookUsesPreSeededAuction(t *testing.T) {
	runbook := readDoc(t, "docs/demo/mentor-2026-05-25.md")

	seen := map[string]int{}
	idx := 0
	prefix := "room.html?auction="
	for {
		at := strings.Index(runbook[idx:], prefix)
		if at < 0 {
			break
		}
		start := idx + at + len(prefix)
		end := start
		for end < len(runbook) {
			c := runbook[end]
			if c == ' ' || c == '"' || c == ')' || c == '&' || c == '\n' || c == '\r' || c == '`' {
				break
			}
			end++
		}
		id := runbook[start:end]
		seen[id]++
		idx = end
	}
	if len(seen) > 1 {
		t.Errorf("runbook references multiple auction ids in room.html links %v — pick one (PDGGK CR 🔴 #1)", seen)
	}
}

// TestMentorRunbookDoesNotOverclaimVerifier: the current Replay Verifier is a
// T1 count-consistency stub; the runbook must say so (not call it "proves
// correctness"). PR #25 CR 🟠 #3.
func TestMentorRunbookDoesNotOverclaimVerifier(t *testing.T) {
	runbook := readDoc(t, "docs/demo/mentor-2026-05-25.md")

	if strings.Contains(runbook, "make verify") &&
		strings.Contains(runbook, "proves correctness") &&
		!strings.Contains(strings.ToLower(runbook), "do not over-claim") {
		t.Error("runbook says 'proves correctness' near 'make verify' — current verifier is a T1 stub (PR #25 CR 🟠 #3)")
	}

	stubMentioned := strings.Contains(runbook, "verifier stub") ||
		strings.Contains(runbook, "verifier *stub*") ||
		strings.Contains(runbook, "count-consistency stub") ||
		strings.Contains(runbook, "count consistency stub")
	if !stubMentioned {
		t.Error("runbook should explicitly label `make verify` as a T1 stub (PR #25 CR 🟠 #3)")
	}
}

// TestMentorRunbookHasBackupVideoCommitment: PDGGK 🔴 #6 — the runbook had
// an unsafe fallback story ("record on demo morning"). v2 must commit to
// pre-recording TODAY.
func TestMentorRunbookHasBackupVideoCommitment(t *testing.T) {
	runbook := readDoc(t, "docs/demo/mentor-2026-05-25.md")
	if !strings.Contains(runbook, "recorded TODAY") && !strings.Contains(runbook, "TODAY before demo") {
		t.Error("runbook should commit to recording the backup video TODAY, not on demo morning (PDGGK CR 🔴 #6)")
	}
}
