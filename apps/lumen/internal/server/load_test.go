package server

// T8 instrumentation tests. They exercise the metrics seams against the
// real in-process harness so a wiring regression (e.g. forgot to observe in
// BID_PLACE) gets caught in CI. Two flavours:
//   - integration via startTestServer (needs Redis+MySQL — same gate as the
//     persistence/T5 tests; skips fast in `go test` when infra is missing).
//   - pure-unit slices that exercise specific helpers (eventServerTimeMs,
//     loadReport.breaches, etc.) without any external dependency.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/metrics"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

// TestT8MetricsEndpointAcceptedBidIncrementsCounter — the wiring contract: a
// successful BID_PLACE must be reflected in /metrics within one snapshot read.
// If this regresses, the load harness's SLO assertions become silent no-ops.
func TestT8MetricsEndpointAcceptedBidIncrementsCounter(t *testing.T) {
	target, srv := startTestServer(t)
	aid := newAID("test_t8_metrics")
	liveAuctionFull(t, srv.st, aid)
	hc := &http.Client{Timeout: 5 * time.Second}

	pre := scrapeOrFatal(t, hc, target)
	if pre.Ack.Count != 0 {
		// Sanity: a fresh process should have no ack samples yet. Not strictly
		// fatal (some other test could have warmed the registry), but flag it.
		t.Logf("pre-run ack samples=%d (test isolation hint)", pre.Ack.Count)
	}

	buyer, err := devLogin(hc, target, "T8 Metrics Buyer", "user")
	if err != nil {
		t.Fatal(err)
	}
	c, err := dialAndJoin(target, buyer.Token, aid)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	bid, _ := model.NewEnvelope(model.TypeBidPlace, aid, 0, model.BidPlaceData{
		ClientBidID: "t8_metric_1", AmountCents: "11000",
	})
	if err := c.WriteJSON(bid); err != nil {
		t.Fatal(err)
	}
	if err := waitForType(c, model.TypeBidAccepted, 3*time.Second); err != nil {
		t.Fatalf("did not receive BID_ACCEPTED: %v", err)
	}

	// Allow up to 2s for the broadcast subscriber to fan out and observe
	// broadcastLatency. The ack/script samples are recorded synchronously on
	// the request goroutine so they're visible immediately after the ack.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		post := scrapeOrFatal(t, hc, target)
		if post.Ack.Count > pre.Ack.Count &&
			post.ScriptTime.Count > pre.ScriptTime.Count &&
			post.BidsAccepted > pre.BidsAccepted &&
			post.Broadcast.Count > pre.Broadcast.Count {
			return // all four counters/histograms advanced — wiring is live.
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("metrics did not advance: pre=%+v post=%+v", pre, scrapeOrFatal(t, hc, target))
}

// TestT8MetricsEndpointShapeIsStable — pin the JSON shape (CI / dashboards
// scrape this; a field rename should be a deliberate breaking change with
// a contract update). Pairs with metrics.TestSnapshotJSONShape at the
// package level; this guard runs against the *served* endpoint so a route
// mis-wire (forgot to register /metrics) also fails here.
func TestT8MetricsEndpointShapeIsStable(t *testing.T) {
	target, _ := startTestServer(t)
	hc := &http.Client{Timeout: 5 * time.Second}
	resp, err := hc.Get(target + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("/metrics -> %d", resp.StatusCode)
	}
	var raw map[string]json.RawMessage
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{
		"ackLatencyMs", "broadcastLatencyMs", "hammerLatencyMs", "catchupLatencyMs",
		"placeBidScriptTimeMs", "bidsAccepted", "bidsRejected", "backpressureForceClose",
		"seqGapCount", "streamLenMax", "activeConns",
	} {
		if _, ok := raw[k]; !ok {
			t.Errorf("/metrics missing field %q (shape break)", k)
		}
	}
}

// TestT8BackpressureForceCloseIncrementsCounter — a slow client whose CRITICAL
// lane fills triggers a force-close (T5 backpressure) AND must increment the
// T8 BackpressureDrop counter so the load report correlates ack-p95 spikes
// with how many slow clients got trimmed.
func TestT8BackpressureForceCloseIncrementsCounter(t *testing.T) {
	m := metrics.New()
	// A Conn with a tiny critical buffer and no writePump so the buffer fills
	// immediately — same shape as TestT5BackpressureCriticalDropsConn but with
	// the T8 wiring asserted.
	c := &Conn{
		send: make(chan []byte, 2), lossy: make(chan []byte, 2),
		done: make(chan struct{}), metrics: m, aid: "test", userID: "u",
	}
	c.trySend([]byte("a")) // fills slot 1
	c.trySend([]byte("b")) // fills slot 2 (cap=2)
	if got := m.BackpressureDrop.Load(); got != 0 {
		t.Fatalf("backpressure counter advanced too early: %d (the first two trySends fit the buffer)", got)
	}
	c.trySend([]byte("c")) // buffer full → force-close + counter inc
	if got := m.BackpressureDrop.Load(); got != 1 {
		t.Fatalf("backpressure counter: got=%d want=1", got)
	}
	// done channel should be closed (force-close path).
	select {
	case <-c.done:
	default:
		t.Fatal("trySend overflow did not close the conn")
	}
}

// TestT8SeqGapDetectorObservesMissingSeq — end-to-end check that the
// Hub.subscribe.fanout gap arithmetic actually fires the SeqGap counter when
// the stream advances by more than 1 between fanout passes. We:
//
//  1. land one real bid (seq=1) so the subscriber's lastSeq[aid] advances to 1
//     (the guard at ws.go requires lastSeq > 0 — first event is "I joined a
//     pre-existing stream", not a gap)
//  2. directly XADD a synthetic event at seq=3 (skipping seq=2) — the Lua
//     hot path would never produce a gap, so we plant one out-of-band to
//     exercise the detector
//  3. publish on the Pub/Sub channel to wake the subscriber
//  4. assert the SeqGap counter advances by exactly 1 (the magnitude of the
//     missing-seq range, NOT a binary "did it happen" flag)
//
// This pins the integration path (ws.go gap detector); the breaches matrix
// pins the arithmetic separately.
func TestT8SeqGapDetectorObservesMissingSeq(t *testing.T) {
	target, srv := startTestServer(t)
	ctx := context.Background()
	aid := newAID("test_t8_seqgap")
	liveAuctionFull(t, srv.st, aid)
	hc := &http.Client{Timeout: 5 * time.Second}

	// 1) Real bid to advance the subscriber's lastSeq to 1.
	if code, _, _, err := srv.st.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1"); err != nil || code != model.CodeOKAccepted {
		t.Fatalf("bid1: %s %v", code, err)
	}
	// Wait for the subscriber to fan out the bid (so its lastSeq[aid] = 1).
	pre := scrapeOrFatal(t, hc, target)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if scrapeOrFatal(t, hc, target).Broadcast.Count > pre.Broadcast.Count {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	// 2) Synthesise a gap: XADD a fabricated event at seq=3 (real Lua would
	// have advanced via seq=2 first). The id format matches `<seq>-0` per
	// proto/redis-keys.md. Use a minimal payload that has a serverTimeMs so
	// the broadcast-latency observation succeeds (otherwise the path is half-
	// instrumented and the test asserts less than it claims).
	preGap := scrapeOrFatal(t, hc, target).SeqGap
	streamKey := "auction:{" + aid + "}:events"
	if err := srv.st.Redis().XAdd(ctx, &redis.XAddArgs{
		Stream: streamKey, ID: "3-0",
		Values: map[string]any{
			"type": model.TypeBidAccepted, "seq": 3,
			"payload": `{"seq":3,"userId":"u_synth","amountCents":"50000","serverTimeMs":` + strconv.FormatInt(time.Now().UnixMilli(), 10) + `}`,
		},
	}).Err(); err != nil {
		t.Fatalf("synthetic XADD seq=3: %v", err)
	}
	// 3) Publish to wake the subscriber (it would also catch the gap on the
	// 2-s backstop tick — Publish just makes the test deterministic in <100ms).
	pubChan := "auction:{" + aid + "}:pub"
	if err := srv.st.Redis().Publish(ctx, pubChan, `{"type":"BID_ACCEPTED","seq":3}`).Err(); err != nil {
		t.Fatalf("publish wake-up: %v", err)
	}

	// 4) Assert the counter advanced by exactly 1 (seq jumped 1→3, missing seq=2).
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		post := scrapeOrFatal(t, hc, target).SeqGap
		if post == preGap+1 {
			return // exactly the expected gap magnitude.
		}
		if post > preGap+1 {
			t.Fatalf("seq-gap counter overshot: pre=%d post=%d (only seq=2 should be missing)", preGap, post)
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("seq-gap counter did not advance: pre=%d post=%d (expected pre+1)", preGap, scrapeOrFatal(t, hc, target).SeqGap)
}

// TestT8HammerLatencyObservation — assert closeDue Observes HammerLatency on
// the OK_NO_BID path (no winner ⇒ short test). Drives a real timer worker
// against a real auction by setting endAtMs in the past and waiting for the
// 100ms scan tick to fire the close. If this regresses (e.g. someone moves
// the Observe out of the OK_SOLD/OK_NO_BID case), the hammer SLO becomes
// silently unrecorded and the load report shows count=0 forever.
func TestT8HammerLatencyObservation(t *testing.T) {
	target, srv := startTestServer(t)
	ctx := context.Background()
	aid := newAID("test_t8_hammer")

	// Bring the auction live with a 100ms duration so endAtMs is in the
	// near-past by the time the next 100ms scan tick fires close_auction.lua.
	if code, err := srv.st.FreezeRules(ctx, aid, "seller_t8_h", model.Rules{
		StartPriceCents: 10000, IncrementCents: 1000, CapPriceCents: 0,
		DurationSec: 1, ExtendWindowSec: 0, ExtendSec: 0,
	}); err != nil || code != model.CodeOKFrozen {
		t.Fatalf("freeze: code=%s err=%v", code, err)
	}
	if code, _, err := srv.st.StartAuction(ctx, aid, 100); err != nil || code != model.CodeOKLive {
		t.Fatalf("start: code=%s err=%v", code, err)
	}
	t.Cleanup(func() {
		if keys, _ := srv.st.Redis().Keys(ctx, "auction:{"+aid+"}:*").Result(); len(keys) > 0 {
			_ = srv.st.Redis().Del(ctx, keys...).Err()
		}
		_, _ = srv.st.DB().ExecContext(ctx, "DELETE FROM auction_events WHERE auction_id = ?", aid)
	})

	hc := &http.Client{Timeout: 5 * time.Second}
	pre := scrapeOrFatal(t, hc, target).Hammer.Count

	// Timer Worker scans every 100ms. Allow up to 3s for it to hammer this
	// auction (NO_BID path: no winning bid was placed). Hammer.Count must
	// advance by exactly 1 — the closeDue Observe ran with the snapshot's
	// endAtMs as the reference (now - endAtMs ≈ a small detection lag).
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if post := scrapeOrFatal(t, hc, target).Hammer.Count; post == pre+1 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("HammerLatency did not advance: pre=%d post=%d (expected pre+1)", pre, scrapeOrFatal(t, hc, target).Hammer.Count)
}

// TestT8CatchupLatencyObservation — assert the ROOM_JOIN catchup branch
// Observes CatchupLatency for BOTH a cold-join (lastSeq=0, replays whole
// history) AND a reconnect (lastSeq > 0). The earlier guard `d.LastSeq > 0`
// silently dropped cold-joins, so this test pins the corrected behaviour.
func TestT8CatchupLatencyObservation(t *testing.T) {
	target, srv := startTestServer(t)
	ctx := context.Background()
	aid := newAID("test_t8_catchup")
	liveAuctionFull(t, srv.st, aid)
	hc := &http.Client{Timeout: 5 * time.Second}

	// Plant 3 real bids so the catchup branch has events to replay.
	for i := 1; i <= 3; i++ {
		amt := fmt.Sprintf("%d", 10000+i*1000)
		cb := fmt.Sprintf("cb_catchup_%d", i)
		uid := fmt.Sprintf("u_catchup_%d", i)
		if code, _, _, err := srv.st.PlaceBid(ctx, aid, uid, cb, amt, uid); err != nil || code != model.CodeOKAccepted {
			t.Fatalf("bid %d: %s %v", i, code, err)
		}
	}
	buyer, err := devLogin(hc, target, "Catchup Probe", "user")
	if err != nil {
		t.Fatal(err)
	}

	// Cold-join (lastSeq=0): replays seq 1..3 before the snapshot. CatchupLatency
	// MUST advance — the §4.2 200-events-<1s budget targets exactly this case.
	preCold := scrapeOrFatal(t, hc, target).Catchup.Count
	c1 := dialRaw(t, target, buyer.Token)
	join0, _ := model.NewEnvelope(model.TypeRoomJoin, aid, 0, model.RoomJoinData{AuctionID: aid, LastSeq: 0})
	if err := c1.WriteJSON(join0); err != nil {
		t.Fatal(err)
	}
	if err := waitForType(c1, model.TypeRoomSnapshot, 3*time.Second); err != nil {
		t.Fatalf("cold-join no ROOM_SNAPSHOT: %v", err)
	}
	if got := scrapeOrFatal(t, hc, target).Catchup.Count; got <= preCold {
		t.Fatalf("CatchupLatency did not advance on cold-join: pre=%d post=%d (the d.LastSeq>0 guard regressed?)", preCold, got)
	}

	// Reconnect (lastSeq=1): replays seq 2..3 (one event past the client's
	// last-seen). Same observation path; should also advance the counter.
	preReconnect := scrapeOrFatal(t, hc, target).Catchup.Count
	c2 := dialRaw(t, target, buyer.Token)
	join1, _ := model.NewEnvelope(model.TypeRoomJoin, aid, 0, model.RoomJoinData{AuctionID: aid, LastSeq: 1})
	if err := c2.WriteJSON(join1); err != nil {
		t.Fatal(err)
	}
	if err := waitForType(c2, model.TypeRoomSnapshot, 3*time.Second); err != nil {
		t.Fatalf("reconnect no ROOM_SNAPSHOT: %v", err)
	}
	if got := scrapeOrFatal(t, hc, target).Catchup.Count; got <= preReconnect {
		t.Fatalf("CatchupLatency did not advance on reconnect: pre=%d post=%d", preReconnect, got)
	}
}

// TestT8EventServerTimeMsHandlesMalformedPayload — the broadcast-latency
// extractor must NOT panic / not Observe on a malformed payload (e.g. a future
// event type that lacks serverTimeMs). It returns 0 and the caller skips.
func TestT8EventServerTimeMsHandlesMalformedPayload(t *testing.T) {
	cases := []struct {
		name    string
		payload string
		want    int64
	}{
		{"empty", "", 0},
		{"not-json", "not-json", 0},
		{"missing-field", `{"foo":"bar"}`, 0},
		{"wrong-type", `{"serverTimeMs":"oops"}`, 0},
		{"valid", `{"serverTimeMs":12345}`, 12345},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := eventServerTimeMs(c.payload); got != c.want {
				t.Fatalf("got=%d want=%d", got, c.want)
			}
		})
	}
}

// TestT8LoadReportBreachesMatrix — the SLO assertion table is the only thing
// between a silent perf regression and a red CI run. Exhaustively cover the
// breach detectors so an off-by-one (using >= vs >, comparing ms vs ns) gets
// caught here, not by chasing a wrong perf-report.md number.
func TestT8LoadReportBreachesMatrix(t *testing.T) {
	cfg := loadConfig{
		CatchupP95Budget: 1000 * time.Millisecond,
		AckP95Budget:       80 * time.Millisecond,
		BroadcastP95Budget: 150 * time.Millisecond,
		HammerP95Budget:    500 * time.Millisecond,
		ScriptP99Budget:    5 * time.Millisecond,
	}
	type fields struct {
		ackP95, bcastP95, hammerP95, catchupP95, scriptP99 float64
		ackCount, bcastCount, hammerCount, catchupCount    int64
		preSeqGap, postSeqGap                              int64
		sent, acked                                        int64
		wantBreach                                         []string // substrings that must appear
		wantClean                                          bool     // expect 0 breaches
	}
	tt := []fields{
		// happy path: ack 50, broadcast 80, hammer 200, script 1; seq 0; bids ok.
		{ackP95: 50, bcastP95: 80, hammerP95: 200, scriptP99: 1,
			ackCount: 100, bcastCount: 100, hammerCount: 1, sent: 100, acked: 100, wantClean: true},
		// no samples (instrumentation unwired).
		{ackCount: 0, sent: 0, acked: 0, wantBreach: []string{"no ack samples", "no broadcast samples"}},
		// ack p95 just over.
		{ackP95: 81, bcastP95: 80, scriptP99: 1, ackCount: 1, bcastCount: 1, sent: 1, acked: 1,
			wantBreach: []string{"ack p95 81.0ms > 80ms"}},
		// broadcast p95 just over.
		{ackP95: 50, bcastP95: 151, scriptP99: 1, ackCount: 1, bcastCount: 1, sent: 1, acked: 1,
			wantBreach: []string{"broadcast p95 151.0ms > 150ms"}},
		// hammer over (only when count > 0).
		{ackP95: 50, bcastP95: 80, hammerP95: 501, scriptP99: 1, ackCount: 1, bcastCount: 1, hammerCount: 1, sent: 1, acked: 1,
			wantBreach: []string{"hammer p95 501.0ms > 500ms"}},
		// hammer over but count == 0 → NOT flagged (V9: "only assert if hammer fired").
		{ackP95: 50, bcastP95: 80, hammerP95: 9999, scriptP99: 1, ackCount: 1, bcastCount: 1, hammerCount: 0, sent: 1, acked: 1, wantClean: true},
		// catchup over budget is flagged when catchup observed.
		{ackP95: 50, bcastP95: 80, catchupP95: 1001, scriptP99: 1, catchupCount: 1,
			ackCount: 1, bcastCount: 1, sent: 1, acked: 1, wantBreach: []string{"catchup p95 1001.0ms > 1s"}},
		// script p99 over.
		{ackP95: 50, bcastP95: 80, scriptP99: 6, ackCount: 1, bcastCount: 1, sent: 1, acked: 1,
			wantBreach: []string{"script p99 6.0ms > 5ms"}},
		// seqGap delta > 0.
		{ackP95: 50, bcastP95: 80, scriptP99: 1, ackCount: 1, bcastCount: 1, preSeqGap: 0, postSeqGap: 3, sent: 1, acked: 1,
			wantBreach: []string{"seqGapCount=3 (must be 0)"}},
		// bids sent but none acked (path probably broken).
		{ackP95: 0, bcastP95: 0, scriptP99: 1, ackCount: 1, bcastCount: 1, sent: 5, acked: 0,
			wantBreach: []string{"no bids acked"}},
	}
	for i, c := range tt {
		t.Run(fmt.Sprintf("case_%d", i), func(t *testing.T) {
			r := loadReport{
				Config: cfg,
				Pre:    metrics.Snapshot{SeqGap: c.preSeqGap},
				Post: metrics.Snapshot{
					Ack:        metrics.HistogramSnapshot{P95: c.ackP95, Count: c.ackCount},
					Broadcast:  metrics.HistogramSnapshot{P95: c.bcastP95, Count: c.bcastCount},
					Hammer:     metrics.HistogramSnapshot{P95: c.hammerP95, Count: c.hammerCount},
					Catchup:    metrics.HistogramSnapshot{P95: c.catchupP95, Count: c.catchupCount},
					ScriptTime: metrics.HistogramSnapshot{P99: c.scriptP99, Count: 1},
					SeqGap:     c.postSeqGap,
				},
				BidderStats: bidderSnapshot{Sent: c.sent, Acked: c.acked},
			}
			got := r.breaches()
			if c.wantClean {
				if len(got) != 0 {
					t.Fatalf("want clean, got breaches: %v", got)
				}
				return
			}
			joined := strings.Join(got, " | ")
			for _, want := range c.wantBreach {
				if !strings.Contains(joined, want) {
					t.Errorf("missing breach %q (got: %s)", want, joined)
				}
			}
		})
	}
}

// TestT8LoadSmokeRunsAndPasses — end-to-end on the in-process harness, scaled
// down to fit a CI runner: 3 observers + 2 bidders + 1.5s window with relaxed
// budgets. Asserts:
//   - load completes without error (SLO holds at the relaxed budgets)
//   - the harness captured at least one ack and one broadcast sample
//   - seqGap == 0 (correctness invariant survives even at low N)
//   - the load auction was settled enough that `verify` can be chained
//
// This is the regression net for the harness itself: it pins the dial→bid→ack
// pipeline so a regression (e.g. observer goroutine leak, ticker math) fails
// here in <5 s rather than being discovered in a 60s full-scale run.
func TestT8LoadSmokeRunsAndPasses(t *testing.T) {
	target, _ := startTestServer(t)

	// Override env so the harness inside the same process reads our small-N
	// values. t.Setenv reverts after the test.
	t.Setenv("LOAD_OBSERVERS", "3")
	t.Setenv("LOAD_BIDDERS", "2")
	t.Setenv("LOAD_DURATION_SEC", "2")
	t.Setenv("LOAD_BID_INTERVAL_MS", "100")
	t.Setenv("LOAD_ACK_P95_MS", "500")
	t.Setenv("LOAD_BROADCAST_P95_MS", "1000")
	t.Setenv("LOAD_HAMMER_P95_MS", "5000")
	t.Setenv("LOAD_SCRIPT_P99_MS", "50")
	t.Setenv("LOAD_AUCTION_DUR_SEC", "60")
	t.Setenv("LOAD_OBSERVER_STAGGER_MS", "5")

	if err := RunLoad(target); err != nil {
		t.Fatalf("load smoke failed: %v", err)
	}

	hc := &http.Client{Timeout: 5 * time.Second}
	post := scrapeOrFatal(t, hc, target)
	if post.Ack.Count == 0 {
		t.Fatal("smoke: ack histogram empty (instrumentation regression)")
	}
	if post.Broadcast.Count == 0 {
		t.Fatal("smoke: broadcast histogram empty (subscribe wiring regression)")
	}
	if post.SeqGap != 0 {
		t.Fatalf("smoke: seqGap=%d (must be 0 — V9 §4.1 correctness invariant)", post.SeqGap)
	}
	if post.BidsAccepted == 0 {
		t.Fatal("smoke: bidsAccepted counter never advanced")
	}
}

// TestT8MetricsRegistryNilSafeInTests — every Observe / Inc site in the
// instrumented code uses `if m != nil` so a unit test that constructs a Hub or
// Conn without a registry continues to work. Pin that by passing nil through
// the hot-path entry points.
func TestT8MetricsRegistryNilSafeInTests(t *testing.T) {
	c := &Conn{send: make(chan []byte, 1), lossy: make(chan []byte, 1), done: make(chan struct{}), metrics: nil}
	c.trySend([]byte("ok")) // fits the buffer
	// Force a force-close path with metrics=nil; must not panic.
	c.trySend([]byte("overflow"))
	select {
	case <-c.done:
	default:
		t.Fatal("trySend overflow with nil metrics did not close the conn (regression in close path)")
	}
}

// --- helpers ---

func scrapeOrFatal(t *testing.T, hc *http.Client, target string) metrics.Snapshot {
	t.Helper()
	resp, err := hc.Get(target + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		t.Fatalf("/metrics -> %d: %s", resp.StatusCode, string(body))
	}
	var snap metrics.Snapshot
	if err := json.Unmarshal(body, &snap); err != nil {
		t.Fatalf("decode /metrics: %v (body=%s)", err, string(body))
	}
	return snap
}

var _ = sync.WaitGroup{} // pin import for future async test refactor
