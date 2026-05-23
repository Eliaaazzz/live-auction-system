package invariants

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
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

// fetchSnapshot helper used by NewRecoveryWithin + NewVerifierConsistent below.
// Lives here because all 3 invariants hit the same endpoint.
type snapshot struct {
	Status            string `json:"status"`
	CurrentPriceCents string `json:"currentPriceCents"`
	WinnerID          string `json:"winnerId"`
	Seq               int64  `json:"seq"`
	ServerTimeMs      int64  `json:"serverTimeMs"`
}

func getSnapshot(ctx context.Context, baseURL, aid string) (*snapshot, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("%s/api/auctions/%s/snapshot", baseURL, aid), nil)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("snapshot returned %d", resp.StatusCode)
	}
	var s snapshot
	if err := json.NewDecoder(resp.Body).Decode(&s); err != nil {
		return nil, fmt.Errorf("decode snapshot: %w", err)
	}
	return &s, nil
}
