package server

// T3 gap-probe tests ported from @fariZzzz's #30 doc into executable CI gates
// (issue #32), paired with the small fixes they validate:
//   - TC-T3-100: the DRAFT-cancel TOCTOU guard (UpdateAuctionStatusIf CAS).
//   - TC-T3-104: the Timer's ERR_INTERNAL self-defense (untrack to stop the loop).

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

// TC-T3-100 — DRAFT cancel + concurrent freeze TOCTOU. handleCancel reads DRAFT, then
// a concurrent freeze can move the row to SCHEDULED before the cancel writes. The fix
// makes the DRAFT-path write a status-conditional CAS (UpdateAuctionStatusIf ... WHERE
// status='DRAFT'); this pins that it (a) applies on a genuine DRAFT and (b) no-ops
// without clobbering when the row already advanced to SCHEDULED. The full HTTP race is
// nondeterministic (freeze usually wins), so this asserts the CAS primitive the
// handler now relies on — the deterministic core of the fix.
func TestT3CancelDraftConditionalUpdateGuardsTOCTOU(t *testing.T) {
	target, srv := startTestServer(t)
	ctx := context.Background()
	hc := &http.Client{Timeout: 5 * time.Second}

	seller, err := devLogin(hc, target, "T3 TC100 Seller", "seller")
	if err != nil {
		t.Fatal(err)
	}
	productID, err := createProduct(hc, target, seller.Token)
	if err != nil {
		t.Fatal(err)
	}

	// (a) genuine DRAFT → the conditional cancel applies.
	draft, err := createAuction(hc, target, seller.Token, productID) // DRAFT row
	if err != nil {
		t.Fatal(err)
	}
	applied, err := srv.st.UpdateAuctionStatusIf(ctx, draft, model.StateCancelled, model.StateDraft)
	if err != nil || !applied {
		t.Fatalf("CAS cancel on DRAFT: applied=%v err=%v want true", applied, err)
	}
	if a, _ := srv.st.GetAuction(ctx, draft); a.Status != model.StateCancelled {
		t.Fatalf("status=%s want CANCELLED", a.Status)
	}

	// (b) TOCTOU: a concurrent freeze moved the row to SCHEDULED after the handler read
	// DRAFT. The conditional cancel must no-op, NOT clobber SCHEDULED with CANCELLED.
	raced, err := createAuction(hc, target, seller.Token, productID) // DRAFT row
	if err != nil {
		t.Fatal(err)
	}
	if err := srv.st.UpdateAuctionStatus(ctx, raced, model.StateScheduled); err != nil { // freeze won
		t.Fatal(err)
	}
	applied, err = srv.st.UpdateAuctionStatusIf(ctx, raced, model.StateCancelled, model.StateDraft)
	if err != nil {
		t.Fatal(err)
	}
	if applied {
		t.Fatal("CAS cancel applied to a SCHEDULED row — TOCTOU clobber not prevented")
	}
	if a, _ := srv.st.GetAuction(ctx, raced); a.Status != model.StateScheduled {
		t.Fatalf("status=%s want SCHEDULED (must be untouched by the no-op cancel)", a.Status)
	}
}

func TestT3CancelDraftPathHonorsRedisFrozenWindow(t *testing.T) {
	target, srv := startTestServer(t)
	ctx := context.Background()
	hc := &http.Client{Timeout: 5 * time.Second}

	seller, err := devLogin(hc, target, "T3 TC100 Redis Window Seller", "seller")
	if err != nil {
		t.Fatal(err)
	}
	productID, err := createProduct(hc, target, seller.Token)
	if err != nil {
		t.Fatal(err)
	}
	aid, err := createAuction(hc, target, seller.Token, productID) // MySQL DRAFT
	if err != nil {
		t.Fatal(err)
	}
	rules, err := srv.st.GetRules(ctx, aid)
	if err != nil {
		t.Fatal(err)
	}
	// Simulate the exact freeze window: Redis is already SCHEDULED, but the REST
	// handler has not yet projected auctions.status from DRAFT to SCHEDULED.
	if code, err := srv.st.FreezeRules(ctx, aid, seller.UserID, rules); err != nil || code != model.CodeOKFrozen {
		t.Fatalf("redis-only freeze: code=%s err=%v", code, err)
	}
	if a, err := srv.st.GetAuction(ctx, aid); err != nil || a.Status != model.StateDraft {
		t.Fatalf("precondition: MySQL status=%q err=%v, want DRAFT", a.Status, err)
	}

	if err := postExpectCode(hc, target+"/api/auctions/"+aid+"/cancel", seller.Token, nil, model.CodeOKCancelled); err != nil {
		t.Fatal(err)
	}
	if snap, err := srv.st.Snapshot(ctx, aid); err != nil || snap.Status != model.StateCancelled {
		t.Fatalf("Redis status=%q err=%v, want CANCELLED via cancel_auction.lua", snap.Status, err)
	}
	if a, err := srv.st.GetAuction(ctx, aid); err != nil || a.Status != model.StateCancelled {
		t.Fatalf("MySQL status=%q err=%v, want CANCELLED", a.Status, err)
	}
}

// TC-T3-104 — close_auction ERR_INTERNAL must not spin the Timer forever. With a
// corrupted state/stream seq alignment, close_auction returns ERR_INTERNAL; the Timer
// previously fell through with no untrack, re-hammering every 100ms. closeDue now
// untracks on ERR_INTERNAL (the reconcile re-probes slowly), so the tight loop stops.
// This drives closeDue directly (not the global due scan) so it's isolated on shared
// Redis and deterministic.
func TestT3CloseDueErrInternalUntracks(t *testing.T) {
	st := fullStore(t)
	ctx := context.Background()
	aid := fmt.Sprintf("test_errinternal_%d", time.Now().UnixNano())
	stateK := fmt.Sprintf("auction:{%s}:state", aid)
	t.Cleanup(func() {
		c := context.Background()
		st.Redis().Del(c, stateK, fmt.Sprintf("auction:{%s}:events", aid))
		_ = st.UntrackActive(c, aid)
	})

	if code, err := st.FreezeRules(ctx, aid, "seller_x", reconcileRules()); err != nil || code != model.CodeOKFrozen {
		t.Fatalf("freeze: %s %v", code, err)
	}
	if code, _, err := st.StartAuction(ctx, aid, 3600_000); err != nil || code != model.CodeOKLive {
		t.Fatalf("start: %s %v", code, err) // also tracks it in the active index
	}
	if !inActive(t, st, aid) {
		t.Fatal("precondition: StartAuction should have tracked the auction")
	}
	// Corrupt the state→stream seq alignment (seq=5, but the stream is empty → last
	// stream seq 0) AND make it due (endAtMs=1) so close_auction passes the due check
	// and hits the seq preflight → ERR_INTERNAL(seq_stream_mismatch).
	if err := st.Redis().HSet(ctx, stateK, "seq", 5, "endAtMs", 1).Err(); err != nil {
		t.Fatal(err)
	}

	closeDue(ctx, st, aid)

	if inActive(t, st, aid) {
		t.Fatal("closeDue must untrack on ERR_INTERNAL to stop the 100ms retry loop (TC-T3-104)")
	}
	// the auction is untouched otherwise — still LIVE (no terminal write on ERR_INTERNAL).
	if snap, _ := st.Snapshot(ctx, aid); snap.Status != model.StateLive {
		t.Fatalf("status=%s want LIVE (ERR_INTERNAL must not write a terminal)", snap.Status)
	}
}
