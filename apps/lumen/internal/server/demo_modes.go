package server

// Per-mode demo drivers (issue #114). Each RunDemo<Mode> mirrors RunDemo: a
// self-contained, asserted flow that exits non-zero on any failed invariant, so
// `make demo-<mode>` is the executable proof of that mode (not a screen
// recording). They reuse the e2e.go / demo.go helpers (same package).

import (
	"fmt"
	"net/http"
	"time"

	"github.com/gorilla/websocket"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

// createDemoAuctionWithRules publishes a demo auction with explicit rules, so a
// per-mode demo can drive any mode/rule shape. Mirrors createDemoAuction.
func createDemoAuctionWithRules(hc *http.Client, target, token, productID string, rules model.Rules) (string, error) {
	var out struct {
		AuctionID string `json:"auctionId"`
	}
	body := map[string]any{
		"productId":      productID,
		"rules":          rules,
		"factsConfirmed": true, // seller confirmed the AI facts draft
	}
	err := postJSON(hc, target+"/api/auctions", token, body, &out)
	return out.AuctionID, err
}

// RunDemoSuddenDeath proves SUDDEN_DEATH disables anti-snipe (Whatnot-style): a
// bid that WOULD extend an English auction is accepted but produces NO
// AUCTION_EXTENDED, and the hammer fires at the original endAtMs. The mode
// normalization (mode.go) zeroes the extend window at creation, so
// place_bid.lua never extends — proving the mode plumbing end-to-end on a real
// stack. Asserted; exit != 0 on any failure.
func RunDemoSuddenDeath(target string) error {
	hc := &http.Client{Timeout: 10 * time.Second}

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
	// demoRules carries a real extend window; SUDDEN_DEATH must override it to
	// "no extension". We start short and assert that override holds at runtime.
	rules := demoRules()
	rules.Mode = model.ModeSuddenDeath
	aid, err := createDemoAuctionWithRules(hc, target, seller.Token, productID, rules)
	if err != nil {
		return fmt.Errorf("create auction: %w", err)
	}
	if err := postExpectCode(hc, target+"/api/auctions/"+aid+"/freeze", seller.Token, nil, model.CodeOKFrozen); err != nil {
		return fmt.Errorf("freeze rules: %w", err)
	}
	if err := postExpectCode(hc, target+"/api/auctions/"+aid+"/start", seller.Token,
		map[string]int64{"durationMs": demoDurationMs}, model.CodeOKLive); err != nil {
		return fmt.Errorf("start: %w", err)
	}

	buyer, err := devLogin(hc, target, "Demo Bidder A", "user")
	if err != nil {
		return fmt.Errorf("bidder dev-login: %w", err)
	}
	conn, err := dialAndJoin(target, buyer.Token, aid)
	if err != nil {
		return fmt.Errorf("bidder connect: %w", err)
	}
	defer conn.Close()

	// A bid lands well inside what WOULD be an English auction's anti-snipe
	// window. SUDDEN_DEATH has no window, so it must NOT extend, and the hammer
	// must fire at the original endAtMs. We read on ONE continuous deadline
	// (asserting no AUCTION_EXTENDED en route to AUCTION_SOLD) — splitting it into
	// a separate timed "expect no extend" read would let a mid-stream read
	// timeout break the connection before AUCTION_SOLD arrives.
	if err := placeDemoBid(conn, aid, "11000"); err != nil {
		return fmt.Errorf("bid: %w", err)
	}
	if err := waitForSoldNoExtend(conn, 40*time.Second); err != nil {
		return fmt.Errorf("hammer (no extend → AUCTION_SOLD): %w", err)
	}

	head, err := fetchEvidenceHead(hc, target, aid, seller.Token, 8*time.Second)
	if err != nil {
		return err
	}
	if len(head) > 8 {
		head = head[:8]
	}
	fmt.Printf("DEMO_AUCTION_ID=%s\n", aid)
	fmt.Printf("demo-sudden-death: PASS · no AUCTION_EXTENDED → AUCTION_SOLD → eventsHash=%s…\n", head)
	return nil
}

// waitForSoldNoExtend reads frames on a SINGLE deadline until AUCTION_SOLD,
// failing if AUCTION_EXTENDED appears first (the sudden-death invariant). One
// continuous read avoids the broken-connection trap of timing out a separate
// "expect no extend" read before AUCTION_SOLD arrives.
func waitForSoldNoExtend(c *websocket.Conn, d time.Duration) error {
	_ = c.SetReadDeadline(time.Now().Add(d))
	for {
		var env model.Envelope
		if err := c.ReadJSON(&env); err != nil {
			return err
		}
		switch env.Type {
		case model.TypeAuctionExtended:
			return fmt.Errorf("got AUCTION_EXTENDED (sudden-death must not extend)")
		case model.TypeAuctionSold:
			return nil
		}
	}
}

// fetchEvidenceHead polls the evidence card until the hash-chain head is
// published — the persistence worker projects the Stream asynchronously, so the
// head can lag the AUCTION_SOLD broadcast by a beat. Returns the chain head.
func fetchEvidenceHead(hc *http.Client, target, aid, token string, d time.Duration) (string, error) {
	deadline := time.Now().Add(d)
	for {
		var ev struct {
			EventsHash string `json:"eventsHash"`
		}
		err := getJSONAuth(hc, target+"/api/auctions/"+aid+"/evidence", token, &ev)
		if err == nil && ev.EventsHash != "" {
			return ev.EventsHash, nil
		}
		if time.Now().After(deadline) {
			if err != nil {
				return "", fmt.Errorf("evidence fetch: %w", err)
			}
			return "", fmt.Errorf("evidence card has empty eventsHash (chain head must be published per §6)")
		}
		time.Sleep(250 * time.Millisecond)
	}
}
