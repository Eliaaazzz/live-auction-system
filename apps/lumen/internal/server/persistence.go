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
			events, newLast, err := st.ReadEventsAfter(ctx, aid, lastID[aid])
			if err != nil {
				log.Printf("persistence read %s: %v", aid, err)
				continue
			}
			for _, e := range events {
				if err := st.InsertEvent(ctx, aid, e.Seq, e.Type, e.Payload); err != nil {
					log.Printf("persistence insert %s seq=%d: %v", aid, e.Seq, err)
				}
			}
			lastID[aid] = newLast
		}
	}
}
