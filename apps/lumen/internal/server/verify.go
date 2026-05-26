package server

import (
	"context"
	"fmt"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/config"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

// RunVerify is the T1 Replay Verifier *skeleton*: it checks that the Redis
// Stream length equals the MySQL projection count for an auction. The full
// three-way diff (Stream == Redis snapshot == MySQL, with hash-break detection)
// is T6. Returns an error (exit != 0) on mismatch so CI can gate on it.
func RunVerify(ctx context.Context, cfg config.Config, aid string) error {
	if aid == "" {
		aid = "auc_demo"
	}
	st, err := store.New(ctx, cfg.RedisAddr, cfg.MySQLDSN, cfg.EvidenceHMACKey)
	if err != nil {
		return err
	}
	defer st.Close()

	events, _, err := st.ReadEventsAfter(ctx, aid, "")
	if err != nil {
		return fmt.Errorf("read stream: %w", err)
	}
	dbCount, err := st.CountEvents(ctx, aid)
	if err != nil {
		return fmt.Errorf("count mysql events: %w", err)
	}

	if len(events) != dbCount {
		return fmt.Errorf("mismatch: stream=%d mysql=%d (auction=%s)", len(events), dbCount, aid)
	}
	fmt.Printf("consistent: stream=%d mysql=%d (auction=%s)\n", len(events), dbCount, aid)
	return nil
}

// RunVerifyEvidence recomputes the auction_events hash chain for an auction and fails
// (exit != 0) if it is broken — the T4 `make verify-evidence` gate. It re-derives each
// event_hash over the stored payload + prev link with the configured HMAC key, so a
// post-hoc edit of any payload/hash row surfaces as hash_break_at_seq.
func RunVerifyEvidence(ctx context.Context, cfg config.Config, aid string) error {
	if aid == "" {
		aid = "auc_demo"
	}
	st, err := store.New(ctx, cfg.RedisAddr, cfg.MySQLDSN, cfg.EvidenceHMACKey)
	if err != nil {
		return err
	}
	defer st.Close()

	ok, breakAtSeq, err := st.VerifyEvidenceChain(ctx, aid)
	if err != nil {
		return fmt.Errorf("verify evidence chain: %w", err)
	}
	n, _ := st.CountEvents(ctx, aid)
	if !ok {
		return fmt.Errorf("evidence chain BROKEN: hash_break_at_seq=%d (auction=%s, events=%d)", breakAtSeq, aid, n)
	}
	fmt.Printf("evidence chain consistent: events=%d (auction=%s)\n", n, aid)
	return nil
}
