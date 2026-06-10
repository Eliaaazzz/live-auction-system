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

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/metrics"
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
	m := metrics.New()
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

	before := m.TimerErrInternal.Load()
	closeDue(ctx, st, aid, m)

	if got := m.TimerErrInternal.Load() - before; got != 1 {
		t.Fatalf("timer err internal counter delta=%d want=1", got)
	}
	if got := m.TimerErrInternalSeqMismatch.Load() - before; got != 1 {
		t.Fatalf("timer err internal seq mismatch counter delta=%d want=1", got)
	}
	if got := m.TimerErrInternalKeyType.Load(); got != 0 {
		t.Fatalf("timer err internal key type counter should stay 0, got=%d", got)
	}

	if inActive(t, st, aid) {
		t.Fatal("closeDue must untrack on ERR_INTERNAL to stop the 100ms retry loop (TC-T3-104)")
	}
	// the auction is untouched otherwise — still LIVE (no terminal write on ERR_INTERNAL).
	if snap, _ := st.Snapshot(ctx, aid); snap.Status != model.StateLive {
		t.Fatalf("status=%s want LIVE (ERR_INTERNAL must not write a terminal)", snap.Status)
	}
}

func TestT3CloseDueErrInternalKeyTypeCounter(t *testing.T) {
	st := fullStore(t)
	ctx := context.Background()
	aid := fmt.Sprintf("test_errinternal_keytype_%d", time.Now().UnixNano())
	m := metrics.New()
	stateK := fmt.Sprintf("auction:{%s}:state", aid)
	streamK := fmt.Sprintf("auction:{%s}:events", aid)
	lbK := fmt.Sprintf("auction:{%s}:leaderboard", aid)
	t.Cleanup(func() {
		c := context.Background()
		st.Redis().Del(c, stateK, streamK, lbK, fmt.Sprintf("auction:{%s}:dedupe:u", aid))
		_ = st.UntrackActive(c, aid)
	})

	if code, err := st.FreezeRules(ctx, aid, "seller_x", reconcileRules()); err != nil || code != model.CodeOKFrozen {
		t.Fatalf("freeze: %s %v", code, err)
	}
	if code, _, err := st.StartAuction(ctx, aid, 3600_000); err != nil || code != model.CodeOKLive {
		t.Fatalf("start: %s %v", code, err)
	}
	if !inActive(t, st, aid) {
		t.Fatal("precondition: StartAuction should have tracked the auction")
	}
	// Corrupt the leaderboard type to force close_auction.lua key_type branch:
	// state is still a hash, stream is still a stream, but lb_key should be zset.
	if err := st.Redis().Del(ctx, lbK).Err(); err != nil {
		t.Fatal(err)
	}
	if err := st.Redis().Set(ctx, lbK, "bad-leaderboard", 0).Err(); err != nil {
		t.Fatal(err)
	}
	if err := st.Redis().HSet(ctx, stateK, "endAtMs", 1).Err(); err != nil {
		t.Fatal(err)
	}

	before := m.TimerErrInternal.Load()
	beforeSeq := m.TimerErrInternalSeqMismatch.Load()
	beforeKeyType := m.TimerErrInternalKeyType.Load()
	closeDue(ctx, st, aid, m)

	if got := m.TimerErrInternal.Load() - before; got != 1 {
		t.Fatalf("timer err internal counter delta=%d want=1", got)
	}
	if got := m.TimerErrInternalKeyType.Load() - beforeKeyType; got != 1 {
		t.Fatalf("timer err internal key type counter delta=%d want=1", got)
	}
	if got := m.TimerErrInternalSeqMismatch.Load() - beforeSeq; got != 0 {
		t.Fatalf("timer err internal seq mismatch counter delta=%d want=0", got)
	}

	if inActive(t, st, aid) {
		t.Fatal("closeDue must untrack on ERR_INTERNAL to stop the 100ms retry loop (TC-T3-104)")
	}
}

func TestT3CloseDueErrInternalReconcileSuppressed(t *testing.T) {
	st := fullStore(t)
	ctx := context.Background()
	aid := fmt.Sprintf("test_errinternal_suppressed_%d", time.Now().UnixNano())
	m := metrics.New()
	stateK := fmt.Sprintf("auction:{%s}:state", aid)
	t.Cleanup(func() {
		c := context.Background()
		st.Redis().Del(c, stateK, fmt.Sprintf("auction:{%s}:events", aid))
		_ = st.UntrackActive(c, aid)
		timerErrInternalSuppressMu.Lock()
		delete(timerErrInternalSuppressUntil, aid)
		timerErrInternalSuppressMu.Unlock()
	})

	if code, err := st.FreezeRules(ctx, aid, "seller_x", reconcileRules()); err != nil || code != model.CodeOKFrozen {
		t.Fatalf("freeze: %s %v", code, err)
	}
	if code, _, err := st.StartAuction(ctx, aid, 3600_000); err != nil || code != model.CodeOKLive {
		t.Fatalf("start: %s %v", code, err)
	}
	if !inActive(t, st, aid) {
		t.Fatal("precondition: StartAuction should have tracked the auction")
	}
	if err := st.Redis().HSet(ctx, stateK, "seq", 5, "endAtMs", 1).Err(); err != nil {
		t.Fatal(err)
	}

	closeDue(ctx, st, aid, m)
	if inActive(t, st, aid) {
		t.Fatal("closeDue must untrack on ERR_INTERNAL")
	}

	if suppressionUntil, err := st.Redis().HGet(ctx, stateK, timerErrInternalSuppressedUntilField).Result(); err != nil || suppressionUntil == "" {
		t.Fatalf("expected persistent err-internal suppression marker on state hash: v=%q err=%v", suppressionUntil, err)
	}

	timerErrInternalSuppressMu.Lock()
	delete(timerErrInternalSuppressUntil, aid)
	timerErrInternalSuppressMu.Unlock()
	reconcileActive(ctx, st, nil)
	if inActive(t, st, aid) {
		t.Fatal("reconcileActive must skip auctions recently suppressed after ERR_INTERNAL")
	}
}

func TestT3CloseDueErrInternalReconcileResumesAfterSuppressionCleared(t *testing.T) {
	st := fullStore(t)
	ctx := context.Background()
	aid := fmt.Sprintf("test_errinternal_recover_%d", time.Now().UnixNano())
	m := metrics.New()
	stateK := fmt.Sprintf("auction:{%s}:state", aid)
	t.Cleanup(func() {
		c := context.Background()
		st.Redis().Del(c, stateK, fmt.Sprintf("auction:{%s}:events", aid), fmt.Sprintf("auction:{%s}:leaderboard", aid), fmt.Sprintf("auction:{%s}:dedupe:u", aid))
		_ = st.UntrackActive(c, aid)
		timerErrInternalSuppressMu.Lock()
		delete(timerErrInternalSuppressUntil, aid)
		timerErrInternalSuppressMu.Unlock()
	})

	if code, err := st.FreezeRules(ctx, aid, "seller_x", reconcileRules()); err != nil || code != model.CodeOKFrozen {
		t.Fatalf("freeze: %s %v", code, err)
	}
	if code, _, err := st.StartAuction(ctx, aid, 3600_000); err != nil || code != model.CodeOKLive {
		t.Fatalf("start: %s %v", code, err)
	}
	if !inActive(t, st, aid) {
		t.Fatal("precondition: StartAuction should have tracked the auction")
	}
	if err := st.Redis().HSet(ctx, stateK, "seq", 5, "endAtMs", 1).Err(); err != nil {
		t.Fatal(err)
	}

	closeDue(ctx, st, aid, m)
	if inActive(t, st, aid) {
		t.Fatal("closeDue must untrack on first ERR_INTERNAL")
	}
	if got := m.TimerErrInternal.Load(); got != 1 {
		t.Fatalf("first closeDue should increment timer err internal count to 1, got=%d", got)
	}

	// The suppression marker and in-memory cache should block immediate re-track.
	if suppressionUntil, err := st.Redis().HGet(ctx, stateK, timerErrInternalSuppressedUntilField).Result(); err != nil || suppressionUntil == "" {
		t.Fatalf("expected suppression marker after first ERR_INTERNAL: v=%q err=%v", suppressionUntil, err)
	}
	reconcileActive(ctx, st, nil)
	if inActive(t, st, aid) {
		t.Fatal("reconcileActive must skip while suppress marker exists")
	}

	// Clear suppression and allow one reconcile cycle; the room should be re-tracked.
	if err := st.Redis().HDel(ctx, stateK, timerErrInternalSuppressedUntilField).Err(); err != nil {
		t.Fatal(err)
	}
	timerErrInternalSuppressMu.Lock()
	delete(timerErrInternalSuppressUntil, aid)
	timerErrInternalSuppressMu.Unlock()
	reconcileActive(ctx, st, nil)
	if !inActive(t, st, aid) {
		t.Fatal("reconcileActive should track again after suppression marker is cleared")
	}

	before := m.TimerErrInternal.Load()
	closeDue(ctx, st, aid, m)
	if got := m.TimerErrInternal.Load() - before; got != 1 {
		t.Fatalf("second closeDue after suppression should also increment timer err internal count by 1, got=%d", got)
	}
	if inActive(t, st, aid) {
		t.Fatal("re-probed ERR_INTERNAL auction should be untracked again")
	}
	if snap, _ := st.Snapshot(ctx, aid); snap.Status != model.StateLive {
		t.Fatalf("status=%s want LIVE (ERR_INTERNAL should not terminalize)", snap.Status)
	}
}
