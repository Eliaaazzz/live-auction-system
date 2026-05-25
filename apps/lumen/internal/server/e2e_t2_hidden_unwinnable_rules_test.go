package server

import (
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

// Hidden API test for the same invariant as the model unit test: invalid rule
// DSL must be rejected before it is persisted/frozen. Otherwise the seller can
// create a no-cap auction whose first required bid is MaxMoneyCents+1, while all
// clients are limited to MaxMoneyCents.
func TestT2HiddenCreateAuctionRejectsNoCapFirstBidAboveMaxMoney(t *testing.T) {
	target := os.Getenv("TARGET")
	if target == "" {
		target, _ = startTestServer(t)
	}
	hc := &http.Client{Timeout: 5 * time.Second}
	seller, err := devLogin(hc, target, "Hidden Unwinnable Seller", "seller")
	if err != nil {
		t.Fatalf("dev login: %v", err)
	}
	productID, err := createProduct(hc, target, seller.Token)
	if err != nil {
		t.Fatalf("create product: %v", err)
	}

	body := map[string]any{
		"productId": productID,
		"rules": model.Rules{
			StartPriceCents: model.MaxMoneyCents,
			IncrementCents:  1,
			CapPriceCents:   0,
			DurationSec:     60,
		},
		"factsConfirmed": true,
	}
	resp, data, err := postJSONRaw(hc, target+"/api/auctions", seller.Token, body)
	if err != nil {
		t.Fatalf("create auction: %v", err)
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("create auction status=%d body=%s want 400", resp.StatusCode, string(data))
	}
}
