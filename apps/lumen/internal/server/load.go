package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/metrics"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

// RunLoad is the T8 acceptance harness (V9 plan §10): the P0 gate is
//
//	500 connected + 50 active, 60 seconds, ack p95 < 80 ms, broadcast p95 < 150 ms.
//
// The harness drives TARGET (a fully-deployed lumen + redis + mysql + ai-sidecar
// stack), creates one fresh auction tuned to never reject (increment=1, no cap,
// no anti-snipe window, long duration), then opens N observer connections and
// K active bidders to it. Observers join+listen for broadcasts; bidders run a
// loose-pipelined bid loop with one inflight bid each, each amount strictly
// increasing so every bid is accepted (we are measuring latency, not adjudication).
// The harness scrapes the /metrics snapshot at the end and asserts the SLO
// against the §4.2 P0-gate budgets (configurable via env so a small CI run can
// exercise the same code path with lower thresholds).
//
// The auction id is printed to stdout as `LOAD_AUCTION_ID=...` so a downstream
// `make verify VERIFY_AID=$(...)` step can do the §4.1 "Verifier consistent on
// post-load auction" gate (V9 §9 says this is required, not just demo-friendly).
//
// Tunables (defaults track V9 §4.2 P0 gate):
//
//	LOAD_OBSERVERS         = 500    (connected, lossy)
//	LOAD_BIDDERS           =  50    (active)
//	LOAD_DURATION_SEC      =  60
//	LOAD_BID_INTERVAL_MS   = 100    (per bidder; 50 × 10/s = 500 bid/s aggregate)
//	LOAD_ACK_P95_MS        =  80
//	LOAD_BROADCAST_P95_MS  = 150
//	LOAD_HAMMER_P95_MS     = 500    (only asserted if the auction hammered inside the window)
//	LOAD_CATCHUP_P95_MS    = 1000   (only asserted if catchup stream replay was observed)
//	LOAD_SCRIPT_P99_MS     =   5    (hot-path Lua exec budget, V9 §4.2 footnote)
//	LOAD_HANDLER_P99_MS    =   5    (P8: BID_PLACE Go-side handler work, excl. Redis RTT)
//	LOAD_AUCTION_DUR_SEC   = 3600   (the auction stays LIVE past the load window; no hammer)
//	LOAD_AUCTION_ID        = ""     (optional: reuse an existing LIVE auction for sharded runs)
//	LOAD_START_CENTS       = 100000 (first attempted bid amount base; shard planners may raise it)
//	LOAD_BIDS_PER_BIDDER   = 0      (0 = unlimited until duration; 1 = each bidder bids once)
//	LOAD_RETRY_TOO_LOW     = false  (retry ERR_TOO_LOW with a new higher amount until accepted)
//	LOAD_BID_MAX_ATTEMPTS  = 25     (per logical bid when LOAD_RETRY_TOO_LOW=true)
//
// Exit conventions: error (exit != 0) on any SLO breach, on any setup failure,
// and on seq gap > 0. The error message lists every breach so CI fails LOUD.
func RunLoad(target string) error {
	cfg := loadConfigFromEnv()
	hc := &http.Client{Timeout: 10 * time.Second}

	aid := cfg.AuctionID
	if aid == "" {
		var err error
		aid, err = loadSetupAuction(hc, target, cfg)
		if err != nil {
			return fmt.Errorf("load setup: %w", err)
		}
	} else {
		fmt.Printf("load setup: reusing existing auction %s (LOAD_AUCTION_ID)\n", aid)
	}
	fmt.Printf("LOAD_AUCTION_ID=%s\n", aid) // captured by `make load` for the downstream verifier
	fmt.Printf("load config: observers=%d bidders=%d duration=%v bidInterval=%v startCents=%d retryTooLow=%t maxAttempts=%d\n",
		cfg.Observers, cfg.Bidders, cfg.Duration, cfg.BidInterval, cfg.StartAmountCents, cfg.RetryTooLow, cfg.BidMaxAttempts)

	// Reset the /metrics percentiles for this run by reading the pre-run snapshot
	// — the percentiles continue to accumulate, but we'll diff counters and
	// re-Snapshot at end. (Reservoir sampling makes the histograms statistically
	// dominated by the load run as long as the cap << observation count, which
	// is the design point. Snapshot at end is the source of truth for SLO.)
	prerun, err := scrapeMetrics(hc, target)
	if err != nil {
		return fmt.Errorf("scrape pre-run /metrics: %w", err)
	}

	// Cancel ties every harness goroutine to a single lifetime (no leaks on
	// early return / SLO failure / first connect error).
	ctx, cancel := context.WithTimeout(context.Background(), cfg.Duration+30*time.Second)
	defer cancel()

	// Observers all share one buyer token (they don't bid, so a single identity
	// doesn't bias leaderboard / dedupe metrics — it just means N connections
	// are 1 user, which is the realistic spectator case).
	observerBuyer, err := devLogin(hc, target, "Load Observer", "user")
	if err != nil {
		return fmt.Errorf("observer dev-login: %w", err)
	}

	stats := &loadStats{}
	// Stagger observer dials so the gateway doesn't see a thundering herd of 500
	// upgrades in one millisecond — this would inflate ack-p95 with handshake
	// queue depth, an artifact of the harness rather than the system. We still
	// finish all 500 inside ~5 s at the default 10 ms spacing.
	observerWG := sync.WaitGroup{}
	observerWG.Add(cfg.Observers)
	for i := 0; i < cfg.Observers; i++ {
		go runObserver(ctx, target, observerBuyer.Token, aid, stats, &observerWG)
		time.Sleep(time.Duration(cfg.ObserverStaggerMs) * time.Millisecond)
	}
	// Bidders: each gets its OWN dev-login so the leaderboard ZADD has N
	// distinct members (realistic concurrent-user signal) and the per-user
	// dedupe Hash stays bounded (one bidder ≈ one entry per bid; not 50
	// bidders sharing a single 30k-field hash). Login is cheap (HTTP + JWT) and
	// happens once per bidder before the load window starts.
	var amountCounter atomic.Int64 // bid amount = loadStartCents + amountCounter++
	amountCounter.Store(cfg.StartAmountCents)
	bidderTokens := make([]string, cfg.Bidders)
	for i := 0; i < cfg.Bidders; i++ {
		s, err := devLogin(hc, target, fmt.Sprintf("Load Bidder %d", i), "user")
		if err != nil {
			return fmt.Errorf("bidder %d dev-login: %w", i, err)
		}
		bidderTokens[i] = s.Token
	}
	bidderWG := sync.WaitGroup{}
	bidderWG.Add(cfg.Bidders)
	loadStart := time.Now()
	for i := 0; i < cfg.Bidders; i++ {
		go runBidder(ctx, target, bidderTokens[i], aid, i, cfg, stats, &amountCounter, &bidderWG)
	}

	// Hold the load for the configured duration; observers and bidders both
	// honour ctx so cancel() at the end stops everyone. Select on ctx so an
	// external signal (SIGTERM, test cancellation) breaks the wait early
	// instead of stalling for up to LOAD_DURATION_SEC after a shutdown signal.
	select {
	case <-ctx.Done():
	case <-time.After(cfg.Duration):
	}
	cancel()
	bidderWG.Wait()
	observerWG.Wait()
	elapsed := time.Since(loadStart)

	postrun, err := scrapeMetrics(hc, target)
	if err != nil {
		return fmt.Errorf("scrape post-run /metrics: %w", err)
	}

	// Report — paste-friendly for docs/perf-report.md and for CI log scraping.
	rep := loadReport{
		AID:           aid,
		Config:        cfg,
		Elapsed:       elapsed,
		Pre:           prerun,
		Post:          postrun,
		ObserverStats: stats.observerSnapshot(),
		BidderStats:   stats.bidderSnapshot(),
	}
	rep.print()

	if breaches := rep.breaches(); len(breaches) > 0 {
		return fmt.Errorf("load FAIL: %s", strings.Join(breaches, "; "))
	}
	fmt.Println("load: PASS")
	return nil
}

const loadStartCents = 100_000 // start price; per-bid amount is loadStartCents + amountCounter++

type loadConfig struct {
	Observers          int
	Bidders            int
	Duration           time.Duration
	BidInterval        time.Duration
	AckP95Budget       time.Duration
	BroadcastP95Budget time.Duration
	CatchupP95Budget   time.Duration
	HammerP95Budget    time.Duration
	ScriptP99Budget    time.Duration
	HandlerP99Budget   time.Duration
	AuctionDuration    time.Duration
	ObserverStaggerMs  int
	AuctionID          string
	StartAmountCents   int64
	BidsPerBidder      int
	RetryTooLow        bool
	BidMaxAttempts     int
}

func loadConfigFromEnv() loadConfig {
	return loadConfig{
		Observers:          envIntAllowZero("LOAD_OBSERVERS", 500),
		Bidders:            envInt("LOAD_BIDDERS", 50),
		Duration:           time.Duration(envInt("LOAD_DURATION_SEC", 60)) * time.Second,
		BidInterval:        time.Duration(envInt("LOAD_BID_INTERVAL_MS", 100)) * time.Millisecond,
		AckP95Budget:       time.Duration(envInt("LOAD_ACK_P95_MS", 80)) * time.Millisecond,
		BroadcastP95Budget: time.Duration(envInt("LOAD_BROADCAST_P95_MS", 150)) * time.Millisecond,
		CatchupP95Budget:   time.Duration(envInt("LOAD_CATCHUP_P95_MS", 1000)) * time.Millisecond,
		HammerP95Budget:    time.Duration(envInt("LOAD_HAMMER_P95_MS", 500)) * time.Millisecond,
		ScriptP99Budget:    time.Duration(envInt("LOAD_SCRIPT_P99_MS", 5)) * time.Millisecond,
		HandlerP99Budget:   time.Duration(envInt("LOAD_HANDLER_P99_MS", 5)) * time.Millisecond,
		AuctionDuration:    time.Duration(envInt("LOAD_AUCTION_DUR_SEC", 3600)) * time.Second,
		ObserverStaggerMs:  envInt("LOAD_OBSERVER_STAGGER_MS", 10),
		AuctionID:          strings.TrimSpace(os.Getenv("LOAD_AUCTION_ID")),
		StartAmountCents:   int64(envInt("LOAD_START_CENTS", loadStartCents)),
		BidsPerBidder:      envInt("LOAD_BIDS_PER_BIDDER", 0),
		RetryTooLow:        envBool("LOAD_RETRY_TOO_LOW", false),
		BidMaxAttempts:     envInt("LOAD_BID_MAX_ATTEMPTS", 25),
	}
}

// loadSetupAuction creates a fresh auction tuned so every well-formed bid is
// accepted: increment=1 (strictly-increasing amount stream), cap=0 (no buy-now
// ceiling), no anti-snipe window/extension, long duration (auction stays LIVE
// past the load window). Mirrors perfSetupAuction but with parameterised
// duration so the harness can also do a "short-duration → hammer mid-load" run
// for hammer p95 measurement.
func loadSetupAuction(hc *http.Client, target string, cfg loadConfig) (string, error) {
	seller, err := devLogin(hc, target, "Load Seller", "seller")
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
			StartPriceCents: loadStartCents,
			IncrementCents:  1,
			CapPriceCents:   0,
			DurationSec:     int64(cfg.AuctionDuration / time.Second),
			ExtendWindowSec: 0,
			ExtendSec:       0,
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
	if err := postExpectCode(hc, target+"/api/auctions/"+aid+"/start", seller.Token,
		map[string]int64{"durationMs": int64(cfg.AuctionDuration / time.Millisecond)},
		model.CodeOKLive); err != nil {
		return "", fmt.Errorf("start: %w", err)
	}
	return aid, nil
}

// loadStats holds per-run counters. Lock-free; observer/bidder workers update
// via atomic add and the main goroutine reads at end via the same atomics.
type loadStats struct {
	bidsSent      atomic.Int64
	bidsAcked     atomic.Int64
	bidsRejected  atomic.Int64
	bidErrors     atomic.Int64
	observerFrame atomic.Int64 // broadcasts observed across all observers
	observerErr   atomic.Int64
	dialErr       atomic.Int64
}

type observerSnapshot struct {
	Frames   int64 `json:"observerFramesReceived"`
	Errors   int64 `json:"observerReadErrors"`
	DialErrs int64 `json:"observerDialErrors"`
}

type bidderSnapshot struct {
	Sent     int64 `json:"bidsSent"`
	Acked    int64 `json:"bidsAcked"`
	Rejected int64 `json:"bidsRejected"`
	Errors   int64 `json:"bidsErrors"`
}

func (s *loadStats) observerSnapshot() observerSnapshot {
	return observerSnapshot{
		Frames: s.observerFrame.Load(), Errors: s.observerErr.Load(), DialErrs: s.dialErr.Load(),
	}
}

func (s *loadStats) bidderSnapshot() bidderSnapshot {
	return bidderSnapshot{
		Sent: s.bidsSent.Load(), Acked: s.bidsAcked.Load(),
		Rejected: s.bidsRejected.Load(), Errors: s.bidErrors.Load(),
	}
}

// runObserver opens one WS connection, joins the room, and reads broadcasts
// until ctx is done. It does NOT bid — it is the "500 connected" half of the
// SLO. Reads are counted so the report can tie observer throughput to
// broadcastLatency p95.
func runObserver(ctx context.Context, target, token, aid string, stats *loadStats, wg *sync.WaitGroup) {
	defer wg.Done()
	defer func() {
		// Defense-in-depth. With the read-deadline poll removed (below) the
		// "repeated read on failed websocket connection" panic source is gone,
		// so this should never fire. If it ever does it is a real regression:
		// counting it FAILS the gate (readErrors>0) rather than letting an
		// unrecovered panic crash the whole 500-goroutine run.
		if recover() != nil {
			stats.observerErr.Add(1)
		}
	}()
	c, err := dialAndJoin(target, token, aid)
	if err != nil {
		stats.dialErr.Add(1)
		return
	}
	defer c.Close()

	// Cooperative cancel WITHOUT a per-read deadline. A gorilla read-deadline
	// timeout permanently poisons the conn (it sets c.readErr), so the old
	// SetReadDeadline(500ms)+continue-on-timeout loop spun ~1000 dead reads
	// after the first quiet window until gorilla panicked with "repeated read
	// on failed websocket connection"; #89's recover() then booked every panic
	// as a readError, so the gate's readErrors==0 could never pass (#86).
	// Instead, close the conn when ctx ends — that unblocks the blocking
	// ReadMessage with a benign net.ErrClosed and the loop returns clean.
	go func() {
		<-ctx.Done()
		_ = c.Close()
	}()

	for {
		_, _, err := c.ReadMessage()
		if err != nil {
			// Run over (we closed the conn on ctx.Done) or a normal end-of-run
			// WS teardown → clean exit, not a lost frame. Anything else is a
			// genuine mid-room read failure that counts toward the SLO gate.
			if ctx.Err() != nil || isBenignClose(err) {
				return
			}
			stats.observerErr.Add(1)
			return
		}
		stats.observerFrame.Add(1)
	}
}

// runBidder opens one WS connection and sends BID_PLACE on a paced ticker, one
// in flight at a time. Each amount is loadStartCents + ++amountCounter, so
// concurrent bidders never intentionally collide on amount; each clientBidId
// encodes the bidder index + a monotonic local counter so retries remain unique.
//
// With many simultaneous one-shot bidders, network scheduling can deliver a
// higher amount first, advancing currentPrice and making lower in-flight amounts
// legitimately ERR_TOO_LOW. LOAD_RETRY_TOO_LOW keeps the auction rule intact and
// makes the harness model "each connected user eventually places one accepted
// bid" by retrying with the next global higher amount.
//
// Resilience: a write-error tears the conn down and exits (the socket is
// unusable); an ack timeout is logged via bidErrors but the loop continues so
// one transient blip doesn't permanently take a bidder out of the active
// population (which would lower observed aggregate bid rate and skew the SLO
// math towards optimism).
func runBidder(ctx context.Context, target, token, aid string, idx int, cfg loadConfig,
	stats *loadStats, amountCounter *atomic.Int64, wg *sync.WaitGroup) {
	defer wg.Done()
	c, err := dialAndJoin(target, token, aid)
	if err != nil {
		stats.dialErr.Add(1)
		return
	}
	defer c.Close()

	ticker := time.NewTicker(cfg.BidInterval)
	defer ticker.Stop()
	attemptLocal := 0
	acceptedLocal := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if cfg.BidsPerBidder > 0 && acceptedLocal >= cfg.BidsPerBidder {
				return
			}
			accepted, keepAlive := placeLoadBid(c, aid, idx, cfg, stats, amountCounter, &attemptLocal)
			if !keepAlive {
				return
			}
			if accepted {
				acceptedLocal++
			}
			if cfg.BidsPerBidder > 0 && acceptedLocal >= cfg.BidsPerBidder {
				return
			}
		}
	}
}

type bidOutcome struct {
	Accepted bool
	Code     string
	Err      error
}

func placeLoadBid(c *websocket.Conn, aid string, idx int, cfg loadConfig, stats *loadStats,
	amountCounter *atomic.Int64, attemptLocal *int) (accepted bool, keepAlive bool) {
	maxAttempts := 1
	if cfg.RetryTooLow {
		maxAttempts = cfg.BidMaxAttempts
	}
	for attempt := 0; attempt < maxAttempts; attempt++ {
		amt := amountCounter.Add(1)
		*attemptLocal++
		amount := strconv.FormatInt(amt, 10)
		env, _ := model.NewEnvelope(model.TypeBidPlace, aid, 0, model.BidPlaceData{
			ClientBidID: fmt.Sprintf("load_%d_%d", idx, *attemptLocal),
			AmountCents: amount,
		})
		_ = c.SetWriteDeadline(time.Now().Add(2 * time.Second))
		if err := c.WriteJSON(env); err != nil {
			stats.bidErrors.Add(1)
			return false, false
		}
		stats.bidsSent.Add(1)
		_ = c.SetReadDeadline(time.Time{})

		out := waitForBidOutcome(c, amount, 2*time.Second)
		if out.Err != nil {
			stats.bidErrors.Add(1)
			return false, true
		}
		if out.Accepted {
			stats.bidsAcked.Add(1)
			return true, true
		}
		stats.bidsRejected.Add(1)
		if !cfg.RetryTooLow || out.Code != model.CodeErrTooLow {
			stats.bidErrors.Add(1)
			return false, true
		}
	}
	stats.bidErrors.Add(1)
	return false, true
}

// waitForBidOutcome reads until the direct outcome for the one in-flight bid
// arrives. BID_ACCEPTED is matched by amount because the socket also receives
// room broadcasts for other bidders; BID_REJECTED is direct-only from ws.go.
func waitForBidOutcome(c *websocket.Conn, amount string, d time.Duration) bidOutcome {
	_ = c.SetReadDeadline(time.Now().Add(d))
	for {
		var env model.Envelope
		if err := c.ReadJSON(&env); err != nil {
			return bidOutcome{Err: err}
		}
		switch env.Type {
		case model.TypeBidAccepted:
			if bidAmount(env) == amount {
				return bidOutcome{Accepted: true}
			}
		case model.TypeBidRejected:
			var data model.BidRejectedData
			_ = json.Unmarshal(env.Data, &data)
			return bidOutcome{Code: data.Code}
		}
	}
}

// scrapeMetrics fetches the lumen /metrics JSON. Returned bytes are
// unmarshalled into a metrics.Snapshot.
func scrapeMetrics(hc *http.Client, target string) (metrics.Snapshot, error) {
	var snap metrics.Snapshot
	resp, err := hc.Get(target + "/metrics")
	if err != nil {
		return snap, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return snap, fmt.Errorf("/metrics -> %d: %s", resp.StatusCode, string(body))
	}
	if err := json.Unmarshal(body, &snap); err != nil {
		return snap, fmt.Errorf("decode /metrics: %w", err)
	}
	return snap, nil
}

// loadReport is the structured T8 run output. Marshallable so CI / docs can
// consume the same numbers the human-readable print shows.
type loadReport struct {
	AID           string
	Config        loadConfig
	Elapsed       time.Duration
	Pre           metrics.Snapshot
	Post          metrics.Snapshot
	ObserverStats observerSnapshot
	BidderStats   bidderSnapshot
}

func (r loadReport) print() {
	fmt.Println("---- T8 load report ----")
	fmt.Printf("auction=%s elapsed=%v\n", r.AID, r.Elapsed)
	fmt.Printf("topology(harness): observers=%d bidders=%d bidInterval=%v auctionDur=%v\n",
		r.Config.Observers, r.Config.Bidders, r.Config.BidInterval, r.Config.AuctionDuration)
	if r.Config.BidsPerBidder > 0 {
		fmt.Printf("bid limit: bidsPerBidder=%d\n", r.Config.BidsPerBidder)
	}
	if r.Config.RetryTooLow {
		fmt.Printf("retry: retryTooLow=true maxAttempts=%d\n", r.Config.BidMaxAttempts)
	}
	fmt.Printf("bidder: sent=%d acked=%d rejected=%d errors=%d\n",
		r.BidderStats.Sent, r.BidderStats.Acked, r.BidderStats.Rejected, r.BidderStats.Errors)
	fmt.Printf("observer: frames=%d readErrors=%d dialErrors=%d\n",
		r.ObserverStats.Frames, r.ObserverStats.Errors, r.ObserverStats.DialErrs)
	// Histograms — server-side observation is authoritative (lock-stepped to the
	// hot path), not the client RTT.
	fmt.Printf("ack       p50=%.1fms p95=%.1fms p99=%.1fms max=%.1fms (count=%d, budget p95<%v)\n",
		r.Post.Ack.P50, r.Post.Ack.P95, r.Post.Ack.P99, r.Post.Ack.Max, r.Post.Ack.Count, r.Config.AckP95Budget)
	fmt.Printf("broadcast p50=%.1fms p95=%.1fms p99=%.1fms max=%.1fms (count=%d, budget p95<%v)\n",
		r.Post.Broadcast.P50, r.Post.Broadcast.P95, r.Post.Broadcast.P99, r.Post.Broadcast.Max,
		r.Post.Broadcast.Count, r.Config.BroadcastP95Budget)
	fmt.Printf("statePatch p50=%.1fms p95=%.1fms p99=%.1fms max=%.1fms (count=%d, budget p95<%v)\n",
		r.Post.RoomStatePatch.P50, r.Post.RoomStatePatch.P95, r.Post.RoomStatePatch.P99, r.Post.RoomStatePatch.Max,
		r.Post.RoomStatePatch.Count, r.Config.BroadcastP95Budget)
	fmt.Printf("hammer    p50=%.1fms p95=%.1fms p99=%.1fms (count=%d, budget p95<%v)\n",
		r.Post.Hammer.P50, r.Post.Hammer.P95, r.Post.Hammer.P99, r.Post.Hammer.Count,
		r.Config.HammerP95Budget)
	fmt.Printf("catchup   p50=%.1fms p95=%.1fms p99=%.1fms (count=%d)\n",
		r.Post.Catchup.P50, r.Post.Catchup.P95, r.Post.Catchup.P99, r.Post.Catchup.Count)
	fmt.Printf("catchup budget: p95<%v when count>0\n", r.Config.CatchupP95Budget)
	fmt.Printf("script    p50=%.1fms p95=%.1fms p99=%.1fms (count=%d, budget p99<%v)\n",
		r.Post.ScriptTime.P50, r.Post.ScriptTime.P95, r.Post.ScriptTime.P99, r.Post.ScriptTime.Count,
		r.Config.ScriptP99Budget)
	fmt.Printf("handler   p50=%.1fms p95=%.1fms p99=%.1fms (count=%d, budget p99<%v · P8 Go-side, excl. Redis RTT)\n",
		r.Post.HandlerOverhead.P50, r.Post.HandlerOverhead.P95, r.Post.HandlerOverhead.P99, r.Post.HandlerOverhead.Count,
		r.Config.HandlerP99Budget)
	fmt.Printf("counters: bidsAccepted=%d bidsRejected=%d roomStatePatches=%d roomStatePatchBids=%d backpressureForceClose=%d seqGapCount=%d streamLenMax=%d activeConns(end)=%d\n",
		r.Post.BidsAccepted-r.Pre.BidsAccepted,
		r.Post.BidsRejected-r.Pre.BidsRejected,
		r.Post.RoomStatePatches-r.Pre.RoomStatePatches,
		r.Post.RoomStatePatchBids-r.Pre.RoomStatePatchBids,
		r.Post.BackpressureDrop-r.Pre.BackpressureDrop,
		r.Post.SeqGap-r.Pre.SeqGap,
		r.Post.StreamLenMax, r.Post.ActiveConns)
}

// breaches returns the non-empty list of SLO violations (each as a one-line
// reason) — empty == PASS. The order matches the §4.2 budget table so the
// log is grep-friendly.
func (r loadReport) breaches() []string {
	var out []string
	if r.Post.Ack.Count == 0 {
		out = append(out, "no ack samples observed (instrumentation unwired?)")
	}
	if r.Post.Broadcast.Count == 0 && r.Post.RoomStatePatch.Count == 0 {
		out = append(out, "no public fanout samples observed (broadcast/room-state patch instrumentation unwired?)")
	}
	if r.Post.Ack.P95 > ms(r.Config.AckP95Budget) {
		out = append(out, fmt.Sprintf("ack p95 %.1fms > %v", r.Post.Ack.P95, r.Config.AckP95Budget))
	}
	if r.Post.Broadcast.P95 > ms(r.Config.BroadcastP95Budget) {
		out = append(out, fmt.Sprintf("broadcast p95 %.1fms > %v", r.Post.Broadcast.P95, r.Config.BroadcastP95Budget))
	}
	if r.Post.RoomStatePatch.P95 > ms(r.Config.BroadcastP95Budget) {
		out = append(out, fmt.Sprintf("room-state patch p95 %.1fms > %v", r.Post.RoomStatePatch.P95, r.Config.BroadcastP95Budget))
	}
	if r.Post.Hammer.Count > 0 && r.Post.Hammer.P95 > ms(r.Config.HammerP95Budget) {
		out = append(out, fmt.Sprintf("hammer p95 %.1fms > %v", r.Post.Hammer.P95, r.Config.HammerP95Budget))
	}
	if r.Post.Catchup.Count > 0 && r.Post.Catchup.P95 > ms(r.Config.CatchupP95Budget) {
		out = append(out, fmt.Sprintf("catchup p95 %.1fms > %v", r.Post.Catchup.P95, r.Config.CatchupP95Budget))
	}
	if r.Post.ScriptTime.P99 > ms(r.Config.ScriptP99Budget) {
		out = append(out, fmt.Sprintf("script p99 %.1fms > %v (V9 §4.2 footnote: ack-p95<80 pre-gate)", r.Post.ScriptTime.P99, r.Config.ScriptP99Budget))
	}
	if r.Post.HandlerOverhead.Count > 0 && r.Post.HandlerOverhead.P99 > ms(r.Config.HandlerP99Budget) {
		// P8: the WS BID_PLACE handler's own synchronous work (decode + canonicalize
		// + ack push), measured excluding the PlaceBid/Redis span so this is pure
		// Go-side time — the network RTT is already covered by ack p95<80ms.
		out = append(out, fmt.Sprintf("handler-overhead p99 %.1fms > %v (P8: WS handler Go-side work, excl. Redis RTT)", r.Post.HandlerOverhead.P99, r.Config.HandlerP99Budget))
	}
	if r.ObserverStats.Errors > 0 {
		out = append(out, fmt.Sprintf("observer readErrors=%d (must be 0)", r.ObserverStats.Errors))
	}
	if gap := r.Post.SeqGap - r.Pre.SeqGap; gap > 0 {
		// 0-tolerance correctness invariant (V9 §4.1).
		out = append(out, fmt.Sprintf("seqGapCount=%d (must be 0)", gap))
	}
	if r.BidderStats.Sent > 0 && r.BidderStats.Acked == 0 {
		out = append(out, "no bids acked (path likely broken — verify before reading p95)")
	}
	if r.Config.BidsPerBidder > 0 {
		want := int64(r.Config.Bidders * r.Config.BidsPerBidder)
		if r.BidderStats.Acked < want {
			out = append(out, fmt.Sprintf("accepted logical bids=%d < expected %d", r.BidderStats.Acked, want))
		}
	}
	return out
}

func ms(d time.Duration) float64 { return float64(d) / float64(time.Millisecond) }

// isBenignClose reports whether a read error is a normal connection teardown
// (server-initiated close, or our own conn.Close at end-of-run) rather than a
// mid-room frame-loss error. These must NOT count toward observer readErrors:
// the gate measures frames lost while the room is LIVE, not shutdown. A
// backpressure force-close (code 4000) is deliberately excluded — that IS a
// real drop and should still count.
func isBenignClose(err error) bool {
	if errors.Is(err, net.ErrClosed) { // "use of closed network connection"
		return true
	}
	return websocket.IsCloseError(err,
		websocket.CloseNormalClosure,    // 1000
		websocket.CloseGoingAway,        // 1001
		websocket.CloseNoStatusReceived, // 1005
		websocket.CloseAbnormalClosure,  // 1006
	)
}
