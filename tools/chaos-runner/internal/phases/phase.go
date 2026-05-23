// Phase encodes a single fault-injection scenario.
//
// Per docs/components/14-chaos.md + V9 §4.4 (5 fault drills demo-required).
// This skeleton ships the AI phase fully implemented as the safest first
// drill (sidecar is non-authoritative; killing it must not affect bid
// acceptance — that's the demo-day claim we want to record).
//
// Phase taxonomy — 5 standard (per V9 / PR #21 diagram #5) + 3 NEW proposed
// (see ../README.md § "Phase taxonomy: standard + diversification"):
//
//	standard:    ai, redis, mysql, ws, timer
//	diversified: slowclient, schrodinger, tamper
//	stretch:     halfpartition (deferred)
package phases

import (
	"context"
	"errors"
	"fmt"
)

// ErrNotImplemented is returned by Lookup for phases that have a spec in this
// package but haven't been wired end-to-end yet. The CLI surfaces this as
// exit code 78 so CI can distinguish "not built" from "ran but failed".
var ErrNotImplemented = errors.New("phase not yet implemented")

// Phase is one fault scenario. Implementations should be re-runnable:
// Inject must be idempotent; Uninject must always restore even after a panic.
type Phase interface {
	// Name returns the canonical phase name (matches CLI --phase).
	Name() string

	// Kind classifies the phase for invariant selection + reporting.
	// "process_kill": container/process killed and restarted (e.g. ai, ws, timer)
	// "network":      toxiproxy/iptables fault between processes (e.g. redis, mysql, schrodinger)
	// "data":         deliberate state corruption (e.g. tamper)
	// "client":       client-side stress (e.g. slowclient)
	Kind() string

	// Inject installs the fault. Must return an undo func that the orchestrator
	// MUST call (deferred) regardless of subsequent errors.
	Inject(ctx context.Context, env Env) (undo func(context.Context) error, err error)

	// ExpectedDegradeWireCodes returns the BID_REJECTED wire codes the runner
	// should *expect* to see from bid attempts during the drill window. Empty
	// means "no degrade expected; bidding should continue unaffected".
	// Used by the `degrade` invariant.
	ExpectedDegradeWireCodes() []string

	// RecoveryDeadline is the max time the runner waits, after Uninject, for
	// bid acceptance to resume. Used by the `recovery` invariant.
	RecoveryDeadline() (deadline string)
}

// Env exposes the runtime knobs phases need. Kept narrow on purpose — phases
// should not reach into the orchestrator. If a phase needs more, the
// interface grows here (visible diff for all-member approve).
type Env struct {
	// LumenBaseURL is the lumen REST + WS root (e.g. http://localhost:8080)
	LumenBaseURL string
	// ToxiproxyURL is the admin API for network-level faults
	ToxiproxyURL string
	// ComposeProject is the docker-compose project name (for process kills);
	// defaults to "infra" per PR #19 compose layout
	ComposeProject string
}

// Lookup resolves a CLI phase name to a Phase. Returns ErrNotImplemented
// (sentinel) for known but unimplemented phases so CLI can exit 78 instead
// of failing as an unknown phase (exit 2).
func Lookup(name string) (Phase, error) {
	switch name {
	case "ai":
		return &aiPhase{}, nil
	case "redis":
		return nil, fmt.Errorf("redis: %w", ErrNotImplemented)
	case "mysql":
		return nil, fmt.Errorf("mysql: %w", ErrNotImplemented)
	case "ws":
		return nil, fmt.Errorf("ws: %w", ErrNotImplemented)
	case "timer":
		return nil, fmt.Errorf("timer: %w", ErrNotImplemented)
	case "slowclient":
		return nil, fmt.Errorf("slowclient: %w", ErrNotImplemented)
	case "schrodinger":
		return nil, fmt.Errorf("schrodinger: %w", ErrNotImplemented)
	case "tamper":
		return nil, fmt.Errorf("tamper: %w", ErrNotImplemented)
	default:
		return nil, fmt.Errorf("unknown phase %q", name)
	}
}

// AllNames returns the full taxonomy (implemented + stubbed) for help text /
// dashboard population.
func AllNames() []string {
	return []string{
		// standard (V9 §4.4 + PR #21 diagram #5)
		"ai", "redis", "mysql", "ws", "timer",
		// diversified (this PR's proposal — pending team ratify)
		"slowclient", "schrodinger", "tamper",
	}
}
