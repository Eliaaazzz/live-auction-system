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
//
// Per PDGGK PR #24 CR P1-2: for phases where bidding is supposed to remain
// unaffected by the fault (ai / ws / timer / mysql / tamper), the latency
// envelope demands ≥1 OK_ACCEPTED *inside the injection window*, not just
// across the drill. Network phases (redis, schrodinger) where partial pause
// is the documented degrade do NOT require during-window accepts.
func For(phaseName string, env Env) []Invariant {
	switch phaseName {
	case "ai", "ws", "timer", "mysql", "tamper":
		env.RequireAcceptDuringInjection = true
	}

	common := []Invariant{
		NewSeqNoGap(env),
		NewRecoveryWithin(env),
		NewVerifierConsistent(env),
		NewLatencyEnvelope(env),
	}
	// Per-phase additions
	switch phaseName {
	case "redis":
		return append(common, NewDegradeExpected(env, "ERR_AUCTION_PAUSED"))
	}
	return common
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

	// RequireAcceptDuringInjection — set by For() per phase. When true,
	// LatencyEnvelope.Check fails if zero OK_ACCEPTED arrived inside
	// the injection window (PR #24 CR P1-2).
	RequireAcceptDuringInjection bool
}
