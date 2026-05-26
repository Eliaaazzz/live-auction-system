package server

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
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
			// Project the terminal auction.status from the Stream event — the single
			// source for SOLD/NO_BID/CANCELLED (covers cap-hit SOLD via place_bid, the
			// Timer hammer, and cancel). DRAFT/SCHEDULED/LIVE are set by their handlers
			// (they emit no Stream event). On error, stop so the next sweep retries.
			if e.Type == model.TypeAuctionSold {
				if err := projectSold(ctx, st, aid, e); err != nil {
					if errors.Is(err, store.ErrPermanentOrderProjection) || errors.Is(err, store.ErrOrderProjectionMismatch) {
						log.Printf("ERROR persistence sold-order %s seq=%d: %v (poison event; advancing cursor)", aid, e.Seq, err)
						lastID[aid] = e.ID
						continue
					}
					log.Printf("persistence sold-order %s seq=%d: %v (will retry)", aid, e.Seq, err)
					break
				}
			} else if status := terminalStatus(e.Type); status != "" {
				if err := st.UpdateAuctionStatus(ctx, aid, status); err != nil {
					log.Printf("persistence status %s seq=%d -> %s: %v (will retry)", aid, e.Seq, status, err)
					break
				}
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

func projectSold(ctx context.Context, st *store.Store, aid string, e store.StreamEvent) error {
	a, err := st.GetAuction(ctx, aid)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("%w: missing auction row for SOLD event %s", store.ErrPermanentOrderProjection, aid)
		}
		return err
	}
	if a.Status != model.StateOrderCreated {
		if err := st.UpdateAuctionStatus(ctx, aid, model.StateSold); err != nil {
			return err
		}
	}
	if err := st.CreateOrderFromSold(ctx, aid, e.Payload); err != nil {
		return err
	}
	return st.UpdateAuctionStatus(ctx, aid, model.StateOrderCreated)
}

// terminalStatus maps a terminal Stream event type to the auctions.status it
// projects, or "" for non-terminal events.
func terminalStatus(eventType string) string {
	switch eventType {
	case model.TypeAuctionNoBid:
		return model.StateNoBid
	case model.TypeAuctionCancelled:
		return model.StateCancelled
	}
	return ""
}
