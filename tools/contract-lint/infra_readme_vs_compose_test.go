// PR #18 contract test — catches the README-vs-compose drift class Eliaaazzz
// flagged in the 5/25 02:25 CR. The README earlier inlined a compose snippet
// that claimed `depends_on: ai-sidecar` and `DATA_SOURCE_NAME` env vars; the
// real file uses `depends_on: lumen: service_healthy` and `--config.my-cnf` +
// `--mysqld.address`. Drift like this misleads operators into copy-pasting
// stanzas that won't actually run.
//
// Strategy: rather than re-implementing YAML diff, this test pins the README
// against a small set of specific MISLEADING strings that should ONLY appear
// in the real compose file. If the README revives them, the test fails.
package contractlint

import (
	"strings"
	"testing"
)

// TestInfraReadmeDoesNotInlineDriftingComposeSnippet enforces that the README
// does not contain the specific compose-stanza fragments that previously
// drifted out of sync. Allow-listed phrases (e.g., "depends_on: ai-sidecar"
// inside an explicit "earlier revision" / "drifted" context) are fine.
func TestInfraReadmeDoesNotInlineDriftingComposeSnippet(t *testing.T) {
	readme := readDoc(t, "infra/README.md")

	// Each pattern is a string that, if present OUTSIDE an "drifted"/"earlier"
	// context, indicates the README is re-inlining the broken snippet.
	misleading := []string{
		// Old prometheus block: depended on ai-sidecar (real one only depends on lumen).
		"      - ai-sidecar",
		// Old mysqld-exporter env: real one uses --config.my-cnf + --mysqld.address.
		"DATA_SOURCE_NAME=lumen",
	}

	for _, m := range misleading {
		idx := 0
		for {
			at := strings.Index(readme[idx:], m)
			if at < 0 {
				break
			}
			absolute := idx + at
			start := absolute - 250
			if start < 0 {
				start = 0
			}
			end := absolute + len(m) + 250
			if end > len(readme) {
				end = len(readme)
			}
			ctx := strings.ToLower(readme[start:end])
			// Allow-list: explicit historical / drifted / earlier-revision framing
			allowed := strings.Contains(ctx, "drifted") ||
				strings.Contains(ctx, "earlier revision") ||
				strings.Contains(ctx, "earlier version") ||
				strings.Contains(ctx, "previously") ||
				strings.Contains(ctx, "old snippet") ||
				strings.Contains(ctx, "instead of")
			if !allowed {
				t.Errorf("infra/README.md contains drift pattern %q outside a historical/drift context (PR #18 CR Eliaaazzz 5/25):\n  context: %s",
					m, strings.ReplaceAll(readme[start:end], "\n", "\\n"))
				break
			}
			idx = absolute + len(m)
		}
	}
}

// TestInfraReadmePointsAtAuthoritativeCompose: the README must explicitly state
// that the compose file itself is authoritative, so a future contributor
// doesn't re-introduce a duplicate inline snippet that drifts again.
func TestInfraReadmePointsAtAuthoritativeCompose(t *testing.T) {
	readme := readDoc(t, "infra/README.md")
	if !strings.Contains(readme, "infra/docker-compose.yml") {
		t.Error("infra/README.md must reference infra/docker-compose.yml as the authoritative source")
	}
	// Phrases that document intent — at least one must appear so the no-snippet
	// policy is visible.
	intent := []string{
		"authoritative source",
		"don't copy this README",
		"point at the real",
		"not a snippet here",
	}
	any := false
	low := strings.ToLower(readme)
	for _, p := range intent {
		if strings.Contains(low, strings.ToLower(p)) {
			any = true
			break
		}
	}
	if !any {
		t.Errorf("infra/README.md should explicitly state that docker-compose.yml is the authoritative source (PR #18 CR Eliaaazzz 5/25). Expected one of: %v", intent)
	}
}
