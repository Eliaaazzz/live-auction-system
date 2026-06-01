package server

// T4 edge tests: the auction_events hash chain (genesis/link, idempotent
// re-projection, tamper detection), idempotent order creation on SOLD, and the
// end-to-end evidence card after a Timer hammer. These need MySQL, so they live in
// the server package (fullStore wires Redis+MySQL); the store package's newTestStore
// is Redis-only. fullStore runs no background workers, so the store-level cases are
// deterministic; only TestT4EvidenceAfterHammer drives the live worker stack.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

// TC-T4-01 — genesis prev_hash is empty, each event links to the prior one, and the
// whole chain verifies.
func TestT4HashChainGenesisLinkAndVerify(t *testing.T) {
	st := fullStore(t)
	ctx := context.Background()
	aid := fmt.Sprintf("test_t4_chain_%d", time.Now().UnixNano())
	t.Cleanup(func() {
		_, _ = st.DB().ExecContext(context.Background(), "DELETE FROM auction_events WHERE auction_id=?", aid)
	})

	if err := st.InsertEvent(ctx, aid, 1, model.TypeBidAccepted, `{"seq":1,"userId":"u1","amountCents":"11000"}`); err != nil {
		t.Fatal(err)
	}
	if err := st.InsertEvent(ctx, aid, 2, model.TypeAuctionSold, `{"seq":2,"winnerId":"u1","amountCents":"11000","status":"SOLD"}`); err != nil {
		t.Fatal(err)
	}
	tl, err := st.EventTimeline(ctx, aid)
	if err != nil || len(tl) != 2 {
		t.Fatalf("timeline len=%d err=%v want 2", len(tl), err)
	}
	if tl[0].PrevHash != "" {
		t.Fatalf("genesis prevHash=%q want empty", tl[0].PrevHash)
	}
	if tl[0].EventHash == "" || tl[1].EventHash == "" {
		t.Fatal("event hashes must be set")
	}
	if tl[1].PrevHash != tl[0].EventHash {
		t.Fatalf("chain link broken: event2.prevHash=%q want event1.eventHash=%q", tl[1].PrevHash, tl[0].EventHash)
	}
	if ok, brk, err := st.VerifyEvidenceChain(ctx, aid); err != nil || !ok || brk != 0 {
		t.Fatalf("verify: ok=%v break=%d err=%v want ok/0", ok, brk, err)
	}
}

// TC-T4-02 — re-projecting the same event is a no-op: no duplicate row, the event_hash
// is unchanged, the chain still verifies (idempotency of the worker's Stream-first sweep).
func TestT4HashChainIdempotentReprojection(t *testing.T) {
	st := fullStore(t)
	ctx := context.Background()
	aid := fmt.Sprintf("test_t4_idem_%d", time.Now().UnixNano())
	t.Cleanup(func() {
		_, _ = st.DB().ExecContext(context.Background(), "DELETE FROM auction_events WHERE auction_id=?", aid)
	})

	payload := `{"seq":1,"winnerId":"u1","amountCents":"11000","status":"SOLD"}`
	if err := st.InsertEvent(ctx, aid, 1, model.TypeAuctionSold, payload); err != nil {
		t.Fatal(err)
	}
	tl1, _ := st.EventTimeline(ctx, aid)
	if len(tl1) != 1 {
		t.Fatalf("len=%d want 1", len(tl1))
	}
	h1 := tl1[0].EventHash

	if err := st.InsertEvent(ctx, aid, 1, model.TypeAuctionSold, payload); err != nil {
		t.Fatalf("re-projection: %v", err)
	}
	if n, _ := st.CountEvents(ctx, aid); n != 1 {
		t.Fatalf("count=%d want 1 (no duplicate row)", n)
	}
	tl2, _ := st.EventTimeline(ctx, aid)
	if tl2[0].EventHash != h1 {
		t.Fatalf("event_hash changed on re-projection: %q != %q", tl2[0].EventHash, h1)
	}
	if ok, _, _ := st.VerifyEvidenceChain(ctx, aid); !ok {
		t.Fatal("chain must still verify after re-projection")
	}
}

// TC-T4-03 — a post-hoc edit of a stored payload breaks the chain at exactly that seq.
// This is the threat the chain defends against; mutation-style proof (verify passes
// before the edit, fails at the tampered seq after).
func TestT4HashChainTamperBreaksAtSeq(t *testing.T) {
	st := fullStore(t)
	ctx := context.Background()
	aid := fmt.Sprintf("test_t4_tamper_%d", time.Now().UnixNano())
	t.Cleanup(func() {
		_, _ = st.DB().ExecContext(context.Background(), "DELETE FROM auction_events WHERE auction_id=?", aid)
	})

	for seq := int64(1); seq <= 3; seq++ {
		if err := st.InsertEvent(ctx, aid, seq, model.TypeBidAccepted, fmt.Sprintf(`{"seq":%d,"amountCents":"1100%d"}`, seq, seq)); err != nil {
			t.Fatal(err)
		}
	}
	if ok, _, _ := st.VerifyEvidenceChain(ctx, aid); !ok {
		t.Fatal("precondition: chain should verify before tamper")
	}
	// Tamper the stored payload of seq 2 directly in MySQL.
	if _, err := st.DB().ExecContext(ctx,
		`UPDATE auction_events SET payload_json=? WHERE auction_id=? AND seq=2`,
		`{"seq":2,"amountCents":"999999"}`, aid); err != nil {
		t.Fatal(err)
	}
	ok, brk, err := st.VerifyEvidenceChain(ctx, aid)
	if err != nil {
		t.Fatal(err)
	}
	if ok || brk != 2 {
		t.Fatalf("after tamper: ok=%v break=%d want ok=false break_at_seq=2", ok, brk)
	}
}

// TC-T4-03a — deleting a row in the middle of the chain breaks it at the next
// surviving seq because that row's prev_hash no longer links to the running head.
func TestT4HashChainDeletionBreaksAtSeq(t *testing.T) {
	st := fullStore(t)
	ctx := context.Background()
	aid := fmt.Sprintf("test_t4_del_%d", time.Now().UnixNano())
	t.Cleanup(func() {
		_, _ = st.DB().ExecContext(context.Background(), "DELETE FROM auction_events WHERE auction_id=?", aid)
	})

	for seq := int64(1); seq <= 3; seq++ {
		if err := st.InsertEvent(ctx, aid, seq, model.TypeBidAccepted, fmt.Sprintf(`{"seq":%d}`, seq)); err != nil {
			t.Fatal(err)
		}
	}
	if ok, _, _ := st.VerifyEvidenceChain(ctx, aid); !ok {
		t.Fatal("precondition: chain should verify before deletion")
	}
	if _, err := st.DB().ExecContext(ctx, "DELETE FROM auction_events WHERE auction_id=? AND seq=2", aid); err != nil {
		t.Fatal(err)
	}
	ok, brk, err := st.VerifyEvidenceChain(ctx, aid)
	if err != nil {
		t.Fatal(err)
	}
	if ok || brk != 3 {
		t.Fatalf("after deleting seq 2: ok=%v break=%d want ok=false break_at_seq=3", ok, brk)
	}
}

// TC-T4-03b — if a later event is inserted while the previous row exists but has not
// been hash-filled yet, the writer must not treat it as a new genesis. It should
// retry after the prior row gets its hash.
func TestT4HashFillWaitsForPreviousHash(t *testing.T) {
	st := fullStore(t)
	ctx := context.Background()
	aid := fmt.Sprintf("test_t4_prevhash_%d", time.Now().UnixNano())
	t.Cleanup(func() {
		_, _ = st.DB().ExecContext(context.Background(), "DELETE FROM auction_events WHERE auction_id=?", aid)
	})

	p1 := `{"seq":1,"amountCents":"11001"}`
	p2 := `{"seq":2,"amountCents":"11002"}`
	if _, err := st.DB().ExecContext(ctx,
		`INSERT INTO auction_events (auction_id, seq, event_type, payload_json, created_at)
		 VALUES (?, 1, ?, ?, ?)`,
		aid, model.TypeBidAccepted, p1, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	err := st.InsertEvent(ctx, aid, 2, model.TypeBidAccepted, p2)
	if !errors.Is(err, store.ErrPreviousEventHashMissing) {
		t.Fatalf("insert seq2 before seq1 hash: got %v want ErrPreviousEventHashMissing", err)
	}
	if err := st.InsertEvent(ctx, aid, 1, model.TypeBidAccepted, p1); err != nil {
		t.Fatalf("fill seq1: %v", err)
	}
	if err := st.InsertEvent(ctx, aid, 2, model.TypeBidAccepted, p2); err != nil {
		t.Fatalf("retry seq2 after seq1 hash: %v", err)
	}
	if ok, brk, err := st.VerifyEvidenceChain(ctx, aid); err != nil || !ok || brk != 0 {
		t.Fatalf("verify after retry: ok=%v break=%d err=%v", ok, brk, err)
	}
}

// TC-T4-04 — the SOLD order is created exactly once: orders.UNIQUE(auction_id) means a
// re-projected AUCTION_SOLD does not create a second order (the "50-user finish" exit
// criterion at the unit level).
func TestT4OrderIdempotentOnSold(t *testing.T) {
	st := fullStore(t)
	ctx := context.Background()
	suffix := time.Now().UnixNano()
	sellerID := fmt.Sprintf("seller_t4_%d", suffix)
	prodID := fmt.Sprintf("prod_t4_%d", suffix)
	aid := fmt.Sprintf("auc_t4_%d", suffix)
	t.Cleanup(func() {
		c := context.Background()
		_, _ = st.DB().ExecContext(c, "DELETE FROM orders WHERE auction_id=?", aid)
		_, _ = st.DB().ExecContext(c, "DELETE FROM auction_rules WHERE auction_id=?", aid)
		_, _ = st.DB().ExecContext(c, "DELETE FROM auctions WHERE id=?", aid)
		_, _ = st.DB().ExecContext(c, "DELETE FROM products WHERE id=?", prodID)
	})

	if err := st.CreateProduct(ctx, prodID, sellerID, "T4 Item", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := st.CreateAuction(ctx, aid, prodID, sellerID, persistRules(), true, ""); err != nil {
		t.Fatal(err)
	}
	sold := `{"seq":2,"winnerId":"buyer_t4","amountCents":"11000","status":"SOLD"}`
	if err := st.CreateOrderFromSold(ctx, aid, sold); err != nil {
		t.Fatal(err)
	}
	o, err := st.GetOrder(ctx, aid)
	if err != nil {
		t.Fatalf("get order: %v", err)
	}
	if o.BuyerID != "buyer_t4" || o.AmountCents != 11000 || o.ProductID != prodID {
		t.Fatalf("order=%+v want buyer_t4 / 11000 / %s", o, prodID)
	}
	// Re-project the same SOLD event → still exactly one order.
	if err := st.CreateOrderFromSold(ctx, aid, sold); err != nil {
		t.Fatalf("re-projection: %v", err)
	}
	var cnt int
	if err := st.DB().QueryRowContext(ctx, "SELECT COUNT(*) FROM orders WHERE auction_id=?", aid).Scan(&cnt); err != nil {
		t.Fatal(err)
	}
	if cnt != 1 {
		t.Fatalf("orders count=%d want 1 (UNIQUE(auction_id) idempotent)", cnt)
	}
	conflict := `{"seq":2,"winnerId":"other_buyer","amountCents":"11001","status":"SOLD"}`
	err = st.CreateOrderFromSold(ctx, aid, conflict)
	if !errors.Is(err, store.ErrOrderProjectionMismatch) {
		t.Fatalf("conflicting order re-projection: got %v want ErrOrderProjectionMismatch", err)
	}
}

func TestT4ProjectSoldPromotesOrderCreated(t *testing.T) {
	st := fullStore(t)
	ctx := context.Background()
	suffix := time.Now().UnixNano()
	sellerID := fmt.Sprintf("seller_t4_state_%d", suffix)
	prodID := fmt.Sprintf("prod_t4_state_%d", suffix)
	aid := fmt.Sprintf("auc_t4_state_%d", suffix)
	t.Cleanup(func() {
		c := context.Background()
		_, _ = st.DB().ExecContext(c, "DELETE FROM orders WHERE auction_id=?", aid)
		_, _ = st.DB().ExecContext(c, "DELETE FROM auction_rules WHERE auction_id=?", aid)
		_, _ = st.DB().ExecContext(c, "DELETE FROM auctions WHERE id=?", aid)
		_, _ = st.DB().ExecContext(c, "DELETE FROM products WHERE id=?", prodID)
	})
	if err := st.CreateProduct(ctx, prodID, sellerID, "T4 Item", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := st.CreateAuction(ctx, aid, prodID, sellerID, persistRules(), true, ""); err != nil {
		t.Fatal(err)
	}
	e := store.StreamEvent{Seq: 2, Type: model.TypeAuctionSold, Payload: `{"seq":2,"winnerId":"buyer_t4","amountCents":"11000","status":"SOLD"}`}
	if err := projectSold(ctx, st, aid, e); err != nil {
		t.Fatal(err)
	}
	a, err := st.GetAuction(ctx, aid)
	if err != nil {
		t.Fatal(err)
	}
	if a.Status != model.StateOrderCreated {
		t.Fatalf("status=%s want ORDER_CREATED after idempotent order creation", a.Status)
	}
}

func TestT4ProjectSoldMissingAuctionIsPermanent(t *testing.T) {
	st := fullStore(t)
	ctx := context.Background()
	aid := fmt.Sprintf("auc_t4_missing_%d", time.Now().UnixNano())
	e := store.StreamEvent{Seq: 2, Type: model.TypeAuctionSold, Payload: `{"seq":2,"winnerId":"buyer_t4","amountCents":"11000","status":"SOLD"}`}

	err := projectSold(ctx, st, aid, e)
	if !errors.Is(err, store.ErrPermanentOrderProjection) {
		t.Fatalf("missing auction SOLD event: got %v want ErrPermanentOrderProjection", err)
	}
}

// TC-T4-05 (e2e) — after the Timer hammers a live auction, the evidence card shows a
// recompute-verified hash chain, a non-empty chain head, and the buyer order. Ties the
// persistence projection + hash chain + order together through the running worker stack.
func TestT4EvidenceAfterHammer(t *testing.T) {
	target, _ := startTestServer(t)
	hc := &http.Client{Timeout: 5 * time.Second}
	seller, err := devLogin(hc, target, "T4 E2E Seller", "seller")
	if err != nil {
		t.Fatal(err)
	}
	productID, err := createProduct(hc, target, seller.Token)
	if err != nil {
		t.Fatal(err)
	}
	// No anti-snipe (extendWindowSec=0) so the bid can't push endAtMs past the window.
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
	if err := postExpectCode(hc, target+"/api/auctions/"+aid+"/start", seller.Token, map[string]int64{"durationMs": 1500}, model.CodeOKLive); err != nil {
		t.Fatal(err)
	}
	buyer, err := devLogin(hc, target, "T4 E2E Buyer", "user")
	if err != nil {
		t.Fatal(err)
	}
	c, err := dialAndJoin(target, buyer.Token, aid)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	bid, _ := model.NewEnvelope(model.TypeBidPlace, aid, 0, model.BidPlaceData{ClientBidID: "cbT4", AmountCents: "11000"})
	if err := c.WriteJSON(bid); err != nil {
		t.Fatal(err)
	}
	if err := waitForType(c, model.TypeBidAccepted, 5*time.Second); err != nil {
		t.Fatalf("bid not accepted: %v", err)
	}
	if err := waitForType(c, model.TypeAuctionSold, 5*time.Second); err != nil {
		t.Fatalf("timer did not hammer SOLD: %v", err)
	}

	// The persistence sweep (hash chain + order) is async; poll the evidence card.
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		var ev struct {
			ChainVerified bool   `json:"chainVerified"`
			EventsHash    string `json:"eventsHash"`
			Status        string `json:"status"`
			Order         *struct {
				BuyerID     string `json:"buyerId"`
				AmountCents string `json:"amountCents"`
			} `json:"order"`
		}
		if err := getJSONAuth(hc, target+"/api/auctions/"+aid+"/evidence", buyer.Token, &ev); err == nil {
			if ev.Order != nil && ev.ChainVerified && ev.EventsHash != "" {
				if ev.Status != model.StateOrderCreated {
					t.Fatalf("status=%s want ORDER_CREATED once order exists", ev.Status)
				}
				if ev.Order.BuyerID != buyer.UserID || ev.Order.AmountCents != "11000" {
					t.Fatalf("order=%+v want buyer=%s amount=11000", ev.Order, buyer.UserID)
				}
				return // verified chain + correct order
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("evidence card did not show a verified hash chain + order within 8s")
}

func TestT4EvidenceRequiresAuth(t *testing.T) {
	target, _ := startTestServer(t)
	hc := &http.Client{Timeout: 5 * time.Second}
	seller, err := devLogin(hc, target, "T4 Evidence Auth Seller", "seller")
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
	if err := postJSON(hc, target+"/api/auctions", seller.Token, map[string]any{
		"productId":      productID,
		"rules":          persistRules(),
		"factsConfirmed": true,
	}, &created); err != nil {
		t.Fatal(err)
	}

	resp, err := hc.Get(target + "/api/auctions/" + created.AuctionID + "/evidence")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauth evidence status=%d want 401", resp.StatusCode)
	}
	var ev struct {
		AuctionID string `json:"auctionId"`
	}
	if err := getJSONAuth(hc, target+"/api/auctions/"+created.AuctionID+"/evidence", seller.Token, &ev); err != nil {
		t.Fatalf("authenticated evidence: %v", err)
	}
}

func TestT4EvidenceEndpointSchemaMatchesProto(t *testing.T) {
	target, _ := startTestServer(t)
	hc := &http.Client{Timeout: 5 * time.Second}
	seller, err := devLogin(hc, target, "T4 Evidence Schema Seller", "seller")
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
	if err := postJSON(hc, target+"/api/auctions", seller.Token, map[string]any{
		"productId":      productID,
		"rules":          persistRules(),
		"factsConfirmed": true,
	}, &created); err != nil {
		t.Fatal(err)
	}

	var raw map[string]any
	if err := getJSONAuth(hc, target+"/api/auctions/"+created.AuctionID+"/evidence", seller.Token, &raw); err != nil {
		t.Fatalf("evidence schema response: %v", err)
	}

	wantKeys := map[string]bool{
		"auctionId":         true,
		"status":            true,
		"currentPriceCents": true,
		"winnerId":          true,
		"seq":               true,
		"eventsCount":       true,
		"factsConfirmed":    true,
		"timeline":          true,
		"eventsHash":        true,
		"chainVerified":     true,
		"note":              true,
	}
	for k := range wantKeys {
		if _, ok := raw[k]; !ok {
			t.Fatalf("evidence schema missing key %q", k)
		}
	}
	for k := range raw {
		if !wantKeys[k] {
			t.Fatalf("evidence schema unexpected key %q", k)
		}
	}

	assertString := func(k string) {
		if _, ok := raw[k].(string); !ok {
			t.Fatalf("evidence schema key %q type=%T want string", k, raw[k])
		}
	}
	assertNumber := func(k string) {
		if _, ok := raw[k].(float64); !ok {
			t.Fatalf("evidence schema key %q type=%T want number", k, raw[k])
		}
	}
	assertBool := func(k string) {
		if _, ok := raw[k].(bool); !ok {
			t.Fatalf("evidence schema key %q type=%T want bool", k, raw[k])
		}
	}
	assertArray := func(k string) []any {
		v, ok := raw[k].([]any)
		if !ok {
			t.Fatalf("evidence schema key %q type=%T want array", k, raw[k])
		}
		return v
	}

	assertString("auctionId")
	assertString("status")
	assertString("currentPriceCents")
	assertString("winnerId")
	assertNumber("seq")
	assertNumber("eventsCount")
	assertBool("factsConfirmed")
	timeline := assertArray("timeline")
	assertString("eventsHash")
	assertBool("chainVerified")
	assertString("note")

	if raw["auctionId"] != created.AuctionID {
		t.Fatalf("auctionId=%v want %s", raw["auctionId"], created.AuctionID)
	}
	if raw["factsConfirmed"] != true {
		t.Fatalf("factsConfirmed=%v want true", raw["factsConfirmed"])
	}
	if raw["eventsCount"] != float64(0) {
		t.Fatalf("eventsCount=%v want 0 for empty chain", raw["eventsCount"])
	}
	if len(timeline) != 0 {
		t.Fatalf("timeline len=%d want 0 for empty chain", len(timeline))
	}
	if raw["eventsHash"] != "" {
		t.Fatalf("eventsHash=%v want empty string for empty chain", raw["eventsHash"])
	}
	if raw["chainVerified"] != true {
		t.Fatalf("chainVerified=%v want true for empty chain", raw["chainVerified"])
	}
}
