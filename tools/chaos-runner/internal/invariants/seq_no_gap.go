package invariants

import (
	"context"
	"fmt"
)

// SeqNoGap — across the full drill window, the auction's seq advances
// monotonically by 1 (per V9 §4.1 "0 tolerance"). Uses the snapshot endpoint
// before and after drill; counts accepted bid events in between via the
// during-events sampler.
//
// This is the canonical V9 invariant; phase-agnostic.
type SeqNoGap struct{ env Env }

func NewSeqNoGap(env Env) Invariant { return &SeqNoGap{env: env} }

func (s *SeqNoGap) Name() string { return "seq_no_gap" }
func (s *SeqNoGap) Description() string {
	return "auction seq advances monotonically by 1 across the entire drill window (V9 §4.1 zero-tolerance)"
}

func (s *SeqNoGap) Check(ctx context.Context) Result {
	preSeq, ok := ctx.Value(snapshotKey(s.env.PreSnapshotKey, "seq")).(int64)
	if !ok {
		return Fail(s, "pre-drill snapshot seq missing from context")
	}
	postSeq, ok := ctx.Value(snapshotKey(s.env.PostSnapshotKey, "seq")).(int64)
	if !ok {
		return Fail(s, "post-drill snapshot seq missing from context")
	}
	accepted, _ := ctx.Value(eventCountKey(s.env.DuringEventsKey, "BID_ACCEPTED")).(int)
	terminal, _ := ctx.Value(eventCountKey(s.env.DuringEventsKey, "TERMINAL")).(int) // SOLD/NO_BID/CANCELLED

	// Per docs/components/03-lua-scripts.md (v2 — anti-snipe single Stream
	// entry): every accepted bid is exactly one seq tick. Terminal events
	// (close_auction / cancel_auction) consume one seq each. freeze/start
	// do NOT consume seq.
	expected := preSeq + int64(accepted) + int64(terminal)
	if postSeq != expected {
		return Fail(s, "seq=%d after drill, expected %d (pre=%d + accepted=%d + terminal=%d)",
			postSeq, expected, preSeq, accepted, terminal)
	}
	return Pass(s, fmt.Sprintf("seq went %d → %d across %d accepted + %d terminal events",
		preSeq, postSeq, accepted, terminal))
}

// (Earlier versions of this file kept an unused getSnapshot helper that hit
// `/api/auctions/{id}/snapshot` — the deprecated T1 route. Deleted in PR #24
// v3 per PDGGK CR P1-1; the canonical reader is `artifact.GetSnapshot` which
// hits the T2 route `/api/auctions/{id}`.)
