package server

// T3 hidden / edge test: the Timer reconcile backstop that fixes the CRITICAL
// lost-auction case (TrackActive failing after start_auction committed LIVE).
// Calls reconcileActive directly on a store with no running worker, so the
// assertion is deterministic.

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

func reconcileRules() model.Rules {
	return model.Rules{StartPriceCents: 10000, IncrementCents: 1000, CapPriceCents: 0, DurationSec: 3600}
}

// inActive reports whether aid is in the global Timer index (auction:active).
// A huge "now" makes ZRANGEBYSCORE -inf..now return every tracked auction.
func inActive(t *testing.T, st *store.Store, aid string) bool {
	t.Helper()
	due, err := st.DueAuctions(context.Background(), 1<<62)
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range due {
		if a == aid {
			return true
		}
	}
	return false
}

// Proves the CRITICAL self-heal: if the active-index ZADD was lost after
// start_auction committed LIVE, the reconcile re-registers the auction so it
// still gets hammered — and only for LIVE auctions, never SCHEDULED ones.
func TestT3TimerReconcileRetracksLostLiveAuction(t *testing.T) {
	st := fullStore(t)
	ctx := context.Background()

	live := fmt.Sprintf("test_reconcile_live_%d", time.Now().UnixNano())
	if code, err := st.FreezeRules(ctx, live, "seller_x", reconcileRules()); err != nil || code != model.CodeOKFrozen {
		t.Fatalf("freeze live: %s %v", code, err)
	}
	if code, _, err := st.StartAuction(ctx, live, 3600_000); err != nil || code != model.CodeOKLive {
		t.Fatalf("start live: %s %v", code, err)
	}
	// simulate the lost track (the CRITICAL scenario). ZREM is synchronous, so the
	// only way `live` is in the index after reconcile is the reconcile itself.
	if err := st.UntrackActive(ctx, live); err != nil {
		t.Fatal(err)
	}

	// a SCHEDULED auction (frozen, not started) must NOT be tracked by reconcile.
	sched := fmt.Sprintf("test_reconcile_sched_%d", time.Now().UnixNano())
	if code, err := st.FreezeRules(ctx, sched, "seller_x", reconcileRules()); err != nil || code != model.CodeOKFrozen {
		t.Fatalf("freeze sched: %s %v", code, err)
	}

	reconcileActive(ctx, st)

	if !inActive(t, st, live) {
		t.Fatal("reconcile must re-track a LIVE auction missing from the active index (CRITICAL self-heal)")
	}
	if inActive(t, st, sched) {
		t.Fatal("reconcile must NOT track a non-LIVE (SCHEDULED) auction")
	}

	// tidy: drop from the index + terminalize so they don't linger in shared redis.
	_ = st.UntrackActive(ctx, live)
	_ = st.UntrackActive(ctx, sched)
	_, _ = st.CancelAuction(ctx, live, "seller_x")
	_, _ = st.CancelAuction(ctx, sched, "seller_x")
}
