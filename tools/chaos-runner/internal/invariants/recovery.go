package invariants

import (
	"context"
	"fmt"
	"time"
)

// RecoveryWithin — after Uninject, the next bid attempt returns OK_ACCEPTED
// within the phase's RecoveryDeadline. Detects "service stayed broken even
// though the fault was lifted" — the worst silent failure mode.
type RecoveryWithin struct{ env Env }

func NewRecoveryWithin(env Env) Invariant { return &RecoveryWithin{env: env} }

func (r *RecoveryWithin) Name() string { return "recovery_within" }
func (r *RecoveryWithin) Description() string {
	return "first bid attempt after Uninject returns OK_ACCEPTED within the phase's RecoveryDeadline"
}

func (r *RecoveryWithin) Check(ctx context.Context) Result {
	// Pulled from the during-events sampler — the steady-bid generator records
	// each attempt with timestamp + wire code. First OK_ACCEPTED with a
	// timestamp > drill-end is the recovery moment.
	first, ok := ctx.Value(recoveryKey(r.env.DuringEventsKey, "first_ok_after_uninject")).(*time.Time)
	if !ok || first == nil {
		return Fail(r, "no OK_ACCEPTED observed after Uninject — did recovery actually happen?")
	}
	uninjectAt, ok := ctx.Value(recoveryKey(r.env.DuringEventsKey, "uninject_at")).(time.Time)
	if !ok {
		return Fail(r, "uninject timestamp not recorded — orchestrator bug")
	}
	deadline, _ := ctx.Value(r.env.RecoveryDeadlineKey).(time.Duration)
	if deadline == 0 {
		deadline = 30 * time.Second
	}
	gap := first.Sub(uninjectAt)
	if gap > deadline {
		return Fail(r, "first OK_ACCEPTED at +%s (deadline %s)", gap, deadline)
	}
	return Pass(r, fmt.Sprintf("first OK_ACCEPTED at +%s (deadline %s)", gap.Round(time.Millisecond), deadline))
}
