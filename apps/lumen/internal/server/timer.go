package server

import (
	"context"
	"log"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

// timerScanInterval is the Timer Worker's scan cadence (V9 §4.2: scan 100ms,
// detection-lag budget feeds the hammer p95).
const timerScanInterval = 100 * time.Millisecond

// reconcileInterval is the slower self-heal cadence: it re-registers any LIVE
// auction missing from the active index (e.g. a TrackActive that failed right
// after start_auction committed LIVE), so a transient Redis blip can never
// orphan an auction from the hammer permanently.
const reconcileInterval = 5 * time.Second

// runTimerWorker is the single hammer authority: it does NOT depend on the next
// bid. Every 100ms tick it asks Redis for due auctions (endAtMs <= Redis now) and
// calls close_auction.lua, which re-checks Redis TIME (so an anti-snipe extension
// since the scan lands as ERR_NOT_DUE and just refreshes the index). MySQL status
// is projected from the Stream terminal event by the persistence worker, so the
// Timer only maintains the active index here. A slower reconcile tick rebuilds the
// index from the authoritative state Hashes (self-heals a lost TrackActive).
func runTimerWorker(ctx context.Context, st *store.Store, auctioneer *AuctioneerHooks) {
	scan := time.NewTicker(timerScanInterval)
	defer scan.Stop()
	reconcile := time.NewTicker(reconcileInterval)
	defer reconcile.Stop()
	reconcileActive(ctx, st, auctioneer) // initial pass: recover anything live-but-untracked at startup
	for {
		select {
		case <-ctx.Done():
			return
		case <-scan.C:
			hammerDue(ctx, st)
		case <-reconcile.C:
			reconcileActive(ctx, st, auctioneer)
		}
	}
}

// hammerDue closes every auction whose tracked endAtMs has passed.
func hammerDue(ctx context.Context, st *store.Store) {
	now, err := st.RedisNowMs(ctx)
	if err != nil {
		log.Printf("timer now: %v", err)
		return
	}
	due, err := st.DueAuctions(ctx, now)
	if err != nil {
		log.Printf("timer due: %v", err)
		return
	}
	for _, aid := range due {
		closeDue(ctx, st, aid)
	}
}

// closeDue closes one due auction and reconciles the active index by the result.
// Split out from hammerDue so the per-auction outcome handling — in particular the
// ERR_INTERNAL self-defense below — is unit-testable without the global due scan
// (which on shared Redis would also touch other tests' auctions).
func closeDue(ctx context.Context, st *store.Store, aid string) {
	code, endAtMs, err := st.CloseAuction(ctx, aid)
	if err != nil {
		log.Printf("timer close %s: %v", aid, err)
		return
	}
	switch code {
	case model.CodeOKSold, model.CodeOKNoBid, model.CodeErrAlreadyTerminal:
		// hammered (or already terminal, e.g. a cap-hit SOLD) → drop it.
		if err := st.UntrackActive(ctx, aid); err != nil {
			log.Printf("timer untrack %s: %v", aid, err)
		}
	case model.CodeErrNotDue:
		// anti-snipe moved endAtMs forward since the scan; refresh the score
		// so we re-poll at the new time instead of every tick.
		if endAtMs > 0 {
			if err := st.TrackActive(ctx, aid, endAtMs); err != nil {
				log.Printf("timer retrack %s endAtMs=%d: %v", aid, endAtMs, err)
			}
		}
	case model.CodeErrInternal:
		// data corruption (seq_stream_mismatch / key_type): re-hammering every 100ms
		// can't fix it and just floods logs with no operator signal. Untrack to break the
		// tight loop and emit one ERROR; the reconcile re-tracks it (still LIVE in the
		// authoritative state Hash), so it re-probes at the slow cadence (surfacing the
		// ERROR) instead of 10x/s — bounded log volume + a human-actionable signal. The
		// underlying corruption still needs an operator; this just stops the storm.
		// (TC-T3-104)
		log.Printf("ERROR timer close %s: ERR_INTERNAL (state/stream corruption); untracking to stop the 100ms retry loop, reconcile will re-probe in %s", aid, reconcileInterval)
		if err := st.UntrackActive(ctx, aid); err != nil {
			log.Printf("timer untrack %s after ERR_INTERNAL: %v", aid, err)
		}
	}
}

// reconcileActive walks the authoritative state Hashes and re-registers any LIVE
// auction in the active index. The active ZSET is a Go-maintained cache of "what to
// hammer and when"; this makes the state Hash (set atomically by Lua) the source of
// truth for membership, so a TrackActive that failed after OK_LIVE is recovered
// within one reconcile tick. TrackActive is idempotent (ZADD), so re-tracking an
// already-present auction is a no-op; close_auction's Redis-TIME re-check guards
// against hammering one whose endAtMs has not actually arrived.
func reconcileActive(ctx context.Context, st *store.Store, auctioneer *AuctioneerHooks) {
	aids, err := st.ScanStateAIDs(ctx)
	if err != nil {
		log.Printf("timer reconcile scan: %v", err)
		return
	}
	for _, aid := range aids {
		snap, err := st.Snapshot(ctx, aid)
		if err != nil {
			continue
		}
		if snap.Status == model.StateLive && snap.EndAtMs > 0 {
			if err := st.TrackActive(ctx, aid, snap.EndAtMs); err != nil {
				log.Printf("timer reconcile track %s: %v", aid, err)
			}
			// T7 §4.2: piggyback on the existing 5s reconcile sweep to
			// drive the `cold` trigger detector. The detector itself
			// debounces (30s) + suppresses for 5s after terminals — so
			// firing it every reconcile is safe and free (no Redis
			// read; uses last-seen-bid from the in-memory cache).
			if auctioneer != nil {
				auctioneer.OnTickStall(ctx, aid, snap.WinnerID, snap.CurrentPriceCents)
			}
		}
	}
}
