package server

import (
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

type auctionListItem struct {
	ID                string `json:"id"`
	Title             string `json:"title"`
	Status            string `json:"status"`
	CurrentPriceCents string `json:"currentPriceCents"`
}

func TestHandleListAuctionsRequiresAuth(t *testing.T) {
	target, _ := startTestServer(t)
	hc := &http.Client{Timeout: 5 * time.Second}

	req, err := http.NewRequest(http.MethodGet, target+"/api/auctions", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status=%d, want %d", resp.StatusCode, http.StatusUnauthorized)
	}
}

func TestHandleListAuctionsFiltersByStatus(t *testing.T) {
	target, _ := startTestServer(t)
	hc := &http.Client{Timeout: 5 * time.Second}

	seller, err := devLogin(hc, target, "List Seller", "seller")
	if err != nil {
		t.Fatal(err)
	}
	otherSeller, err := devLogin(hc, target, "Other List Seller", "seller")
	if err != nil {
		t.Fatal(err)
	}

	product1, err := createProduct(hc, target, seller.Token)
	if err != nil {
		t.Fatal(err)
	}
	product2, err := createProduct(hc, target, seller.Token)
	if err != nil {
		t.Fatal(err)
	}
	otherProduct, err := createProduct(hc, target, otherSeller.Token)
	if err != nil {
		t.Fatal(err)
	}

	aid1, err := createAuction(hc, target, seller.Token, product1)
	if err != nil {
		t.Fatal(err)
	}
	aid2, err := createAuction(hc, target, seller.Token, product2)
	if err != nil {
		t.Fatal(err)
	}
	_, err = createAuction(hc, target, otherSeller.Token, otherProduct)
	if err != nil {
		t.Fatal(err)
	}

	if err := postExpectCode(hc, target+"/api/auctions/"+aid1+"/cancel", seller.Token, nil, model.CodeOKCancelled); err != nil {
		t.Fatal(err)
	}

	var all []auctionListItem
	if err := getJSONAuth(hc, target+"/api/auctions", seller.Token, &all); err != nil {
		t.Fatalf("all auctions: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("len(all)=%d want 2", len(all))
	}

	var onlyDraft []auctionListItem
	qs := url.Values{}
	qs.Set("status", "draft")
	if err := getJSONAuth(hc, target+"/api/auctions?"+qs.Encode(), seller.Token, &onlyDraft); err != nil {
		t.Fatalf("draft auctions: %v", err)
	}
	if len(onlyDraft) != 1 {
		t.Fatalf("len(draft)=%d want 1", len(onlyDraft))
	}
	if got, want := onlyDraft[0].ID, aid2; got != want {
		t.Fatalf("draft[0].id=%s want %s", got, want)
	}
	if onlyDraft[0].Status != model.StateDraft {
		t.Fatalf("draft[0].status=%s want %s", onlyDraft[0].Status, model.StateDraft)
	}

	var onlyCancelled []auctionListItem
	if err := getJSONAuth(hc, target+"/api/auctions?status=CANCELLED", seller.Token, &onlyCancelled); err != nil {
		t.Fatalf("cancelled auctions: %v", err)
	}
	if len(onlyCancelled) != 1 {
		t.Fatalf("len(cancelled)=%d want 1", len(onlyCancelled))
	}
	if got, want := onlyCancelled[0].ID, aid1; got != want {
		t.Fatalf("cancelled[0].id=%s want %s", got, want)
	}
}
