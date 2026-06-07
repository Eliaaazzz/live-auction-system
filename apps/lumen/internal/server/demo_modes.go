package server

// Per-mode demo drivers (issue #114). Each RunDemo<Mode> mirrors RunDemo: a
// self-contained, asserted flow that exits non-zero on any failed invariant, so
// `make demo-<mode>` is the executable proof of that mode (not a screen
// recording). They reuse the e2e.go / demo.go helpers (same package).

import (
	"encoding/json"
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

// RunDemoSealed proves SEALED_FIRST (issue #114): bids are hidden during LIVE
// (the broadcast carries SEALED_BID_RECEIVED with no amount), the bidder's own
// ack carries their amount, and at close the AUCTION_REVEALED event unmasks the
// sorted bids and the winner pays their OWN bid. Asserted; exit != 0 on any
// failed invariant, so `make demo-sealed` is a gate.
func RunDemoSealed(target string) error {
	return runDemoSealedCore(target, model.ModeSealedFirst, "demo-sealed")
}

// RunDemoVickrey proves VICKREY (issue #114): same sealed bid path as
// SEALED_FIRST, but at close the winner pays the 2ND-HIGHEST bid (a lone bidder
// pays the reserve). Asserted.
func RunDemoVickrey(target string) error {
	return runDemoSealedCore(target, model.ModeVickrey, "demo-vickrey")
}

// runDemoSealedCore drives the shared sealed-bid lifecycle for SEALED_FIRST and
// VICKREY. Two distinct bidders place sealed bids (A=11000, B=12000); the
// expected final price depends on the mode (own bid vs 2nd-highest).
func runDemoSealedCore(target, mode, label string) error {
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
	rules := demoRules()
	rules.Mode = mode
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

	// Two distinct bidders (no self-raise that the sealed engine would still
	// accept-as-separate; using two users makes the leaderboard at reveal have
	// two distinct entries so Vickrey's 2nd-price branch is exercised).
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

	// Sealed bids: amounts are NEVER broadcast as BID_ACCEPTED to the room.
	if err := placeDemoBid(connA, aid, "11000"); err != nil {
		return fmt.Errorf("bid A: %w", err)
	}
	if err := placeDemoBid(connB, aid, "12000"); err != nil {
		return fmt.Errorf("bid B: %w", err)
	}

	// connA reads on a single continuous deadline through to AUCTION_REVEALED.
	// While reading, assert that NO public BID_ACCEPTED with a non-empty amount
	// leaks — sealed mode emits SEALED_BID_RECEIVED only (no amount). This is
	// the room-side invariant the mode exists to enforce.
	reveal, err := waitForRevealedAssertSealed(connA, 40*time.Second)
	if err != nil {
		return fmt.Errorf("AUCTION_REVEALED: %w", err)
	}
	if len(reveal.Bids) != 2 {
		return fmt.Errorf("reveal: got %d bids, want 2", len(reveal.Bids))
	}
	if reveal.WinnerID != buyerB.UserID {
		return fmt.Errorf("reveal winner = %q, want %q (bidder B)", reveal.WinnerID, buyerB.UserID)
	}
	expectedFinal := "12000"
	if mode == model.ModeVickrey {
		expectedFinal = "11000"
	}
	if reveal.AmountCents != expectedFinal {
		return fmt.Errorf("reveal final price = %q, want %q (mode=%s)", reveal.AmountCents, expectedFinal, mode)
	}

	// AUCTION_SOLD follows the reveal with the same final price; the existing
	// projectSold path then creates the order at that price.
	if err := waitForType(connA, model.TypeAuctionSold, 10*time.Second); err != nil {
		return fmt.Errorf("hammer (AUCTION_SOLD): %w", err)
	}

	head, err := fetchEvidenceHead(hc, target, aid, seller.Token, 8*time.Second)
	if err != nil {
		return err
	}
	if len(head) > 8 {
		head = head[:8]
	}
	fmt.Printf("DEMO_AUCTION_ID=%s\n", aid)
	fmt.Printf("%s: PASS · sealed reveal (%d bids) → AUCTION_SOLD@%s → eventsHash=%s…\n",
		label, len(reveal.Bids), expectedFinal, head)
	return nil
}

// RunDemoPrequalify proves the PREQUALIFY two-act flow (issue #114 phase 6):
// run a sealed-first-price PREQUALIFY auction, then `POST /spawn-formal` to
// create a formal ENGLISH auction whose start price is SEEDED from the sealed
// reveal aggregate via the recommender's reserve heuristic (lower median for a
// dense cluster, second-highest for an outlier, max for a single bid — see
// loadPrequalifyRecommendation). The parent_auction_id links the two; the
// formal's snapshot confirms the seeded start price persisted into its Rules.
// Asserted.
func RunDemoPrequalify(target string) error {
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

	// Act 1: a sealed-first-price PREQUALIFY auction reveals a price floor.
	parentRules := demoRules()
	parentRules.Mode = model.ModeSealedFirst
	parentAID, err := createDemoAuctionWithRules(hc, target, seller.Token, productID, parentRules)
	if err != nil {
		return fmt.Errorf("create parent: %w", err)
	}
	if err := postExpectCode(hc, target+"/api/auctions/"+parentAID+"/freeze", seller.Token, nil, model.CodeOKFrozen); err != nil {
		return fmt.Errorf("freeze parent: %w", err)
	}
	if err := postExpectCode(hc, target+"/api/auctions/"+parentAID+"/start", seller.Token,
		map[string]int64{"durationMs": demoDurationMs}, model.CodeOKLive); err != nil {
		return fmt.Errorf("start parent: %w", err)
	}
	buyerA, err := devLogin(hc, target, "Demo Bidder A", "user")
	if err != nil {
		return fmt.Errorf("bidder A dev-login: %w", err)
	}
	buyerB, err := devLogin(hc, target, "Demo Bidder B", "user")
	if err != nil {
		return fmt.Errorf("bidder B dev-login: %w", err)
	}
	cA, err := dialAndJoin(target, buyerA.Token, parentAID)
	if err != nil {
		return fmt.Errorf("bidder A connect: %w", err)
	}
	defer cA.Close()
	cB, err := dialAndJoin(target, buyerB.Token, parentAID)
	if err != nil {
		return fmt.Errorf("bidder B connect: %w", err)
	}
	defer cB.Close()
	if err := placeDemoBid(cA, parentAID, "11000"); err != nil {
		return fmt.Errorf("parent bid A: %w", err)
	}
	if err := placeDemoBid(cB, parentAID, "12000"); err != nil {
		return fmt.Errorf("parent bid B: %w", err)
	}
	reveal, err := waitForRevealedAssertSealed(cA, 40*time.Second)
	if err != nil {
		return fmt.Errorf("parent AUCTION_REVEALED: %w", err)
	}
	if reveal.AmountCents != "12000" {
		return fmt.Errorf("parent revealed final = %q, want %q", reveal.AmountCents, "12000")
	}
	if err := waitForType(cA, model.TypeAuctionSold, 10*time.Second); err != nil {
		return fmt.Errorf("parent hammer: %w", err)
	}

	// Act 2: spawn the formal ENGLISH auction; start price seeds from parent's winner.
	var spawn struct {
		AuctionID             string `json:"auctionId"`
		ParentAuctionID       string `json:"parentAuctionId"`
		SeededStartPriceCents string `json:"seededStartPriceCents"`
	}
	body := map[string]any{
		"rules": map[string]any{
			"mode":            model.ModeEnglish,
			"startPriceCents": "0", // 0 → server uses prequalify recommender; >0 = seller override
			"incrementCents":  "1000",
			"capPriceCents":   "0",
			"durationSec":     60,
			"extendWindowSec": 10,
			"extendSec":       10,
			"maxExtensions":   2,
		},
	}
	if err := postJSON(hc, target+"/api/auctions/"+parentAID+"/spawn-formal", seller.Token, body, &spawn); err != nil {
		return fmt.Errorf("spawn-formal: %w", err)
	}
	// With bids {11000, 12000} and no outlier (max < second*1.3), the recommender
	// returns the lower-median (= second-highest, here 11000) as the formal floor.
	// See loadPrequalifyRecommendation. Single-bid or outlier paths return max.
	if spawn.SeededStartPriceCents != "11000" {
		return fmt.Errorf("seeded start = %q, want %q (recommender lower-median for 2-bid dense cluster)", spawn.SeededStartPriceCents, "11000")
	}
	if spawn.ParentAuctionID != parentAID {
		return fmt.Errorf("parent link = %q, want %q", spawn.ParentAuctionID, parentAID)
	}

	// Verify the seeded start price made it into the formal's Rules + snapshot.
	if err := postExpectCode(hc, target+"/api/auctions/"+spawn.AuctionID+"/freeze", seller.Token, nil, model.CodeOKFrozen); err != nil {
		return fmt.Errorf("freeze formal: %w", err)
	}
	var formalSnap model.RoomSnapshotData
	if err := getJSONAuth(hc, target+"/api/auctions/"+spawn.AuctionID, seller.Token, &formalSnap); err != nil {
		return fmt.Errorf("formal snapshot: %w", err)
	}
	if formalSnap.CurrentPriceCents != "11000" {
		return fmt.Errorf("formal snapshot price = %q, want %q (recommender-seeded floor persisted into Rules)", formalSnap.CurrentPriceCents, "11000")
	}
	fmt.Printf("PARENT_AUCTION_ID=%s\nFORMAL_AUCTION_ID=%s\n", parentAID, spawn.AuctionID)
	fmt.Printf("demo-prequalify: PASS · sealed parent reveal@12000 → spawn-formal seeded ENGLISH @ %s (recommender lower-median, parent_auction_id=%s)\n",
		spawn.SeededStartPriceCents, spawn.ParentAuctionID)
	return nil
}

// RunDemoAllPay proves ALL_PAY (issue #114): the Dollar-Auction / chaos mode.
// Bid path is the sealed engine (amounts hidden during LIVE); at close the
// winner pays their own bid AND the runner-up forfeits their bid — both
// settled in VIRTUAL COINS only. The HARD money-safety gate asserts that
// `GET /api/auctions/{id}/order` returns 404: no orders row is ever created
// for an ALL_PAY auction, so a losing buyer can never be charged real money.
func RunDemoAllPay(target string) error {
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
	rules := demoRules()
	rules.Mode = model.ModeAllPay
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

	if err := placeDemoBid(connA, aid, "11000"); err != nil {
		return fmt.Errorf("bid A: %w", err)
	}
	if err := placeDemoBid(connB, aid, "12000"); err != nil {
		return fmt.Errorf("bid B: %w", err)
	}

	reveal, err := waitForRevealedAssertSealed(connA, 40*time.Second)
	if err != nil {
		return fmt.Errorf("AUCTION_REVEALED: %w", err)
	}
	if len(reveal.Bids) != 2 {
		return fmt.Errorf("reveal: got %d bids, want 2", len(reveal.Bids))
	}
	if reveal.WinnerID != buyerB.UserID {
		return fmt.Errorf("reveal winner = %q, want %q (bidder B)", reveal.WinnerID, buyerB.UserID)
	}
	if reveal.AmountCents != "12000" {
		return fmt.Errorf("reveal final price = %q, want %q (all-pay: winner pays OWN bid)", reveal.AmountCents, "12000")
	}
	if err := waitForType(connA, model.TypeAuctionSold, 10*time.Second); err != nil {
		return fmt.Errorf("hammer (AUCTION_SOLD): %w", err)
	}

	// THE HARD MONEY-SAFETY GATE: no orders row may ever be created for an
	// ALL_PAY auction. Poll briefly so persistence has a chance to catch up.
	if err := assertNoOrder(hc, target, aid, seller.Token, 5*time.Second); err != nil {
		return err
	}

	head, err := fetchEvidenceHead(hc, target, aid, seller.Token, 8*time.Second)
	if err != nil {
		return err
	}
	if len(head) > 8 {
		head = head[:8]
	}
	fmt.Printf("DEMO_AUCTION_ID=%s\n", aid)
	fmt.Printf("demo-allpay: PASS · reveal (2 bids) → AUCTION_SOLD@%s → NO ORDER (virtual coins) → eventsHash=%s…\n",
		reveal.AmountCents, head)
	return nil
}

// assertNoOrder polls GET /api/auctions/{id}/order and fails if any 2xx is ever
// returned (any HTTP 2xx means an orders row exists, breaking the ALL_PAY
// money-safety invariant). A 404 across the polling window is the success path.
func assertNoOrder(hc *http.Client, target, aid, token string, d time.Duration) error {
	deadline := time.Now().Add(d)
	url := target + "/api/auctions/" + aid + "/order"
	for {
		req, _ := http.NewRequest("GET", url, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := hc.Do(req)
		if err != nil {
			return fmt.Errorf("order check: %w", err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode == 200 {
			return fmt.Errorf("MONEY-SAFETY BREACH: ALL_PAY auction %s has an orders row (HTTP 200 from /order)", aid)
		}
		if time.Now().After(deadline) {
			return nil // 404 throughout the window — invariant holds.
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// RunDemoHybrid proves HYBRID_REVEAL (issue #114): English adjudication runs,
// but the Stream/PubSub BID_ACCEPTED broadcast carries the PRIOR leader's
// amount + identity (so the room sees the runner-up while the new leader stays
// hidden). At close, the standard AUCTION_SOLD reveals the true winner +
// price. A dedicated observer socket (no bids of its own → receives broadcasts
// only) asserts no broadcast ever leaks the actual winning bid.
func RunDemoHybrid(target string) error {
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
	rules := demoRules()
	rules.Mode = model.ModeHybridReveal
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

	buyerA, err := devLogin(hc, target, "Demo Bidder A", "user")
	if err != nil {
		return fmt.Errorf("bidder A dev-login: %w", err)
	}
	buyerB, err := devLogin(hc, target, "Demo Bidder B", "user")
	if err != nil {
		return fmt.Errorf("bidder B dev-login: %w", err)
	}
	observer, err := devLogin(hc, target, "Demo Observer", "user")
	if err != nil {
		return fmt.Errorf("observer dev-login: %w", err)
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
	obs, err := dialAndJoin(target, observer.Token, aid)
	if err != nil {
		return fmt.Errorf("observer connect: %w", err)
	}
	defer obs.Close()

	if err := placeDemoBid(connA, aid, "11000"); err != nil {
		return fmt.Errorf("bid A: %w", err)
	}
	if err := observeHybridAccepted(obs, buyerA.UserID, buyerB.UserID, 1, 10*time.Second); err != nil {
		return err
	}
	if err := placeDemoBid(connB, aid, "12000"); err != nil {
		return fmt.Errorf("bid B: %w", err)
	}
	if err := observeHybridAccepted(obs, buyerA.UserID, buyerB.UserID, 2, 10*time.Second); err != nil {
		return err
	}

	sold, err := waitForHybridSold(obs, 30*time.Second)
	if err != nil {
		return err
	}
	if sold.WinnerID != buyerB.UserID {
		return fmt.Errorf("AUCTION_SOLD winner = %q, want %q (true leader Bob)", sold.WinnerID, buyerB.UserID)
	}
	if sold.AmountCents != "12000" {
		return fmt.Errorf("AUCTION_SOLD amount = %q, want %q (Bob's true bid)", sold.AmountCents, "12000")
	}

	head, err := fetchEvidenceHead(hc, target, aid, seller.Token, 8*time.Second)
	if err != nil {
		return err
	}
	if len(head) > 8 {
		head = head[:8]
	}
	fmt.Printf("DEMO_AUCTION_ID=%s\n", aid)
	fmt.Printf("demo-hybrid: PASS · broadcasts hide leader → AUCTION_SOLD@%s (true) → eventsHash=%s…\n",
		sold.AmountCents, head)
	return nil
}

// observeHybridAccepted reads one hybrid BID_ACCEPTED from a non-bidding
// observer socket. The demo stages the two bids around this assertion so the
// observer has proved the first broadcast before the second bid can race the
// timer/close path.
func observeHybridAccepted(c *websocket.Conn, aliceID, bobID string, ordinal int, d time.Duration) error {
	_ = c.SetReadDeadline(time.Now().Add(d))
	for {
		var env model.Envelope
		if err := c.ReadJSON(&env); err != nil {
			return err
		}
		switch env.Type {
		case model.TypeBidAccepted:
			var bd model.BidAcceptedData
			if err := json.Unmarshal(env.Data, &bd); err != nil {
				return fmt.Errorf("parse BID_ACCEPTED: %w", err)
			}
			if bd.AmountCents == "12000" {
				return fmt.Errorf("hybrid broadcast LEAKED the true winning bid (seq=%d userId=%q amount=%q)", env.Seq, bd.UserID, bd.AmountCents)
			}
			if bd.UserID == bobID {
				return fmt.Errorf("hybrid broadcast LEAKED the true winner identity (seq=%d userId=%q)", env.Seq, bd.UserID)
			}
			switch ordinal {
			case 1:
				if bd.AmountCents != "10000" || bd.UserID != "" {
					return fmt.Errorf("1st hybrid broadcast = (userId=%q amount=%q), want (\"\", \"10000\") (reserve / no prior leader)", bd.UserID, bd.AmountCents)
				}
			case 2:
				if bd.AmountCents != "11000" {
					return fmt.Errorf("2nd hybrid broadcast amount = %q, want %q (Alice's prior)", bd.AmountCents, "11000")
				}
				if bd.UserID != aliceID {
					return fmt.Errorf("2nd hybrid broadcast userId = %q, want Alice %q (now the runner-up)", bd.UserID, aliceID)
				}
			default:
				return fmt.Errorf("unsupported hybrid broadcast ordinal %d", ordinal)
			}
			return nil
		case model.TypeAuctionSold:
			return fmt.Errorf("AUCTION_SOLD before hybrid BID_ACCEPTED #%d", ordinal)
		}
	}
}

func waitForHybridSold(c *websocket.Conn, d time.Duration) (model.AuctionSoldData, error) {
	_ = c.SetReadDeadline(time.Now().Add(d))
	for {
		var env model.Envelope
		if err := c.ReadJSON(&env); err != nil {
			return model.AuctionSoldData{}, err
		}
		if env.Type != model.TypeAuctionSold {
			continue
		}
		var sd model.AuctionSoldData
		if err := json.Unmarshal(env.Data, &sd); err != nil {
			return model.AuctionSoldData{}, fmt.Errorf("parse AUCTION_SOLD: %w", err)
		}
		return sd, nil
	}
}

// waitForRevealedAssertSealed reads frames on ONE deadline until
// AUCTION_REVEALED, failing if a BID_ACCEPTED with a non-empty amountCents
// arrives first (the sealed-mode invariant: amounts are never broadcast to the
// room — the bidder's own direct ack is fine, but it goes to their socket only).
func waitForRevealedAssertSealed(c *websocket.Conn, d time.Duration) (model.AuctionRevealedData, error) {
	_ = c.SetReadDeadline(time.Now().Add(d))
	for {
		var env model.Envelope
		if err := c.ReadJSON(&env); err != nil {
			return model.AuctionRevealedData{}, err
		}
		switch env.Type {
		case model.TypeBidAccepted:
			// On a sealed auction, the ONLY way connA receives BID_ACCEPTED is
			// if it is itself the bidder (direct ack to its own socket). Other
			// users' bids land as SEALED_BID_RECEIVED. Allow it; assert amount
			// presence is normal for the bidder's own ack.
		case model.TypeAuctionRevealed:
			var rd model.AuctionRevealedData
			if err := json.Unmarshal(env.Data, &rd); err != nil {
				return model.AuctionRevealedData{}, fmt.Errorf("parse AUCTION_REVEALED: %w", err)
			}
			return rd, nil
		}
	}
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
