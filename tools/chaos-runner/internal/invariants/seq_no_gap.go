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

	// Eliaaazzz PR #24 CR 5/25: the prior formula
	//   expected = preSeq + accepted + terminal
	// undercounted because T2 emits secondary AUCTION_EXTENDED at its own
	// seq on every anti-snipe extension, and a cap-hit emits AUCTION_SOLD at
	// its own seq alongside the BID_ACCEPTED. The bidder's readPump observes
	// these room broadcasts but does not return them to the fire-loop, so
	// neither `accepted` nor `terminal` counts them — a correct anti-snipe
	// auction would red on a stale "seq advanced past expected" diagnostic.
	//
	// Fix: count every Stream-bearing event the bidder observes via
	// RecordSeqConsumingEvent (BID_ACCEPTED + AUCTION_EXTENDED + AUCTION_SOLD
	// + AUCTION_NO_BID + AUCTION_CANCELLED — exactly the set that emits one
	// XADD at <seq>-0 each). The invariant becomes
	//   postSeq - preSeq == seqConsumingObserved
	// which holds for any correct auction regardless of anti-snipe activity
	// or cap behavior.
	seqConsuming, _ := ctx.Value(eventCountKey(s.env.DuringEventsKey, "SEQ_CONSUMING_OBSERVED")).(int)
	expected := preSeq + int64(seqConsuming)
	if postSeq != expected {
		// Diagnostic also includes the legacy breakdown so a failure tells
		// you whether the gap is at the secondary-event layer (extended/cap
		// SOLD vs accepted+terminal split).
		accepted, _ := ctx.Value(eventCountKey(s.env.DuringEventsKey, "BID_ACCEPTED")).(int)
		terminal, _ := ctx.Value(eventCountKey(s.env.DuringEventsKey, "TERMINAL")).(int)
		return Fail(s,
			"seq=%d after drill, expected %d (pre=%d + seq_consuming_observed=%d) "+
				"[breakdown: accepted=%d terminal=%d secondary=%d]",
			postSeq, expected, preSeq, seqConsuming,
			accepted, terminal, seqConsuming-accepted-terminal)
	}
	return Pass(s, fmt.Sprintf("seq advanced %d → %d across %d seq-consuming Stream events (BID_ACCEPTED + AUCTION_EXTENDED + AUCTION_SOLD + AUCTION_NO_BID + AUCTION_CANCELLED)",
		preSeq, postSeq, seqConsuming))
}

// (Earlier versions of this file kept an unused getSnapshot helper that hit
// `/api/auctions/{id}/snapshot` — the deprecated T1 route. Deleted in PR #24
// v3 per PDGGK CR P1-1; the canonical reader is `artifact.GetSnapshot` which
// hits the T2 route `/api/auctions/{id}`.)
