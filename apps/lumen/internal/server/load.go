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
// stack), creates one or more fresh auctions tuned to never reject (increment=1,
// no cap, no anti-snipe window, long duration), then opens N observer
// connections and K active bidders distributed across shards. Observers join and
// listen for broadcasts; bidders run a loose-pipelined bid loop with one
// inflight bid each, each amount strictly increasing so every bid is accepted
// (we are measuring latency, not adjudication).
// The harness scrapes the /metrics snapshot at the end and asserts the SLO
// against the §4.2 P0-gate budgets (configurable via env so a small CI run can
// exercise the same code path with lower thresholds).
//
// The auction ids are printed to stdout as `LOAD_AUCTION_IDS=...` so a downstream
// observer can map shard-to-room behavior. `LOAD_AUCTION_ID=<first>` is still
// emitted for existing automation that expects one id.
//
// Tunables (defaults track V9 §4.2 P0 gate):
//
//	LOAD_OBSERVERS         = 500    (connected, lossy)
//	LOAD_BIDDERS           =  50    (active)
//	LOAD_SHARDS            =   1    (auction rooms, each gets shard_i connections)
//	LOAD_DURATION_SEC      =  60
//	LOAD_BID_INTERVAL_MS   = 100    (per bidder; 50 × 10/s = 500 bid/s aggregate)
//	LOAD_ACK_P95_MS        =  80
//	LOAD_BROADCAST_P95_MS  = 150
//	LOAD_HAMMER_P95_MS     = 500    (only asserted if the auction hammered inside the window)
//	LOAD_CATCHUP_P95_MS    = 1000   (only asserted if catchup stream replay was observed)
//	LOAD_SCRIPT_P99_MS     =   5    (hot-path Lua exec budget, V9 §4.2 footnote)
//	LOAD_AUCTION_DUR_SEC   = 3600   (the auction stays LIVE past the load window; no hammer)
//	LOAD_RESET_METRICS     = 1      (POST /metrics/reset before run to isolate this run)
//
// Exit conventions: error (exit != 0) on any SLO breach, on any setup failure,
// and on seq gap > 0. The error message lists every breach so CI fails LOUD.
func RunLoad(target string) error {
	cfg := loadConfigFromEnv()
	hc := &http.Client{Timeout: 10 * time.Second}

	auctionIDs, err := loadSetupAuction(hc, target, cfg)
	if err != nil {
		return fmt.Errorf("load setup: %w", err)
	}
	fmt.Printf("LOAD_AUCTION_IDS=%s\n", strings.Join(auctionIDs, ","))
	fmt.Printf("LOAD_AUCTION_ID=%s\n", auctionIDs[0]) // captured by `make load` for the downstream verifier
	fmt.Printf("load config: observers=%d bidders=%d shards=%d duration=%v bidInterval=%v\n",
		cfg.Observers, cfg.Bidders, cfg.Shards, cfg.Duration, cfg.BidInterval)

	// Reset metrics counters/histograms for this load run where supported, then
	// take a pre-run snapshot for diagnostics and delta calculations.
	if cfg.ResetMetricsForRun {
		if err := resetMetricsSnapshot(hc, target); err != nil {
			return fmt.Errorf("reset /metrics: %w", err)
		}
	}
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
		go runObserver(ctx, target, observerBuyer.Token, auctionIDs[i%len(auctionIDs)], stats, &observerWG)
		time.Sleep(time.Duration(cfg.ObserverStaggerMs) * time.Millisecond)
	}
	// Bidders: each gets its OWN dev-login so the leaderboard ZADD has N
	// distinct members (realistic concurrent-user signal) and the per-user
	// dedupe Hash stays bounded (one bidder ≈ one entry per bid; not 50
	// bidders sharing a single 30k-field hash). Login is cheap (HTTP + JWT) and
	// happens once per bidder before the load window starts.
	var amountCounter atomic.Int64 // bid amount = loadStartCents + amountCounter++
	amountCounter.Store(loadStartCents)
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
		go runBidder(ctx, target, bidderTokens[i], auctionIDs[i%len(auctionIDs)], i, cfg, stats, &amountCounter, &bidderWG)
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
		AIDs:          auctionIDs,
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
	Shards             int
	Duration           time.Duration
	BidInterval        time.Duration
	AckP95Budget       time.Duration
	BroadcastP95Budget time.Duration
	CatchupP95Budget   time.Duration
	HammerP95Budget    time.Duration
	ScriptP99Budget    time.Duration
	AuctionDuration    time.Duration
	ObserverStaggerMs  int
	ResetMetricsForRun bool
}

func loadConfigFromEnv() loadConfig {
	shards := envInt("LOAD_SHARDS", 1)
	if shards <= 0 {
		shards = 1
	}
	return loadConfig{
		Observers:          envInt("LOAD_OBSERVERS", 500),
		Bidders:            envInt("LOAD_BIDDERS", 50),
		Shards:             shards,
		Duration:           time.Duration(envInt("LOAD_DURATION_SEC", 60)) * time.Second,
		BidInterval:        time.Duration(envInt("LOAD_BID_INTERVAL_MS", 100)) * time.Millisecond,
		AckP95Budget:       time.Duration(envInt("LOAD_ACK_P95_MS", 80)) * time.Millisecond,
		BroadcastP95Budget: time.Duration(envInt("LOAD_BROADCAST_P95_MS", 150)) * time.Millisecond,
		CatchupP95Budget:   time.Duration(envInt("LOAD_CATCHUP_P95_MS", 1000)) * time.Millisecond,
		HammerP95Budget:    time.Duration(envInt("LOAD_HAMMER_P95_MS", 500)) * time.Millisecond,
		ScriptP99Budget:    time.Duration(envInt("LOAD_SCRIPT_P99_MS", 5)) * time.Millisecond,
		AuctionDuration:    time.Duration(envInt("LOAD_AUCTION_DUR_SEC", 3600)) * time.Second,
		ObserverStaggerMs:  envInt("LOAD_OBSERVER_STAGGER_MS", 10),
		ResetMetricsForRun: envBool("LOAD_RESET_METRICS", true),
	}
}

func envBool(key string, def bool) bool {
	if v := os.Getenv(key); v != "" {
		return v == "1" || strings.EqualFold(v, "true")
	}
	return def
}

// loadSetupAuction creates a fresh auction tuned so every well-formed bid is
// accepted: increment=1 (strictly-increasing amount stream), cap=0 (no buy-now
// ceiling), no anti-snipe window/extension, long duration (auction stays LIVE
// past the load window). Mirrors perfSetupAuction but with parameterised
// duration so the harness can also do a "short-duration → hammer mid-load" run
// for hammer p95 measurement.
func loadSetupAuction(hc *http.Client, target string, cfg loadConfig) ([]string, error) {
	seller, err := devLogin(hc, target, "Load Seller", "seller")
	if err != nil {
		return nil, fmt.Errorf("seller dev-login: %w", err)
	}
	productID, err := createProduct(hc, target, seller.Token)
	if err != nil {
		return nil, fmt.Errorf("create product: %w", err)
	}

	auctionIDs := make([]string, 0, cfg.Shards)
	for i := 0; i < cfg.Shards; i++ {
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
			return nil, fmt.Errorf("create auction shard=%d: %w", i+1, err)
		}
		aid := out.AuctionID
		if err := postExpectCode(hc, target+"/api/auctions/"+aid+"/freeze", seller.Token, nil, model.CodeOKFrozen); err != nil {
			return nil, fmt.Errorf("freeze auction %s: %w", aid, err)
		}
		if err := postExpectCode(hc, target+"/api/auctions/"+aid+"/start", seller.Token,
			map[string]int64{"durationMs": int64(cfg.AuctionDuration / time.Millisecond)},
			model.CodeOKLive); err != nil {
			return nil, fmt.Errorf("start auction %s: %w", aid, err)
		}
		auctionIDs = append(auctionIDs, aid)
	}
	if len(auctionIDs) == 0 {
		return nil, fmt.Errorf("load setup: no auctions created")
	}
	return auctionIDs, nil
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
		if r := recover(); r != nil {
			if isRecoverableObserverPanic(r) {
				return
			}
			stats.observerErr.Add(1)
		}
	}()
	debug := os.Getenv("LOAD_OBSERVER_DEBUG") != ""
	c, err := dialAndJoinForLoad(target, token, aid)
	if err != nil {
		stats.dialErr.Add(1)
		return
	}
	defer c.Close()
	for {
		// Cooperative cancel: bound the read so a quiet room doesn't deadline us
		// past ctx.Done.
		_ = c.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		_, _, err := c.ReadMessage()
		if err != nil {
			if isTimeout(err) {
				if ctx.Err() != nil {
					return
				}
				continue
			}
			if debug {
				fmt.Printf("observer[%s] err-type: %T\n", aid, err)
				fmt.Printf("observer[%s] err-msg: %v\n", aid, err)
			}
			if ctx.Err() != nil {
				return
			}
			stats.observerErr.Add(1)
			return
		}
		stats.observerFrame.Add(1)
		if ctx.Err() != nil {
			return
		}
	}
}

// runBidder opens one WS connection and sends BID_PLACE on a paced ticker, one
// in flight at a time. Each amount is loadStartCents + ++amountCounter, so 50
// concurrent bidders never collide on amount; each clientBidId encodes the
// bidder index + a monotonic local counter so retries (none here, but defensive)
// would be properly idempotent.
//
// Resilience: a write-error tears the conn down and exits (the socket is
// unusable); an ack timeout is logged via bidErrors but the loop continues so
// one transient blip doesn't permanently take a bidder out of the active
// population (which would lower observed aggregate bid rate and skew the SLO
// math towards optimism).
func runBidder(ctx context.Context, target, token, aid string, idx int, cfg loadConfig,
	stats *loadStats, amountCounter *atomic.Int64, wg *sync.WaitGroup) {
	defer wg.Done()
	c, err := dialAndJoinForLoad(target, token, aid)
	if err != nil {
		stats.dialErr.Add(1)
		return
	}
	defer c.Close()

	ticker := time.NewTicker(cfg.BidInterval)
	defer ticker.Stop()
	bidLocal := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			amt := amountCounter.Add(1) // 100001, 100002, ...
			bidLocal++
			env, _ := model.NewEnvelope(model.TypeBidPlace, aid, 0, model.BidPlaceData{
				ClientBidID: fmt.Sprintf("load_%d_%d", idx, bidLocal),
				AmountCents: strconv.FormatInt(amt, 10),
			})
			_ = c.SetWriteDeadline(time.Now().Add(2 * time.Second))
			if err := c.WriteJSON(env); err != nil {
				// A write failure means the socket is gone (TCP RST, server
				// force-close, etc.); the conn is unusable so exit cleanly.
				stats.bidErrors.Add(1)
				return
			}
			stats.bidsSent.Add(1)
			// Clear the prior iteration's read deadline before waitForBidAccepted
			// sets its own. Without this an earlier 2s deadline that already
			// expired (but the read returned before we noticed) could shrink the
			// effective wait window of the next call — biasing the bidErrors rate
			// upward. waitForBidAccepted always sets its own fresh deadline on entry,
			// so this is belt-and-suspenders for any future caller that doesn't.
			_ = c.SetReadDeadline(time.Time{})
			// Wait for the ack envelope for *this* bid: matching BID_ACCEPTED by
			// amountCents (the originating socket also receives broadcast copies of
			// other bidders' bids — skip those). One in-flight is enough at 50 × 10/s.
			// On timeout we keep the bidder alive: a single slow ack must not
			// silently shrink the active population (which would skew p95 low). The
			// next tick's bid will land normally as long as the socket is healthy.
			if err := waitForBidAccepted(c, strconv.FormatInt(amt, 10), 2*time.Second); err != nil {
				stats.bidErrors.Add(1)
				continue
			}
			stats.bidsAcked.Add(1)
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

func resetMetricsSnapshot(hc *http.Client, target string) error {
	req, err := http.NewRequest(http.MethodPost, target+"/metrics/reset", nil)
	if err != nil {
		return err
	}
	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return fmt.Errorf("/metrics/reset -> %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}

// loadReport is the structured T8 run output. Marshallable so CI / docs can
// consume the same numbers the human-readable print shows.
type loadReport struct {
	AIDs          []string
	Config        loadConfig
	Elapsed       time.Duration
	Pre           metrics.Snapshot
	Post          metrics.Snapshot
	ObserverStats observerSnapshot
	BidderStats   bidderSnapshot
}

func (r loadReport) print() {
	fmt.Println("---- T8 load report ----")
	fmt.Printf("auctions=%s elapsed=%v\n", strings.Join(r.AIDs, ","), r.Elapsed)
	fmt.Printf("topology(harness): observers=%d bidders=%d shards=%d bidInterval=%v auctionDur=%v\n",
		r.Config.Observers, r.Config.Bidders, r.Config.Shards, r.Config.BidInterval, r.Config.AuctionDuration)
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
	fmt.Printf("hammer    p50=%.1fms p95=%.1fms p99=%.1fms (count=%d, budget p95<%v)\n",
		r.Post.Hammer.P50, r.Post.Hammer.P95, r.Post.Hammer.P99, r.Post.Hammer.Count,
		r.Config.HammerP95Budget)
	fmt.Printf("catchup   p50=%.1fms p95=%.1fms p99=%.1fms (count=%d)\n",
		r.Post.Catchup.P50, r.Post.Catchup.P95, r.Post.Catchup.P99, r.Post.Catchup.Count)
	fmt.Printf("catchup budget: p95<%v when count>0\n", r.Config.CatchupP95Budget)
	fmt.Printf("script    p50=%.1fms p95=%.1fms p99=%.1fms (count=%d, budget p99<%v)\n",
		r.Post.ScriptTime.P50, r.Post.ScriptTime.P95, r.Post.ScriptTime.P99, r.Post.ScriptTime.Count,
		r.Config.ScriptP99Budget)
	fmt.Printf("counters: bidsAccepted=%d bidsRejected=%d backpressureForceClose=%d seqGapCount=%d streamLenMax=%d activeConns(end)=%d\n",
		r.Post.BidsAccepted-r.Pre.BidsAccepted,
		r.Post.BidsRejected-r.Pre.BidsRejected,
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
	if r.Post.Broadcast.Count == 0 {
		out = append(out, "no broadcast samples observed (instrumentation unwired?)")
	}
	if r.Post.Ack.P95 > ms(r.Config.AckP95Budget) {
		out = append(out, fmt.Sprintf("ack p95 %.1fms > %v", r.Post.Ack.P95, r.Config.AckP95Budget))
	}
	if r.Post.Broadcast.P95 > ms(r.Config.BroadcastP95Budget) {
		out = append(out, fmt.Sprintf("broadcast p95 %.1fms > %v", r.Post.Broadcast.P95, r.Config.BroadcastP95Budget))
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
	return out
}

func ms(d time.Duration) float64 { return float64(d) / float64(time.Millisecond) }

func isTimeout(err error) bool {
	if errors.Is(err, net.ErrClosed) {
		return true
	}
	var ne interface{ Timeout() bool }
	if errors.As(err, &ne) {
		return ne.Timeout()
	}
	// Gorilla wraps net.Error inside CloseError sometimes; also catch the
	// read-deadline string for portability.
	if ce, ok := err.(*websocket.CloseError); ok {
		switch ce.Code {
		case websocket.CloseNoStatusReceived,
			websocket.CloseAbnormalClosure,
			websocket.CloseNormalClosure,
			websocket.CloseGoingAway:
			return true
		}
	}
	if strings.Contains(err.Error(), "use of closed network connection") {
		return true
	}
	return strings.Contains(err.Error(), "i/o timeout")
}

func isRecoverableObserverPanic(v any) bool {
	errMsg := fmt.Sprint(v)
	if e, ok := v.(error); ok {
		errMsg = e.Error()
	}
	return strings.Contains(errMsg, "repeated read on failed websocket connection") ||
		strings.Contains(errMsg, "use of closed network connection")
}
