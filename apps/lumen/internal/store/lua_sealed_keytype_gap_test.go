package store

import (
	"context"
	"testing"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

func TestCloseSealedModesWrongTypeReturnsErrInternalNoMutation(t *testing.T) {
	for _, tt := range []struct {
		name string
		mode string
	}{
		{name: "sealed_first", mode: model.ModeSealedFirst},
		{name: "all_pay", mode: model.ModeAllPay},
	} {
		t.Run(tt.name, func(t *testing.T) {
			s := newTestStore(t)
			ctx := context.Background()
			r := defaultRules()
			r.Mode = tt.mode
			aid := liveAuction(t, s, r, 60_000)

			if code, seq, _, err := s.PlaceBidSealed(ctx, aid, "alice", "a1", "12000", "Alice"); err != nil || code != model.CodeOKAccepted || seq != 1 {
				t.Fatalf("sealed bid: code=%s seq=%d err=%v want OK_ACCEPTED/1", code, seq, err)
			}
			if err := s.rdb.HSet(ctx, stateKey(aid), "endAtMs", 1).Err(); err != nil {
				t.Fatal(err)
			}
			if err := s.rdb.Del(ctx, sealedKey(aid)).Err(); err != nil {
				t.Fatal(err)
			}
			if err := s.rdb.Set(ctx, sealedKey(aid), "wrong-type", 0).Err(); err != nil {
				t.Fatal(err)
			}

			code, due, err := s.CloseAuction(ctx, aid)
			if err != nil || code != model.CodeErrInternal || due != 0 {
				t.Fatalf("close with polluted sealed key: code=%s due=%d err=%v want ERR_INTERNAL/0/nil", code, due, err)
			}

			events, _, err := s.ReadEventsAfter(ctx, aid, "")
			if err != nil {
				t.Fatal(err)
			}
			if len(events) != 1 || events[0].Type != model.TypeSealedBidReceived {
				t.Fatalf("close mutated stream: %+v", events)
			}
			snap, err := s.Snapshot(ctx, aid)
			if err != nil {
				t.Fatal(err)
			}
			if snap.Status != model.StateLive || snap.WinnerID != "" || snap.CurrentPriceCents != "10000" || snap.Seq != 1 {
				t.Fatalf("close mutated snapshot: %+v", snap)
			}
		})
	}
}
