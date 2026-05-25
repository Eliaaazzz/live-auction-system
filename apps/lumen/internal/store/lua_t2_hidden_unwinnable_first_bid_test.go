package store

import (
	"context"
	"strconv"
	"testing"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

// Integration proof for the validation test above: if such a rule set reaches
// Redis, the Lua hot path correctly rejects the maximum representable bid and
// leaves no seq/price/stream side effects. That is safe at the hot-path layer,
// but it also proves the auction would be unwinnable if model.Rules.Validate
// allowed it through creation.
func TestT2HiddenNoCapFirstBidAboveMaxMoneyHasNoLuaSideEffects(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	max := strconv.FormatInt(int64(model.MaxMoneyCents), 10)

	r := model.Rules{
		StartPriceCents: model.MaxMoneyCents,
		IncrementCents:  1,
		CapPriceCents:   0,
		DurationSec:     60,
	}
	aid := liveAuction(t, s, r, 60_000)

	code, seq, payload, err := s.PlaceBid(ctx, aid, "u1", "cb-max", max, "U1")
	if err != nil {
		t.Fatal(err)
	}
	if code != model.CodeErrTooLow {
		t.Fatalf("max bid code=%s want %s", code, model.CodeErrTooLow)
	}
	if seq != 0 || payload != "" {
		t.Fatalf("rejected bid returned seq/payload: seq=%d payload=%q", seq, payload)
	}

	snap, err := s.Snapshot(ctx, aid)
	if err != nil {
		t.Fatal(err)
	}
	if snap.CurrentPriceCents != max || snap.WinnerID != "" || snap.Seq != 0 {
		t.Fatalf("rejected max bid mutated state: %+v", snap)
	}
	if n, err := s.rdb.XLen(ctx, streamKey(aid)).Result(); err != nil || n != 0 {
		t.Fatalf("rejected max bid wrote stream entries: len=%d err=%v", n, err)
	}
}
