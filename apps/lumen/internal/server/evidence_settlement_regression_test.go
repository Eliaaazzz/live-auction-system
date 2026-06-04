package server

import (
	"net/http"
	"testing"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

func TestT4EvidenceEnglishDoesNotIncludeVirtualCoinSettlement(t *testing.T) {
	target, _ := startTestServer(t)
	hc := &http.Client{Timeout: 5 * time.Second}
	seller, err := devLogin(hc, target, "T4 Evidence English Seller", "seller")
	if err != nil {
		t.Fatal(err)
	}
	productID, err := createProduct(hc, target, seller.Token)
	if err != nil {
		t.Fatal(err)
	}
	var created struct {
		AuctionID string `json:"auctionId"`
	}
	rules := persistRules()
	rules.Mode = model.ModeEnglish
	if err := postJSON(hc, target+"/api/auctions", seller.Token, map[string]any{
		"productId":      productID,
		"rules":          rules,
		"factsConfirmed": true,
	}, &created); err != nil {
		t.Fatal(err)
	}

	var raw map[string]any
	if err := getJSONAuth(hc, target+"/api/auctions/"+created.AuctionID+"/evidence", seller.Token, &raw); err != nil {
		t.Fatalf("evidence english response: %v", err)
	}
	if got, ok := raw["settlement"]; ok {
		t.Fatalf("ENGLISH evidence exposed settlement=%v; want absent", got)
	}
}
