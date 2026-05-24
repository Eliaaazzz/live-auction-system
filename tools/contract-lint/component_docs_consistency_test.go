// Package contractlint asserts internal consistency of contract-bearing
// documentation. Authored for PR #16 to enforce that the anti-snipe / OK_EXTENDED
// contract description is single-direction (no stale v1 / v2 design fragments
// alongside the current v3). Per Eliaaazzz's PR #16 review-comment suggestion;
// runs in the same `go test ./...` job as everything else, so doc drift fails
// CI rather than waiting for a human re-read.
package contractlint

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// repoRoot walks up from the test file location until it finds go.mod.
func repoRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for d := wd; d != "/" && d != ""; d = filepath.Dir(d) {
		if _, err := os.Stat(filepath.Join(d, "go.mod")); err == nil {
			return d
		}
	}
	t.Fatalf("could not find go.mod from %s", wd)
	return ""
}

func readDoc(t *testing.T, relPath string) string {
	t.Helper()
	root := repoRoot(t)
	b, err := os.ReadFile(filepath.Join(root, relPath))
	if err != nil {
		t.Fatalf("read %s: %v", relPath, err)
	}
	return string(b)
}

// TestAntiSnipeContractIsSingleDirection asserts the docs do not simultaneously
// claim T2's double-entry design AND my prior v1/v2 single-entry-with-flag
// design. Eliaaazzz's PR #16 review-comment Python snippet, ported to Go so it
// runs in the existing `go test ./...` job (no new CI workflow required).
func TestAntiSnipeContractIsSingleDirection(t *testing.T) {
	bidEngine := readDoc(t, "docs/components/02-bid-engine.md")
	lua := readDoc(t, "docs/components/03-lua-scripts.md")

	mentionsOKExtended := strings.Contains(bidEngine, "OK_EXTENDED") ||
		strings.Contains(lua, "OK_EXTENDED")
	// The exact "negation" strings from PR #16 v2 — these must NOT coexist with
	// OK_EXTENDED mentions, because they were the prior-design framing that
	// said OK_EXTENDED did not exist.
	saysNoOKExtended := strings.Contains(lua, "No `OK_EXTENDED` Lua return code") ||
		strings.Contains(lua, "no `OK_EXTENDED` Lua return code") ||
		strings.Contains(lua, "OK_EXTENDED` as a *T2+* reservation")
	if mentionsOKExtended && saysNoOKExtended {
		t.Errorf("docs both define and reject OK_EXTENDED (drift between v2 single-entry framing and v3 double-entry contract)")
	}

	mentionsAuctionExtendedEntry := strings.Contains(lua, "AUCTION_EXTENDED")
	saysNoSeparateExtendedEntry := strings.Contains(lua, "No separate `AUCTION_EXTENDED` Stream entry") ||
		strings.Contains(lua, "no separate `AUCTION_EXTENDED` Stream entry")
	if mentionsAuctionExtendedEntry && saysNoSeparateExtendedEntry {
		t.Errorf("docs both define and reject the AUCTION_EXTENDED Stream entry (v2/v3 drift)")
	}

	// Also reject the explicit v1 anti-snipe stream-id synthetic suffix outside
	// the design-history block (which uses "<seq>-1" intentionally to record
	// what was rejected).
	luaLines := strings.Split(lua, "\n")
	for i, line := range luaLines {
		l := strings.ToLower(line)
		// Allow historical mentions (wrapped in tildes / "RESOLVED" / "v1 used" /
		// "Honest design history") — only flag a NON-historical claim.
		if strings.Contains(line, "<seq>-1") &&
			!strings.Contains(l, "resolved") &&
			!strings.Contains(l, "history") &&
			!strings.Contains(l, "v1") &&
			!strings.Contains(l, "design") &&
			!strings.Contains(l, "wrong") &&
			!strings.Contains(l, "collision") &&
			!strings.Contains(l, "no <seq>-1") &&
			!strings.Contains(l, "not `<seq>-1`") &&
			!strings.Contains(l, "synthetic suffix") {
			t.Errorf("line %d still asserts <seq>-1 as the current design (v1 leak):\n  %s", i+1, line)
		}
	}
}

// TestMaxExtensionsDocumented asserts the MaxExtensions cap (added in PR #26)
// is documented in the lua-scripts component doc. Prevents future regressions
// where the runaway-anti-snipe gap reopens silently.
func TestMaxExtensionsDocumented(t *testing.T) {
	lua := readDoc(t, "docs/components/03-lua-scripts.md")
	if !strings.Contains(lua, "MaxExtensions") && !strings.Contains(lua, "maxExtensions") {
		t.Error("docs/components/03-lua-scripts.md must document the MaxExtensions cap (PR #26 finding #1)")
	}
}
