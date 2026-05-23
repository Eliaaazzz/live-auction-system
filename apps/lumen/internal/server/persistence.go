package server

import (
	"context"
	"log"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

// runPersistenceWorker projects Stream events into MySQL. The Stream is
// canonical; the Pub/Sub hint only wakes the worker. Projection is idempotent
// (INSERT IGNORE on UNIQUE(auction_id, seq)). Hash chain + bids/orders
// projection arrive in T4.
func runPersistenceWorker(ctx context.Context, st *store.Store) {
	ps := st.Redis().PSubscribe(ctx, store.PubPattern)
	defer func() { _ = ps.Close() }()

	lastID := make(map[string]string)
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-ps.Channel():
			if !ok {
				return
			}
			aid := store.AIDFromPubChannel(msg.Channel)
			if aid == "" {
				continue
			}
			events, _, err := st.ReadEventsAfter(ctx, aid, lastID[aid])
			if err != nil {
				log.Printf("persistence read %s: %v", aid, err)
				continue
			}
			// Advance the cursor only past events that were actually projected.
			// On a transient insert error, stop so the next Pub/Sub hint re-reads
			// from the failed event (INSERT IGNORE makes re-processing safe).
			for _, e := range events {
				if err := st.InsertEvent(ctx, aid, e.Seq, e.Type, e.Payload); err != nil {
					log.Printf("persistence insert %s seq=%d: %v (will retry on next hint)", aid, e.Seq, err)
					break
				}
				lastID[aid] = e.ID
			}
		}
	}
}
