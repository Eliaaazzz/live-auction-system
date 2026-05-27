package invariants

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
)

// VerifierConsistent — post-drill `make verify` returns "consistent". This is
// the most expensive invariant (shells out to docker compose run verifier)
// but it's the strongest correctness statement: Stream + Redis + MySQL agree
// after the drill ended.
//
// Per V9 §10 T6 + docs/components/08-replay-verifier.md (two-mode design):
// the chaos runner always uses --mode settled (default) since the drill
// has finished by the time we check.
type VerifierConsistent struct{ env Env }

func NewVerifierConsistent(env Env) Invariant { return &VerifierConsistent{env: env} }

func (v *VerifierConsistent) Name() string { return "verifier_consistent_after_drill" }
func (v *VerifierConsistent) Description() string {
	return "tools/replay-verifier --mode settled returns 'consistent' on the drill's auction after recovery wait"
}

func (v *VerifierConsistent) Check(ctx context.Context) Result {
	// Run verifier against the auction. This shells out to the docker compose
	// verifier service. If the auction isn't terminal yet (and the drill
	// didn't trigger a hammer), verifier will report mismatch_at_seq or
	// hash_break — that's a real failure to surface.
	cmd := exec.CommandContext(ctx, "docker", "compose",
		"-f", "infra/docker-compose.yml",
		"--profile", "tools",
		"run", "--rm", "-e", "VERIFY_AID="+v.env.AuctionID,
		"verifier")
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	output := out.String()

	// Verifier exit codes (per docs/components/08-replay-verifier.md):
	//   0 = consistent
	//   1 = divergence (mismatch_at_seq)
	//   2 = hash break
	//   3 = internal error (couldn't reach Redis/MySQL)
	if err == nil {
		if strings.Contains(output, "consistent") {
			return Pass(v, "verifier exit 0; auction state agrees across Stream + Redis + MySQL")
		}
		return Fail(v, "verifier exit 0 but output didn't contain 'consistent': %s", output)
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		switch exitErr.ExitCode() {
		case 1:
			return Fail(v, "verifier reports mismatch_at_seq — drill broke state consistency: %s", output)
		case 2:
			return Fail(v, "verifier reports hash_break_at_seq — drill broke evidence chain: %s", output)
		case 3:
			return Fail(v, "verifier internal error — couldn't sample sources (drill may have killed prerequisite): %s", output)
		default:
			return Fail(v, "verifier unknown exit %d: %s", exitErr.ExitCode(), output)
		}
	}
	return Fail(v, "verifier command failed to run: %v (output: %s)", err, output)
}

func recoveryKey(base, sub string) string   { return fmt.Sprintf("%s::recovery::%s", base, sub) }
func snapshotKey(base, field string) string { return fmt.Sprintf("%s::snap::%s", base, field) }
func eventCountKey(base, t string) string   { return fmt.Sprintf("%s::events::%s", base, t) }
