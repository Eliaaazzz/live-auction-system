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

// TestMentorRunbookStackContract: the runbook must not contain a *live demo
// step* that depends on services the compose stack on this branch can't run.
// Per PDGGK PR #25 CR Option B + v3, the runbook is intentionally decoupled
// from observability — `localhost:3000` / `make up-obs` are not in any live
// command. Textual / changelog references are allowed.
//
// Rule: any occurrence of localhost:3000 or `make up-obs` is OK iff it sits
// inside a context that contains "removed", "decoupled", "deliberately",
// "Option B", "changelog", "v3 changes", or "follow-up" within 200 chars.
// Any unambiguous live-step occurrence fails the test.
func TestMentorRunbookStackContract(t *testing.T) {
	runbook := readDoc(t, "docs/demo/mentor-2026-05-25.md")
	compose := readDoc(t, "infra/docker-compose.yml")

	hasGrafana := strings.Contains(compose, "\n  grafana:")

	liveMarkers := []string{"localhost:3000", "make up-obs", "Open Grafana", "open Grafana"}
	for _, m := range liveMarkers {
		for _, ctx := range contextsAround(runbook, m, 200) {
			low := strings.ToLower(ctx)
			docOnly := strings.Contains(low, "removed") ||
				strings.Contains(low, "decoupled") ||
				strings.Contains(low, "deliberately") ||
				strings.Contains(low, "option b") ||
				strings.Contains(low, "changelog") ||
				strings.Contains(low, "v3 changes") ||
				strings.Contains(low, "follow-up") ||
				strings.Contains(low, "promise") ||
				strings.Contains(low, "fallback") ||
				strings.Contains(low, "ask")
			if !docOnly {
				t.Errorf("runbook contains live reference to %q outside a doc/changelog/decoupled context (PR #25 CR Option B):\n  context: %s",
					m, strings.ReplaceAll(ctx, "\n", "\\n"))
			}
		}
	}

	// If compose ever DOES add grafana, the runbook may freely reactivate
	// the live demo step (since this branch only forbids it because compose
	// can't deliver). This explicit branch documents the intent.
	if hasGrafana {
		t.Log("compose has grafana service — runbook free to add live demo step in a follow-up PR")
	}
}

// contextsAround returns every 200-char window around each occurrence of
// `needle` in `s`. Used by TestMentorRunbookStackContract to inspect whether
// a live-stack reference is in a doc/changelog context vs an active step.
func contextsAround(s, needle string, halfWidth int) []string {
	var out []string
	idx := 0
	for {
		at := strings.Index(s[idx:], needle)
		if at < 0 {
			break
		}
		abs := idx + at
		start := abs - halfWidth
		if start < 0 {
			start = 0
		}
		end := abs + len(needle) + halfWidth
		if end > len(s) {
			end = len(s)
		}
		out = append(out, s[start:end])
		idx = abs + len(needle)
	}
	return out
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
