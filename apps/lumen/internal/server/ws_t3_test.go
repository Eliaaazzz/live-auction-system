package server

// T3 end-to-end tests via the in-process harness (Redis+MySQL + hub + persistence
// + timer): Timer hammer to SOLD with broadcast + MySQL status projection, and
// cancel over REST (live, draft, forbidden) with AUCTION_CANCELLED broadcast.

import (
	"net/http"
	"testing"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

func pollStatus(t *testing.T, hc *http.Client, target, aid, want string, d time.Duration) {
	t.Helper()
	deadline := time.Now().Add(d)
	var last string
	for time.Now().Before(deadline) {
		var snap model.RoomSnapshotData
		if err := getJSON(hc, target+"/api/auctions/"+aid, &snap); err == nil {
			if snap.Status == want {
				return
			}
			last = snap.Status
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("auction %s status=%q did not reach %q within %s", aid, last, want, d)
}

// Timer Worker hammers a due auction (not depending on the next bid): the room
// gets AUCTION_SOLD via the Stream fanout and MySQL status is projected to SOLD.
func TestT3TimerHammerEndToEnd(t *testing.T) {
	target, _ := startTestServer(t)
	hc := &http.Client{Timeout: 5 * time.Second}
	seller, err := devLogin(hc, target, "T3 Hammer Seller", "seller")
	if err != nil {
		t.Fatal(err)
	}
	productID, err := createProduct(hc, target, seller.Token)
	if err != nil {
		t.Fatal(err)
	}
	// Custom rules with NO anti-snipe (extendWindowSec=0): otherwise a bid on a
	// short auction would (correctly) extend it past the test window. This isolates
	// the Timer hammer.
	var created struct {
		AuctionID string `json:"auctionId"`
	}
	if err := postJSON(hc, target+"/api/auctions", seller.Token, map[string]any{
		"productId":      productID,
		"rules":          model.Rules{StartPriceCents: 10000, IncrementCents: 1000, CapPriceCents: 1000000, DurationSec: 60},
		"factsConfirmed": true,
	}, &created); err != nil {
		t.Fatal(err)
	}
	aid := created.AuctionID
	if err := postExpectCode(hc, target+"/api/auctions/"+aid+"/freeze", seller.Token, nil, model.CodeOKFrozen); err != nil {
		t.Fatal(err)
	}
	// Short-ish auction so the Timer fires quickly, but wide enough that the WS bid
	// round-trip lands well before expiry even on a loaded CI runner (a 400ms window
	// could let the bid arrive after the hammer → ERR_AFTER_END → flake).
	if err := postExpectCode(hc, target+"/api/auctions/"+aid+"/start", seller.Token, map[string]int64{"durationMs": 1500}, model.CodeOKLive); err != nil {
		t.Fatal(err)
	}

	buyer, err := devLogin(hc, target, "T3 Hammer Buyer", "user")
	if err != nil {
		t.Fatal(err)
	}
	c, err := dialAndJoin(target, buyer.Token, aid)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	bid, _ := model.NewEnvelope(model.TypeBidPlace, aid, 0, model.BidPlaceData{ClientBidID: "cbT3", AmountCents: "11000"})
	if err := c.WriteJSON(bid); err != nil {
		t.Fatal(err)
	}
	if err := waitForType(c, model.TypeBidAccepted, 5*time.Second); err != nil {
		t.Fatalf("bid not accepted: %v", err)
	}
	// the Timer hammers ~1.5s in; the room receives AUCTION_SOLD via Stream fanout.
	if err := waitForType(c, model.TypeAuctionSold, 5*time.Second); err != nil {
		t.Fatalf("timer did not broadcast AUCTION_SOLD: %v", err)
	}
	// MySQL status projected from the terminal event by the persistence worker.
	pollStatus(t, hc, target, aid, model.StateSold, 5*time.Second)
}

// Cancel a LIVE auction over REST: OK_CANCELLED, AUCTION_CANCELLED broadcast, MySQL CANCELLED.
func TestT3CancelLiveEndToEnd(t *testing.T) {
	target, _ := startTestServer(t)
	hc := &http.Client{Timeout: 5 * time.Second}
	seller, err := devLogin(hc, target, "T3 Cancel Seller", "seller")
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
	buyer, err := devLogin(hc, target, "T3 Cancel Buyer", "user")
	if err != nil {
		t.Fatal(err)
	}
	c, err := dialAndJoin(target, buyer.Token, aid)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	if err := postExpectCode(hc, target+"/api/auctions/"+aid+"/cancel", seller.Token, nil, model.CodeOKCancelled); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if err := waitForType(c, model.TypeAuctionCancelled, 5*time.Second); err != nil {
		t.Fatalf("room did not receive AUCTION_CANCELLED: %v", err)
	}
	pollStatus(t, hc, target, aid, model.StateCancelled, 5*time.Second)
}

// Cancel an unfrozen DRAFT (MySQL-only path) and reject a non-owner cancel (403).
func TestT3CancelDraftAndForbidden(t *testing.T) {
	target, _ := startTestServer(t)
	hc := &http.Client{Timeout: 5 * time.Second}
	seller, err := devLogin(hc, target, "T3 Draft Seller", "seller")
	if err != nil {
		t.Fatal(err)
	}
	productID, err := createProduct(hc, target, seller.Token)
	if err != nil {
		t.Fatal(err)
	}
	aid, err := createAuction(hc, target, seller.Token, productID) // DRAFT (not frozen)
	if err != nil {
		t.Fatal(err)
	}

	// non-owner cancel → 403.
	other, err := devLogin(hc, target, "T3 Other Seller", "seller")
	if err != nil {
		t.Fatal(err)
	}
	if resp, data, err := postJSONRaw(hc, target+"/api/auctions/"+aid+"/cancel", other.Token, nil); err != nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("non-owner cancel status=%v body=%s err=%v want 403", statusOf(resp), string(data), err)
	}

	// owner cancels the DRAFT (MySQL-only) → OK_CANCELLED, status CANCELLED.
	if err := postExpectCode(hc, target+"/api/auctions/"+aid+"/cancel", seller.Token, nil, model.CodeOKCancelled); err != nil {
		t.Fatalf("draft cancel: %v", err)
	}
	pollStatus(t, hc, target, aid, model.StateCancelled, 5*time.Second)

	// cancelling a terminal auction again → 409 ERR_ALREADY_TERMINAL.
	resp, _, err := postJSONRaw(hc, target+"/api/auctions/"+aid+"/cancel", seller.Token, nil)
	if err != nil || resp.StatusCode != http.StatusConflict {
		t.Fatalf("re-cancel status=%v err=%v want 409", statusOf(resp), err)
	}
}

func statusOf(resp *http.Response) int {
	if resp == nil {
		return 0
	}
	return resp.StatusCode
}
