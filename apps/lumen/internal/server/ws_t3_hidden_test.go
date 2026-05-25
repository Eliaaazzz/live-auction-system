package server

// T3 hidden / edge test: the Timer reconcile backstop that fixes the CRITICAL
// lost-auction case (TrackActive failing after start_auction committed LIVE).
// Calls reconcileActive directly on a store with no running worker, so the
// assertion is deterministic.

import (
	"context"
	"fmt"
	"net/http"
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

// TC-T3-101 (fariZzzz #30 gap probe) — REST cancel eventual consistency.
//
// handleCancel returns 200 OK_CANCELLED and only LOGS a failed synchronous
// auctions.status write, because cancel_auction.lua has already committed the
// AUCTION_CANCELLED event to the Stream (the canonical log) and the persistence
// worker projects the terminal status to MySQL from there. This test pins that
// self-heal so the 200-on-projection-write-failure behavior is verified, not
// assumed: it cancels via the STORE (Lua only — no synchronous MySQL write at
// all, the worst case of the handler's write being skipped/failed) and asserts
// MySQL still converges to CANCELLED through the running persistence worker.
//
// GetAuction reads MySQL (not Redis), so a regression where the projection stops
// self-healing fails here even though Redis would still report CANCELLED.
func TestT3CancelEventualConsistencyFromStream(t *testing.T) {
	target, srv := startTestServer(t) // harness runs the persistence worker
	ctx := context.Background()
	hc := &http.Client{Timeout: 5 * time.Second}

	seller, err := devLogin(hc, target, "T3 TC101 Seller", "seller")
	if err != nil {
		t.Fatal(err)
	}
	productID, err := createProduct(hc, target, seller.Token)
	if err != nil {
		t.Fatal(err)
	}
	aid, err := createAuction(hc, target, seller.Token, productID)
	if err != nil {
		t.Fatal(err)
	}
	if err := postExpectCode(hc, target+"/api/auctions/"+aid+"/freeze", seller.Token, nil, model.CodeOKFrozen); err != nil {
		t.Fatal(err)
	}
	if err := postExpectCode(hc, target+"/api/auctions/"+aid+"/start", seller.Token, map[string]int64{"durationMs": 60000}, model.CodeOKLive); err != nil {
		t.Fatal(err)
	}
	// precondition: the start handler projected MySQL to LIVE.
	if a, err := srv.st.GetAuction(ctx, aid); err != nil || a.Status != model.StateLive {
		t.Fatalf("precondition: MySQL status=%q err=%v, want LIVE", a.Status, err)
	}

	// Cancel via the store, NOT the REST handler: cancel_auction.lua commits Redis
	// CANCELLED + AUCTION_CANCELLED on the Stream + Pub/Sub, but performs no MySQL
	// write — simulating the handler's status projection being skipped/failed.
	code, err := srv.st.CancelAuction(ctx, aid, seller.UserID)
	if err != nil || code != model.CodeOKCancelled {
		t.Fatalf("store cancel: code=%s err=%v, want OK_CANCELLED", code, err)
	}

	// The persistence worker (Stream-first) must project the terminal status to MySQL
	// on its own. Without the fix's premise this never converges.
	deadline := time.Now().Add(8 * time.Second)
	var last string
	for time.Now().Before(deadline) {
		a, err := srv.st.GetAuction(ctx, aid)
		if err == nil {
			if a.Status == model.StateCancelled {
				return // eventual consistency proven from the Stream alone
			}
			last = a.Status
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("MySQL status=%q did not converge to CANCELLED via Stream projection within 8s "+
		"(TC-T3-101: persistence worker must self-heal a missing synchronous status write)", last)
}
