// invariants — per-drill assertions. Each invariant produces a
// (passed bool, message string) result that lands in the artifact JSON.
//
// V9 §9 wants "assertable logs per chaos run, not just videos". This package
// is the assertable part.
package invariants

import (
	"context"
	"fmt"
)

// Invariant is one assertion. Implementations should be pure — only call
// out-of-process for sampling state, never to mutate.
type Invariant interface {
	Name() string
	// Description is a one-line human-readable rationale for the report.
	Description() string
	// Check is called AFTER Uninject + recovery wait. It can read pre-drill
	// snapshots and during-drill samples via the Ctx values the orchestrator
	// stashes (see ../orchestrator/context_keys.go).
	Check(ctx context.Context) Result
}

// Result is the per-invariant outcome.
type Result struct {
	Name        string `json:"name"`
	Passed      bool   `json:"passed"`
	Message     string `json:"message"`
	Description string `json:"description"`
}

// Pass / Fail helpers — keep call sites readable.
func Pass(i Invariant, msg string) Result {
	return Result{Name: i.Name(), Description: i.Description(), Passed: true, Message: msg}
}

func Fail(i Invariant, msg string, args ...any) Result {
	return Result{
		Name: i.Name(), Description: i.Description(),
		Passed: false, Message: fmt.Sprintf(msg, args...),
	}
}

// Per-phase invariant selection. The orchestrator calls this to pick which
// invariants apply to a given drill. Phase-agnostic invariants (e.g. seq
// monotonicity post-drill) run for every phase.
func For(phaseName string, env Env) []Invariant {
	common := []Invariant{
		NewSeqNoGap(env),
		NewRecoveryWithin(env),
		NewVerifierConsistent(env),
		NewLatencyEnvelope(env),
	}
	// Per-phase additions
	switch phaseName {
	case "ai":
		// AI is non-authoritative — bid acceptance must continue throughout.
		// No degrade invariant for AI phase (ExpectedDegradeWireCodes() = nil).
		return common
	case "redis":
		return append(common, NewDegradeExpected(env, "ERR_AUCTION_PAUSED"))
	case "ws":
		// Catchup correctness for the reconnect case will be a future invariant.
		return common
	default:
		return common
	}
}

// Env is the runtime context invariants need. Kept separate from the
// orchestrator Config so this package can be tested in isolation.
type Env struct {
	LumenBaseURL string
	AuctionID    string

	// Sampling windows the orchestrator populated via the Ctx
	// (see context_keys.go in orchestrator). Invariants read them via Check.
	PreSnapshotKey      string
	PostSnapshotKey     string
	DuringEventsKey     string
	RecoveryDeadlineKey string
}
