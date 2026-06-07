package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

func TestPlaceBidHTTPReturnsDirectOutcomeAndStillFansOut(t *testing.T) {
	target, _ := startTestServer(t)
	hc := &http.Client{Timeout: 5 * time.Second}

	seller, err := devLogin(hc, target, "HTTP Bid Seller", "seller")
	if err != nil {
		t.Fatalf("seller login: %v", err)
	}
	productID, err := createProduct(hc, target, seller.Token)
	if err != nil {
		t.Fatalf("create product: %v", err)
	}
	aid, err := createAuction(hc, target, seller.Token, productID)
	if err != nil {
		t.Fatalf("create auction: %v", err)
	}
	if err := postExpectCode(hc, target+"/api/auctions/"+aid+"/freeze", seller.Token, nil, model.CodeOKFrozen); err != nil {
		t.Fatalf("freeze: %v", err)
	}
	if err := postExpectCode(hc, target+"/api/auctions/"+aid+"/start", seller.Token, map[string]int64{"durationMs": 60000}, model.CodeOKLive); err != nil {
		t.Fatalf("start: %v", err)
	}

	buyer, err := devLogin(hc, target, "HTTP Bid Buyer", "user")
	if err != nil {
		t.Fatalf("buyer login: %v", err)
	}
	observer, err := dialAndJoin(target, buyer.Token, aid)
	if err != nil {
		t.Fatalf("observer join: %v", err)
	}
	defer observer.Close()

	var direct model.Envelope
	bid := model.BidPlaceData{
		ClientBidID: fmt.Sprintf("http_cb_%d", time.Now().UnixNano()),
		AmountCents: "11000",
	}
	if err := postJSON(hc, target+"/api/auctions/"+aid+"/bids", buyer.Token, bid, &direct); err != nil {
		t.Fatalf("http bid: %v", err)
	}
	if direct.Type != model.TypeBidAccepted || direct.AuctionID != aid {
		t.Fatalf("direct outcome=%+v", direct)
	}
	var data model.BidAcceptedData
	if err := json.Unmarshal(direct.Data, &data); err != nil {
		t.Fatalf("direct data: %v", err)
	}
	if data.UserID != buyer.UserID || data.AmountCents != bid.AmountCents {
		t.Fatalf("direct data=%+v want user=%s amount=%s", data, buyer.UserID, bid.AmountCents)
	}

	if err := waitForType(observer, model.TypeBidAccepted, 5*time.Second); err != nil {
		t.Fatalf("observer did not receive fanout after HTTP bid: %v", err)
	}
	if err := waitEventsCount(hc, target, aid, 1, 30*time.Second); err != nil {
		t.Fatalf("persistence projection: %v", err)
	}
}
