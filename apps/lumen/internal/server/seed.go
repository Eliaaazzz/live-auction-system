package server

import (
	"context"
	"log"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/config"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

const demoAuctionID = "auc_demo"

// Seed inserts idempotent demo data for the two-tab human demo: a seller, a
// buyer, one product, and one auction that is driven all the way to LIVE (via
// freeze + start through the store) so /room.html?auction=auc_demo is bid-able
// immediately without any admin steps.
//
// If force is true, existing demo state is rebuilt even when auc_demo already
// exists. This keeps `lumen seed` safe for repeated local smoke flows after an
// auction has moved to terminal state (e.g. NO_BID/SOLD), while preserving the
// default idempotent behavior when force is false.
func Seed(ctx context.Context, cfg config.Config, force bool) error {
	st, err := store.New(ctx, cfg.RedisAddr, cfg.MySQLDSN, cfg.RedisPassword, cfg.EvidenceHMACKey, cfg.RedisUseTLS)
	if err != nil {
		return err
	}
	defer st.Close()

	_, err = st.GetAuction(ctx, demoAuctionID)
	exists := true
	switch {
	case err == nil && !force:
		log.Println("seed: auc_demo already present, nothing to do")
		return nil
	case err == nil && force:
		log.Println("seed: forcing auc_demo refresh for deterministic smoke")
		if err := st.ResetAuctionRedisState(ctx, demoAuctionID); err != nil {
			return err
		}
		if err := st.UpdateAuctionStatus(ctx, demoAuctionID, model.StateDraft); err != nil {
			return err
		}
	case err == store.ErrNotFound:
		exists = false
	case err != nil && err != store.ErrNotFound:
		return err
	}

	rules := model.Rules{
		StartPriceCents: 10000, IncrementCents: 1000, CapPriceCents: 1000000,
		DurationSec: 3600, ExtendWindowSec: 10, ExtendSec: 10, MaxExtensions: 5,
	}
	facts := `{"facts":[{"field":"category","value":"watch","highRisk":false}],"highRiskFieldsDisclaimer":"高风险字段为卖家声明，AI 未验证。"}`

	if err := st.UpsertUser(ctx, "seller_demo", "Demo Seller", "seller"); err != nil {
		return err
	}
	if err := st.UpsertUser(ctx, "buyer_demo", "Demo Buyer", "user"); err != nil {
		return err
	}
	if !exists {
		if err := st.CreateProduct(ctx, "prod_demo", "seller_demo", "Vintage Watch", "https://example.com/watch.jpg", "Demo item for T1"); err != nil {
			return err
		}
		if err := st.CreateAuction(ctx, demoAuctionID, "prod_demo", "seller_demo", rules, true, facts); err != nil {
			return err
		}
	}

	// Drive auc_demo to LIVE directly via the store (no dev-login needed) so the
	// documented two-tab demo link /room.html?auction=auc_demo is bid-able
	// immediately. Long duration (1h) keeps it live for the demo session.
	if code, err := st.FreezeRules(ctx, demoAuctionID, "seller_demo", rules); err != nil {
		return err
	} else if code != model.CodeOKFrozen {
		log.Printf("seed: freeze auc_demo returned %s", code)
	}
	_ = st.UpdateAuctionStatus(ctx, demoAuctionID, model.StateScheduled)
	if code, _, err := st.StartAuction(ctx, demoAuctionID, 3600_000); err != nil {
		return err
	} else if code != model.CodeOKLive {
		log.Printf("seed: start auc_demo returned %s", code)
	}
	_ = st.UpdateAuctionStatus(ctx, demoAuctionID, model.StateLive)

	log.Println("seed: created seller_demo, buyer_demo, prod_demo, auc_demo (LIVE)")
	return nil
}
