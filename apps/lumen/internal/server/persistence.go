package server

import (
	"context"
	"log"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

// persistenceSweepInterval is the backstop cadence for the Stream-first sweep.
const persistenceSweepInterval = 2 * time.Second

// runPersistenceWorker projects Stream events into MySQL. The Redis Stream is the
// canonical log; Pub/Sub is only a fast wakeup. Projection is **Stream-first**:
//   - an initial sweep drains every existing stream on startup (so a worker that
//     starts after a publish, or restarts, still catches up);
//   - a periodic sweep re-reads every stream from its cursor (so a dropped/lost
//     Pub/Sub hint can never permanently lose an event);
//   - a Pub/Sub hint just triggers an immediate projection of that auction.
//
// Projection is idempotent (INSERT IGNORE on UNIQUE(auction_id, seq)); a
// different payload for an existing seq surfaces ErrEventPayloadMismatch.
func runPersistenceWorker(ctx context.Context, st *store.Store) {
	ps := st.Redis().PSubscribe(ctx, store.PubPattern)
	defer func() { _ = ps.Close() }()
	ch := ps.Channel() // create once; go-redis starts a delivery goroutine here

	lastID := make(map[string]string)
	project := func(aid string) {
		events, _, err := st.ReadEventsAfter(ctx, aid, lastID[aid])
		if err != nil {
			log.Printf("persistence read %s: %v", aid, err)
			return
		}
		// Advance the cursor only past events that were actually projected; on a
		// transient/mismatch error stop so the next sweep re-reads from the failed
		// event (INSERT IGNORE makes re-processing safe).
		for _, e := range events {
			if err := st.InsertEvent(ctx, aid, e.Seq, e.Type, e.Payload); err != nil {
				log.Printf("persistence insert %s seq=%d: %v (will retry on next sweep)", aid, e.Seq, err)
				break
			}
			lastID[aid] = e.ID
		}
	}
	sweep := func() {
		aids, err := st.ScanEventStreamAIDs(ctx)
		if err != nil {
			log.Printf("persistence sweep scan: %v", err)
			return
		}
		for _, aid := range aids {
			project(aid)
		}
	}

	sweep() // initial drain of streams that already exist
	ticker := time.NewTicker(persistenceSweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sweep() // backstop: independent of Pub/Sub delivery
		case msg, ok := <-ch:
			if !ok {
				return
			}
			if aid := store.AIDFromPubChannel(msg.Channel); aid != "" {
				project(aid) // fast path: a hint just projects sooner than the next tick
			}
		}
	}
}
