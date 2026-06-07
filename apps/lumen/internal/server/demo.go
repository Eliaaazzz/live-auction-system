package server

// T10 demo-auction driver (V9 §12 nodes 4-5). RunE2E proves the single-bid
// roundtrip (§12.1-3) but stops before the timer, so it never exercises the
// anti-snipe extension or the hammer. RunDemo drives ONE auction all the way
// through the parts a 3-min demo hangs on: an in-window bid that extends the
// countdown (AUCTION_EXTENDED), a competing snipe that extends again, then —
// once bidding stops — the Timer Worker hammering to AUCTION_SOLD, and finally
// the evidence card publishing the hash-chain head. Every step is asserted, so
// `make demo-auction` is the executable form of demo nodes 4-5 (not a screen
// recording). Reuses the e2e.go helpers (same package).

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/gorilla/websocket"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

// Demo timing knobs. Two independent requirements make AUCTION_EXTENDED fire
// deterministically for BOTH demo bids (not just the first):
//
//  1. The auction must still be LIVE when each bid lands → demoDurationMs must
//     comfortably exceed the WS setup overhead (2 dev-logins + 2 dials).
//  2. Each bid must satisfy place_bid.lua's in-window check
//     `(endAtMs - now) <= ExtendWindowSec*1000`. The extend is ACCUMULATIVE
//     (`endAtMs += ExtendSec`), so after the first snipe pushes endAtMs out, a
//     window that merely equals the duration leaves the SECOND bid outside it
//     — which is the bug this replaced (first extend fired, second timed out).
//     So the window must exceed duration + ExtendSec*MaxExtensions. We set it
//     far larger (10 min) so every bid in the demo counts as a snipe regardless
//     of timing; MaxExtensions still bounds it so the Timer Worker hammers to
//     SOLD at endAtMs = start + duration + ExtendSec*MaxExtensions.
const (
	demoDurationMs      = 12000 // LIVE long enough for setup + both bids
	demoExtendWindowSec = 600   // >> duration + ExtendSec*MaxExtensions → both bids always in-window
	demoExtendSec       = 3
	demoMaxExtensions   = 2 // hammer fires at start + 12s + 2*3s = ~18s
)

// demoRules is the auction config the demo drives. Package-level so demo_test.go
// can assert the deterministic-extension invariant without a live stack.
func demoRules() model.Rules {
	return model.Rules{
		StartPriceCents: 10000,
		IncrementCents:  1000,
		CapPriceCents:   1000000,
		DurationSec:     demoDurationMs / 1000, // rules duration; `start` overrides with demoDurationMs
		ExtendWindowSec: demoExtendWindowSec,
		ExtendSec:       demoExtendSec,
		MaxExtensions:   demoMaxExtensions,
	}
}

// RunDemo drives §12 nodes 4-5 on a single auction and asserts each. Returns an
// error (exit != 0) on any failed assertion so `make demo-auction` is a gate.
func RunDemo(target string) error {
	hc := &http.Client{Timeout: 10 * time.Second}

	// §12.1-2: seller lists, AI drafts facts, seller confirms + freezes rules.
	seller, err := devLogin(hc, target, "Demo Seller", "seller")
	if err != nil {
		return fmt.Errorf("seller dev-login: %w", err)
	}
	productID, err := createProduct(hc, target, seller.Token)
	if err != nil {
		return fmt.Errorf("create product: %w", err)
	}
	if err := assertFactsMock(hc, target, seller.Token, productID); err != nil {
		return fmt.Errorf("VLM facts draft: %w", err)
	}
	aid, err := createDemoAuction(hc, target, seller.Token, productID)
	if err != nil {
		return fmt.Errorf("create auction: %w", err)
	}
	if err := postExpectCode(hc, target+"/api/auctions/"+aid+"/freeze", seller.Token, nil, model.CodeOKFrozen); err != nil {
		return fmt.Errorf("freeze rules: %w", err)
	}
	// §12.3: start short so the whole auction sits inside the anti-snipe window.
	if err := postExpectCode(hc, target+"/api/auctions/"+aid+"/start", seller.Token,
		map[string]int64{"durationMs": demoDurationMs}, model.CodeOKLive); err != nil {
		return fmt.Errorf("start: %w", err)
	}

	// Two distinct bidders so the second bid is a genuine competing snipe (not a
	// self-raise from the current leader, which the engine may reject). connA
	// doubles as the room observer we read broadcasts from.
	buyerA, err := devLogin(hc, target, "Demo Bidder A", "user")
	if err != nil {
		return fmt.Errorf("bidder A dev-login: %w", err)
	}
	buyerB, err := devLogin(hc, target, "Demo Bidder B", "user")
	if err != nil {
		return fmt.Errorf("bidder B dev-login: %w", err)
	}
	connA, err := dialAndJoin(target, buyerA.Token, aid)
	if err != nil {
		return fmt.Errorf("bidder A connect: %w", err)
	}
	defer connA.Close()
	connB, err := dialAndJoin(target, buyerB.Token, aid)
	if err != nil {
		return fmt.Errorf("bidder B connect: %w", err)
	}
	defer connB.Close()

	// §12.4: a bid inside the anti-snipe window extends the countdown. This is
	// THE anti-snipe assertion RunE2E lacks. We read every broadcast on connA.
	if err := placeDemoBid(connA, aid, "11000"); err != nil {
		return fmt.Errorf("first bid: %w", err)
	}
	ext1, err := waitForExtended(connA, 8*time.Second)
	if err != nil {
		return fmt.Errorf("first AUCTION_EXTENDED: %w", err)
	}
	if ext1.ExtendCount != 1 {
		return fmt.Errorf("first extend: extendCount=%d, want 1", ext1.ExtendCount)
	}
	// A competing snipe from the other bidder extends again (bounded by MaxExtensions).
	if err := placeDemoBid(connB, aid, "12000"); err != nil {
		return fmt.Errorf("second bid: %w", err)
	}
	ext2, err := waitForExtended(connA, 8*time.Second)
	if err != nil {
		return fmt.Errorf("second AUCTION_EXTENDED: %w", err)
	}
	if ext2.ExtendCount != 2 {
		return fmt.Errorf("second extend: extendCount=%d, want 2 (MaxExtensions=%d)", ext2.ExtendCount, demoMaxExtensions)
	}

	// §12.5: stop bidding → the Timer Worker hammers the (extended) auction to
	// SOLD at endAtMs = start + demoDurationMs + demoExtendSec*demoMaxExtensions
	// (~18s). Wait covers that with margin for slow setup on a cold box.
	if err := waitForType(connA, model.TypeAuctionSold, 45*time.Second); err != nil {
		return fmt.Errorf("hammer (AUCTION_SOLD): %w", err)
	}

	// §12.5: the evidence card publishes the hash-chain head (events_hash) per §6.
	// The persistence worker projects the stream asynchronously, so poll instead
	// of making a single immediate read after AUCTION_SOLD.
	headPrefix, err := fetchEvidenceHead(hc, target, aid, seller.Token, 20*time.Second)
	if err != nil {
		return err
	}
	if len(headPrefix) > 8 {
		headPrefix = headPrefix[:8]
	}
	fmt.Printf("DEMO_AUCTION_ID=%s\n", aid)
	fmt.Printf("demo-auction: PASS · anti-snipe extendCount=%d → AUCTION_SOLD → eventsHash=%s…\n", ext2.ExtendCount, headPrefix)
	return nil
}

func createDemoAuction(hc *http.Client, target, token, productID string) (string, error) {
	var out struct {
		AuctionID string `json:"auctionId"`
	}
	body := map[string]any{
		"productId":      productID,
		"rules":          demoRules(),
		"factsConfirmed": true, // seller confirmed the AI facts draft
	}
	err := postJSON(hc, target+"/api/auctions", token, body, &out)
	return out.AuctionID, err
}

func placeDemoBid(c *websocket.Conn, aid, amount string) error {
	bid, _ := model.NewEnvelope(model.TypeBidPlace, aid, 0, model.BidPlaceData{
		ClientBidID: fmt.Sprintf("cb_demo_%d", time.Now().UnixNano()),
		AmountCents: amount,
	})
	return c.WriteJSON(bid)
}

// waitForExtended reads frames until an AUCTION_EXTENDED arrives (skipping the
// BID_ACCEPTED ack and any other broadcast) and returns its payload, so the
// caller can assert the running extendCount.
func waitForExtended(c *websocket.Conn, d time.Duration) (model.AuctionExtendedData, error) {
	_ = c.SetReadDeadline(time.Now().Add(d))
	for {
		var env model.Envelope
		if err := c.ReadJSON(&env); err != nil {
			return model.AuctionExtendedData{}, err
		}
		if env.Type == model.TypeAuctionExtended {
			var ad model.AuctionExtendedData
			if err := json.Unmarshal(env.Data, &ad); err != nil {
				return model.AuctionExtendedData{}, fmt.Errorf("parse AUCTION_EXTENDED: %w", err)
			}
			return ad, nil
		}
	}
}
