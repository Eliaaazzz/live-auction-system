package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

// RunPerfSmoke is the T2/T3 perf *floor-check* (V9 §4.2): it drives a light,
// pipelined bid stream against a running stack and asserts ack/broadcast p95
// against the *fallback* thresholds (ack < 200 ms, broadcast < 500 ms). It runs
// on a single gateway / dev docker-compose with no fixed box spec, so green here
// only rules out structural perf regressions — it does NOT de-risk the 500/50
// SLO gate (that is T8 tune-to-target). Returns an error (exit != 0) on breach.
//
// Tunables: TARGET, PERF_BIDS, PERF_ACK_P95_MS, PERF_BCAST_P95_MS.
func RunPerfSmoke(target string) error {
	n := envInt("PERF_BIDS", 200)
	ackP95Budget := time.Duration(envInt("PERF_ACK_P95_MS", 200)) * time.Millisecond
	bcastP95Budget := time.Duration(envInt("PERF_BCAST_P95_MS", 500)) * time.Millisecond

	hc := &http.Client{Timeout: 5 * time.Second}
	aid, err := perfSetupAuction(hc, target)
	if err != nil {
		return fmt.Errorf("perf setup: %w", err)
	}

	buyer, err := devLogin(hc, target, "Perf Buyer", "user")
	if err != nil {
		return fmt.Errorf("buyer dev-login: %w", err)
	}
	observer, err := dialAndJoin(target, buyer.Token, aid)
	if err != nil {
		return fmt.Errorf("observer connect: %w", err)
	}
	defer observer.Close()
	bidder, err := dialAndJoin(target, buyer.Token, aid)
	if err != nil {
		return fmt.Errorf("bidder connect: %w", err)
	}
	defer bidder.Close()

	const startPrice = 10000 // perf auction: increment=1, so amount = 10000+i+1
	sendAt := make(map[string]time.Time, n)
	var mu sync.Mutex

	// Observer goroutine: record broadcast latency per amount (matched by the
	// unique amountCents). Stops after n broadcasts or its read deadline. `bcast`
	// is shared with the main goroutine, so every access is under mu.
	bcast := make([]time.Duration, 0, n)
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = observer.SetReadDeadline(time.Now().Add(15 * time.Second))
		for {
			mu.Lock()
			full := len(bcast) >= n
			mu.Unlock()
			if full {
				return
			}
			var env model.Envelope
			if err := observer.ReadJSON(&env); err != nil {
				return
			}
			if env.Type != model.TypeBidAccepted {
				continue
			}
			amt := bidAmount(env)
			mu.Lock()
			if t0, ok := sendAt[amt]; ok {
				bcast = append(bcast, time.Since(t0))
			}
			mu.Unlock()
		}
	}()

	// Bidder: serial round-trips (one bid in flight) so the direct-ack path is
	// never dropped by backpressure. Each amount is unique and strictly
	// increasing by the increment (=1), so every bid is accepted.
	ack := make([]time.Duration, 0, n)
	for i := 0; i < n; i++ {
		amt := strconv.Itoa(startPrice + i + 1)
		env, _ := model.NewEnvelope(model.TypeBidPlace, aid, 0, model.BidPlaceData{
			ClientBidID: fmt.Sprintf("perf_%d_%d", time.Now().UnixNano(), i),
			AmountCents: amt,
		})
		mu.Lock()
		sendAt[amt] = time.Now()
		mu.Unlock()
		t0 := time.Now()
		if err := bidder.WriteJSON(env); err != nil {
			return fmt.Errorf("send bid %d: %w", i, err)
		}
		if err := waitForBidAccepted(bidder, amt, 5*time.Second); err != nil {
			return fmt.Errorf("ack for bid %d (%s): %w", i, amt, err)
		}
		ack = append(ack, time.Since(t0))
	}

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		// fall through with whatever broadcasts arrived
	}
	mu.Lock()
	bcastCopy := append([]time.Duration(nil), bcast...)
	mu.Unlock()

	ackP50, ackP95, ackP99 := percentiles(ack)
	bP50, bP95, bP99 := percentiles(bcastCopy)
	fmt.Printf("perf-smoke: bids=%d acks=%d broadcasts=%d\n", n, len(ack), len(bcastCopy))
	fmt.Printf("  ack       p50=%v p95=%v p99=%v (budget p95<%v)\n", ackP50, ackP95, ackP99, ackP95Budget)
	fmt.Printf("  broadcast p50=%v p95=%v p99=%v (budget p95<%v)\n", bP50, bP95, bP99, bcastP95Budget)

	var fail string
	if len(ack) < n {
		fail += fmt.Sprintf(" only %d/%d acks received;", len(ack), n)
	}
	if ackP95 > ackP95Budget {
		fail += fmt.Sprintf(" ack p95 %v > %v;", ackP95, ackP95Budget)
	}
	if len(bcastCopy) < n {
		fail += fmt.Sprintf(" only %d/%d broadcasts received;", len(bcastCopy), n)
	}
	if bP95 > bcastP95Budget {
		fail += fmt.Sprintf(" broadcast p95 %v > %v;", bP95, bcastP95Budget)
	}
	if fail != "" {
		return fmt.Errorf("perf-smoke FAIL:%s", fail)
	}
	fmt.Println("perf-smoke: PASS")
	return nil
}

// perfSetupAuction creates a fresh auction tuned for the smoke run: increment=1
// (so a strictly-increasing amount stream is all accepted), no cap, no anti-snipe
// window, long duration. Returns the auction id (LIVE).
func perfSetupAuction(hc *http.Client, target string) (string, error) {
	seller, err := devLogin(hc, target, "Perf Seller", "seller")
	if err != nil {
		return "", fmt.Errorf("seller dev-login: %w", err)
	}
	productID, err := createProduct(hc, target, seller.Token)
	if err != nil {
		return "", fmt.Errorf("create product: %w", err)
	}
	var out struct {
		AuctionID string `json:"auctionId"`
	}
	body := map[string]any{
		"productId": productID,
		"rules": model.Rules{
			StartPriceCents: 10000, IncrementCents: 1, CapPriceCents: 0,
			DurationSec: 3600, ExtendWindowSec: 0, ExtendSec: 0,
		},
		"factsConfirmed": true,
	}
	if err := postJSON(hc, target+"/api/auctions", seller.Token, body, &out); err != nil {
		return "", fmt.Errorf("create auction: %w", err)
	}
	aid := out.AuctionID
	if err := postExpectCode(hc, target+"/api/auctions/"+aid+"/freeze", seller.Token, nil, model.CodeOKFrozen); err != nil {
		return "", fmt.Errorf("freeze: %w", err)
	}
	if err := postExpectCode(hc, target+"/api/auctions/"+aid+"/start", seller.Token, map[string]int64{"durationMs": 3600_000}, model.CodeOKLive); err != nil {
		return "", fmt.Errorf("start: %w", err)
	}
	return aid, nil
}

// waitForBidAccepted reads until a BID_ACCEPTED for the given amount arrives
// (skipping the duplicate broadcast copy of earlier bids).
func waitForBidAccepted(c *websocket.Conn, amount string, d time.Duration) error {
	_ = c.SetReadDeadline(time.Now().Add(d))
	for {
		var env model.Envelope
		if err := c.ReadJSON(&env); err != nil {
			return err
		}
		if env.Type == model.TypeBidAccepted && bidAmount(env) == amount {
			return nil
		}
	}
}

func bidAmount(env model.Envelope) string {
	var d model.BidAcceptedData
	_ = json.Unmarshal(env.Data, &d)
	return d.AmountCents
}

// percentiles returns p50/p95/p99 of a duration sample (nearest-rank). Empty
// input yields zeros.
func percentiles(xs []time.Duration) (p50, p95, p99 time.Duration) {
	if len(xs) == 0 {
		return 0, 0, 0
	}
	s := append([]time.Duration(nil), xs...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	return s[rank(len(s), 50)], s[rank(len(s), 95)], s[rank(len(s), 99)]
}

// rank maps a percentile to a 0-based index (nearest-rank, clamped).
func rank(n, p int) int {
	idx := (p*n + 99) / 100 // ceil(p/100 * n)
	if idx < 1 {
		idx = 1
	}
	if idx > n {
		idx = n
	}
	return idx - 1
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}
