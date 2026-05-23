package server

import (
	"context"
	"log"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/config"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

// Seed inserts idempotent demo data for the two-tab human demo: a seller, a
// buyer, one product and one DRAFT auction (admin UI drives freeze + start).
func Seed(ctx context.Context, cfg config.Config) error {
	st, err := store.New(ctx, cfg.RedisAddr, cfg.MySQLDSN)
	if err != nil {
		return err
	}
	defer st.Close()

	if _, err := st.GetAuction(ctx, "auc_demo"); err == nil {
		log.Println("seed: auc_demo already present, nothing to do")
		return nil
	}

	if err := st.UpsertUser(ctx, "seller_demo", "Demo Seller", "seller"); err != nil {
		return err
	}
	if err := st.UpsertUser(ctx, "buyer_demo", "Demo Buyer", "user"); err != nil {
		return err
	}
	if err := st.CreateProduct(ctx, "prod_demo", "seller_demo", "Vintage Watch", "https://example.com/watch.jpg", "Demo item for T1"); err != nil {
		return err
	}
	rules := model.Rules{
		StartPriceCents: 10000, IncrementCents: 1000, CapPriceCents: 1000000,
		DurationSec: 3600, ExtendWindowSec: 10, ExtendSec: 10,
	}
	if err := st.CreateAuction(ctx, "auc_demo", "prod_demo", "seller_demo", rules); err != nil {
		return err
	}

	// Drive auc_demo to LIVE directly via the store (no dev-login needed) so the
	// documented two-tab demo link /room.html?auction=auc_demo is bid-able
	// immediately. Long duration (1h) keeps it live for the demo session.
	if code, err := st.FreezeRules(ctx, "auc_demo", rules); err != nil {
		return err
	} else if code != model.CodeOKFrozen {
		log.Printf("seed: freeze auc_demo returned %s", code)
	}
	_ = st.UpdateAuctionStatus(ctx, "auc_demo", model.StateScheduled)
	if code, _, err := st.StartAuction(ctx, "auc_demo", 3600_000); err != nil {
		return err
	} else if code != model.CodeOKLive {
		log.Printf("seed: start auc_demo returned %s", code)
	}
	_ = st.UpdateAuctionStatus(ctx, "auc_demo", model.StateLive)

	log.Println("seed: created seller_demo, buyer_demo, prod_demo, auc_demo (LIVE)")
	return nil
}
