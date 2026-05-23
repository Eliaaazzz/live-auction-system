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
	st, err := store.New(ctx, cfg.RedisAddr, cfg.MySQLDSN)
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
