package server

// HT-060 (review doc): the seller must not be able to bid on their own auction
// over the WS path (anti shill-bidding). Exercises the full REST setup + WS
// dispatch → place_bid.lua seller guard, via the in-process harness.

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

func TestT2HiddenSellerCannotBidOwnAuctionOverWS(t *testing.T) {
	target, _ := startTestServer(t)
	hc := &http.Client{Timeout: 5 * time.Second}

	seller, err := devLogin(hc, target, "WS Seller", "seller")
	if err != nil {
		t.Fatal(err)
	}
	productID, err := createProduct(hc, target, seller.Token)
	if err != nil {
		t.Fatal(err)
	}
	aid, err := createAuction(hc, target, seller.Token, productID)
	if err != nil {
		t.Fatal(err)
	}
	if err := postExpectCode(hc, target+"/api/auctions/"+aid+"/freeze", seller.Token, nil, model.CodeOKFrozen); err != nil {
		t.Fatal(err)
	}
	if err := postExpectCode(hc, target+"/api/auctions/"+aid+"/start", seller.Token, map[string]int64{"durationMs": 60000}, model.CodeOKLive); err != nil {
		t.Fatal(err)
	}

	// seller dials + joins their OWN auction and tries to bid.
	c, err := dialAndJoin(target, seller.Token, aid)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	bid, _ := model.NewEnvelope(model.TypeBidPlace, aid, 0, model.BidPlaceData{ClientBidID: "cb_self", AmountCents: "11000"})
	if err := c.WriteJSON(bid); err != nil {
		t.Fatal(err)
	}

	// expect BID_REJECTED{ERR_NOT_ALLOWED}.
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		var env model.Envelope
		if err := c.ReadJSON(&env); err != nil {
			t.Fatalf("read: %v", err)
		}
		switch env.Type {
		case model.TypeBidRejected:
			var d model.BidRejectedData
			if err := json.Unmarshal(env.Data, &d); err != nil {
				t.Fatal(err)
			}
			if d.Code != model.CodeErrNotAllow {
				t.Fatalf("seller self-bid code=%s want ERR_NOT_ALLOWED", d.Code)
			}
			return
		case model.TypeBidAccepted:
			t.Fatal("seller self-bid was ACCEPTED; must be rejected")
		}
	}
}
