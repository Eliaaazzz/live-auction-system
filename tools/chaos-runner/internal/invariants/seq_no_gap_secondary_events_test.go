package invariants

// PR #24 CR Eliaaazzz 5/25: the old seq_no_gap formula
//   expected = preSeq + accepted + terminal
// undercounted because T2 emits a secondary AUCTION_EXTENDED at its own seq on
// every anti-snipe extension, and the bidder's readPump skipped those room
// events without recording them — so a correct anti-snipe auction would fail
// the invariant. This test pins the v2 formula (postSeq - preSeq ==
// SeqConsumingObserved) against several scenarios the old formula would mis-
// diagnose, and verifies the new formula classifies them correctly.

import (
	"context"
	"strings"
	"testing"
)

type seqNoGapScenario struct {
	name            string
	preSeq, postSeq int64
	accepted        int
	terminal        int
	seqConsuming    int
	wantPass        bool
	wantInMsg       string // substring that should appear in the result message
}

func TestSeqNoGapHandlesSecondaryEvents(t *testing.T) {
	cases := []seqNoGapScenario{
		{
			name:   "happy_no_extensions",
			preSeq: 100, postSeq: 110,
			accepted: 10, terminal: 0, seqConsuming: 10,
			wantPass:  true,
			wantInMsg: "100 → 110 across 10 seq-consuming",
		},
		{
			name:   "anti_snipe_3_extensions_OLD_FORMULA_WOULD_RED",
			preSeq: 100, postSeq: 116, // 10 accepts + 3 EXTENDED + 3 SOLD-secondary edge = 16 seqs
			accepted: 10, terminal: 0, seqConsuming: 16,
			wantPass:  true,
			wantInMsg: "100 → 116 across 16 seq-consuming",
		},
		{
			name:   "timer_hammer_after_accepts",
			preSeq: 100, postSeq: 111, // 10 accepts + 1 SOLD-from-hammer = 11
			accepted: 10, terminal: 1, seqConsuming: 11,
			wantPass: true,
		},
		{
			name:   "real_gap_detected",
			preSeq: 100, postSeq: 113, // observed 10, but state advanced 13 → gap somewhere
			accepted: 10, terminal: 0, seqConsuming: 10,
			wantPass:  false,
			wantInMsg: "seq=113 after drill, expected 110",
		},
		{
			name:   "cap_hit_emits_secondary_SOLD",
			preSeq: 100, postSeq: 112, // 10 accepts + 1 cap-hit SOLD secondary + 1 cancel? actually scenario is 10 BID_ACCEPTED + 1 AUCTION_SOLD secondary = 11
			accepted: 10, terminal: 0, seqConsuming: 11,
			wantPass:  false, // 102 expected, 112 observed → would fail (gap of 1)
			wantInMsg: "seq=112 after drill, expected 111",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			env := Env{
				LumenBaseURL:    "http://localhost:8080",
				AuctionID:       "auc_demo",
				PreSnapshotKey:  "pre",
				PostSnapshotKey: "post",
				DuringEventsKey: "during",
			}
			ng := NewSeqNoGap(env).(*SeqNoGap)
			ctx := context.Background()
			ctx = context.WithValue(ctx, snapshotKey("pre", "seq"), c.preSeq)
			ctx = context.WithValue(ctx, snapshotKey("post", "seq"), c.postSeq)
			ctx = context.WithValue(ctx, eventCountKey("during", "BID_ACCEPTED"), c.accepted)
			ctx = context.WithValue(ctx, eventCountKey("during", "TERMINAL"), c.terminal)
			ctx = context.WithValue(ctx, eventCountKey("during", "SEQ_CONSUMING_OBSERVED"), c.seqConsuming)
			r := ng.Check(ctx)
			if r.Passed != c.wantPass {
				t.Errorf("Passed=%v want %v; message=%s", r.Passed, c.wantPass, r.Message)
			}
			if c.wantInMsg != "" && !strings.Contains(r.Message, c.wantInMsg) {
				t.Errorf("message missing substring %q; got: %s", c.wantInMsg, r.Message)
			}
		})
	}
}

// TestSeqNoGapDiagnosticHasSecondaryBreakdown asserts the failure message
// surfaces the (seqConsuming - accepted - terminal) decomposition so a future
// reviewer can tell whether the gap is at the primary (BID_ACCEPTED) or
// secondary (EXTENDED/SOLD-cap) layer at a glance.
func TestSeqNoGapDiagnosticHasSecondaryBreakdown(t *testing.T) {
	env := Env{
		PreSnapshotKey:  "pre",
		PostSnapshotKey: "post",
		DuringEventsKey: "during",
	}
	ng := NewSeqNoGap(env).(*SeqNoGap)
	ctx := context.Background()
	ctx = context.WithValue(ctx, snapshotKey("pre", "seq"), int64(100))
	ctx = context.WithValue(ctx, snapshotKey("post", "seq"), int64(120))
	ctx = context.WithValue(ctx, eventCountKey("during", "BID_ACCEPTED"), 10)
	ctx = context.WithValue(ctx, eventCountKey("during", "TERMINAL"), 1)
	ctx = context.WithValue(ctx, eventCountKey("during", "SEQ_CONSUMING_OBSERVED"), 14)

	r := ng.Check(ctx)
	if r.Passed {
		t.Fatal("expected fail (postSeq=120, expected 114)")
	}
	for _, sub := range []string{"breakdown", "accepted=10", "terminal=1", "secondary=3"} {
		if !strings.Contains(r.Message, sub) {
			t.Errorf("diagnostic missing %q in message: %s", sub, r.Message)
		}
	}
}
