package server

// TC-T4-112 (P0) by @fariZzzz — projection-time seq-gap must not produce a verifying
// chain. Found in the #34 second-pass review (Eliaaazzz #35 CR): fillEventHash linked
// to the highest seq BELOW the current row (not exactly seq-1) and VerifyEvidenceChain
// didn't assert contiguity, so InsertEvent(1) then InsertEvent(3) chained 1->3 and
// VERIFIED despite a dropped seq 2 — a false green for a missing event, defeating the
// tamper-evidence point. Paired with the two-layer fix in storedb.go (fillEventHash
// contiguity guard + VerifyEvidenceChain expected-seq assertion).

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

func TestT4SeqSkipDoesNotChainOrVerify(t *testing.T) {
	st := fullStore(t)
	ctx := context.Background()
	aid := fmt.Sprintf("test_t4_seqgap_%d", time.Now().UnixNano())
	t.Cleanup(func() {
		_, _ = st.DB().ExecContext(context.Background(), "DELETE FROM auction_events WHERE auction_id=?", aid)
	})

	// seq 1 chains as genesis.
	if err := st.InsertEvent(ctx, aid, 1, model.TypeBidAccepted, `{"seq":1,"userId":"u1","amountCents":"11000"}`); err != nil {
		t.Fatalf("seq1: %v", err)
	}

	// seq 3 with seq 2 missing must NOT chain across the gap.
	err := st.InsertEvent(ctx, aid, 3, model.TypeBidAccepted, `{"seq":3,"userId":"u2","amountCents":"13000"}`)
	if !errors.Is(err, store.ErrPreviousEventHashMissing) {
		t.Fatalf("InsertEvent(seq=3) with seq=2 missing: got %v, want ErrPreviousEventHashMissing (no chaining across a gap)", err)
	}

	// Defense-in-depth: the seq-3 row exists but is unchained + non-contiguous, so
	// VerifyEvidenceChain must break at 3 rather than report a clean 1->3 chain.
	if ok, brk, vErr := st.VerifyEvidenceChain(ctx, aid); vErr != nil || ok || brk != 3 {
		t.Fatalf("verify gapped chain: ok=%v break=%d err=%v, want not-ok / break=3", ok, brk, vErr)
	}

	// Fill the gap: seq 2 chains to 1, then seq 3 re-projects and chains to 2 →
	// contiguous, and the whole chain verifies.
	if err := st.InsertEvent(ctx, aid, 2, model.TypeBidAccepted, `{"seq":2,"userId":"u1","amountCents":"12000"}`); err != nil {
		t.Fatalf("seq2: %v", err)
	}
	if err := st.InsertEvent(ctx, aid, 3, model.TypeBidAccepted, `{"seq":3,"userId":"u2","amountCents":"13000"}`); err != nil {
		t.Fatalf("seq3 re-project after gap filled: %v", err)
	}
	if ok, brk, vErr := st.VerifyEvidenceChain(ctx, aid); vErr != nil || !ok || brk != 0 {
		t.Fatalf("verify after gap filled: ok=%v break=%d err=%v, want ok/0", ok, brk, vErr)
	}
	if n, _ := st.CountEvents(ctx, aid); n != 3 {
		t.Fatalf("count=%d want 3 (seq 1,2,3 contiguous)", n)
	}
}
