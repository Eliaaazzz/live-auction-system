// Command wsload is a lightweight Go WebSocket load generator for the Lumen
// live-auction gateway — built to actually prove 万人 (10k+) concurrent WS
// sessions from a single box.
//
// Why a third harness (we already have k6 + Locust):
//   - Locust (Python/gevent) tops out around ~2k WS on one process — its
//     connection-storm ceiling, NOT the server's (see issue #118 report).
//   - k6 spins a full goja JS VM per VU; at 10k VUs that is tens of GB of RAM.
//   - This opens ONE goroutine per connection (a few KB of stack + a 1KB
//     read/write buffer each), so 10k live WS sessions cost ~150–250 MB and
//     a single box reaches 万人 with headroom.
//
// It deliberately does NOT compute the SLO verdict. The server's /metrics is
// the RTT-insulated source of truth (docs/deploy-and-latency.md §"measurement
// boundary"): ack p95 < 80ms, broadcast p95 < 150ms, seqGapCount == 0,
// backpressureForceClose == 0. This tool's job is to (a) generate the load and
// (b) report the client-side facts the server can't see for itself —
// connect success/failure, peak concurrent sockets, frames received, and the
// end-to-end bid-ack RTT (which includes the wire + client scheduling that the
// server-side ack timer excludes).
//
// Connection model (mirrors k6-ws.js / locustfile.py):
//   - observer: dial → ROOM_JOIN → read broadcasts (the fan-out receivers).
//   - bidder:   observer + bid `current+1` every 200ms, measure ack RTT.
//     Under contention most bids lose the race for current+1 and come back
//     ERR_TOO_LOW — expected; we're measuring fan-out + connection scale, not
//     bid throughput. Each accepted bid fans out to every connection, which is
//     exactly the broadcast path #118 hardened.
//
// Prereqs:
//  1. stack up:  docker compose -f infra/docker-compose.yml up -d --build --wait
//  2. seed:      N_USERS=5000 ./tools/loadtest/k6-setup.sh   (tokens + LIVE auction)
//  3. run (from this dir):
//     go run . -host ws://localhost:8080 -aid "$(cat ../../../.k6-aid)" \
//     -tokens ../.k6-tokens -conns 9900 -bidders 100 -ramp 45s -hold 60s
//
// While the hold window is open, capture the server truth in another shell:
//
//	curl -s localhost:8080/metrics | jq '{activeConns, ack:.ackLatencyMs, \
//	  bcast:.broadcastLatencyMs, seqGapCount, backpressureForceClose}'
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

type stats struct {
	connectOK    atomic.Int64
	connectFail  atomic.Int64
	closedEarly  atomic.Int64 // reader returned (server dropped us) before the hold ended
	framesRecv   atomic.Int64
	bidsSent     atomic.Int64
	bidsAccepted atomic.Int64
	bidsRejected atomic.Int64
	active       atomic.Int64
	peakActive   atomic.Int64

	mu      sync.Mutex
	ackMs   []float64
	dialErr map[string]int
	rejCode map[string]int
}

func (s *stats) markActive(delta int64) {
	n := s.active.Add(delta)
	if delta > 0 {
		for {
			p := s.peakActive.Load()
			if n <= p || s.peakActive.CompareAndSwap(p, n) {
				break
			}
		}
	}
}

func (s *stats) recordDialErr(err error) {
	msg := err.Error()
	// Collapse the volatile per-call dial address so errors group cleanly.
	if i := strings.Index(msg, ": "); i > 0 && len(msg) > 60 {
		msg = msg[strings.LastIndex(msg, ": ")+2:]
	}
	s.mu.Lock()
	if s.dialErr == nil {
		s.dialErr = map[string]int{}
	}
	s.dialErr[msg]++
	s.mu.Unlock()
}

func (s *stats) recordAck(ms float64) {
	s.mu.Lock()
	s.ackMs = append(s.ackMs, ms)
	s.mu.Unlock()
}

func (s *stats) recordReject(code string) {
	if code == "" {
		code = "(missing)"
	}
	s.bidsRejected.Add(1)
	s.mu.Lock()
	if s.rejCode == nil {
		s.rejCode = map[string]int{}
	}
	s.rejCode[code]++
	s.mu.Unlock()
}

// frame is the subset of the WS envelope this client inspects.
type frame struct {
	Type string `json:"type"`
	Data struct {
		CurrentPriceCents string `json:"currentPriceCents"`
		AmountCents       string `json:"amountCents"`
		UserID            string `json:"userId"`
		Code              string `json:"code"`
	} `json:"data"`
}

func main() {
	host := flag.String("host", "ws://localhost:8080", "gateway base, ws://host:port")
	aid := flag.String("aid", "", "auction id (LIVE) — required")
	tokensPath := flag.String("tokens", "../.k6-tokens", "path to newline-delimited JWT tokens")
	conns := flag.Int("conns", 9900, "observer connections")
	bidders := flag.Int("bidders", 100, "bidder connections (active price pushers)")
	ramp := flag.Duration("ramp", 45*time.Second, "time to open all connections")
	hold := flag.Duration("hold", 60*time.Second, "time to hold all connections after ramp")
	readBuf := flag.Int("readbuf", 1024, "per-conn read buffer bytes (small = less RAM at scale)")
	flag.Parse()

	if *aid == "" {
		log.Fatal("-aid required (e.g. -aid \"$(cat ../../../.k6-aid)\")")
	}
	tokens, err := loadTokens(*tokensPath)
	if err != nil {
		log.Fatalf("load tokens: %v", err)
	}
	if len(tokens) == 0 {
		log.Fatalf("no tokens in %s — run k6-setup.sh first", *tokensPath)
	}

	total := *conns + *bidders
	st := &stats{}
	dialer := &websocket.Dialer{
		HandshakeTimeout: 15 * time.Second,
		ReadBufferSize:   *readBuf,
		WriteBufferSize:  *readBuf,
	}

	start := time.Now()
	endAt := start.Add(*ramp + *hold)
	interval := *ramp / time.Duration(total)
	if interval <= 0 {
		interval = time.Microsecond
	}

	log.Printf("wsload: host=%s aid=%s tokens=%d → %d conns (%d bidders) ramp=%s hold=%s",
		*host, *aid, len(tokens), total, *bidders, *ramp, *hold)

	// Live progress line so a long ramp isn't a black box.
	stopProgress := make(chan struct{})
	go func() {
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-stopProgress:
				return
			case <-t.C:
				log.Printf("  … active=%d ok=%d fail=%d frames=%d acks=%d rej=%d",
					st.active.Load(), st.connectOK.Load(), st.connectFail.Load(),
					st.framesRecv.Load(), st.bidsAccepted.Load(), st.bidsRejected.Load())
			}
		}
	}()

	var wg sync.WaitGroup
	tick := time.NewTicker(interval)
	for i := 0; i < total; i++ {
		<-tick.C
		tok := tokens[i%len(tokens)]
		isBidder := i < *bidders // first N tokens are distinct → clean bidder identity
		wg.Add(1)
		go func(tok string, bidder bool) {
			defer wg.Done()
			runConn(dialer, *host, *aid, tok, bidder, endAt, st)
		}(tok, isBidder)
	}
	tick.Stop()
	log.Printf("ramp complete in %s — holding until %s", time.Since(start).Round(time.Millisecond), endAt.Format("15:04:05"))

	wg.Wait()
	close(stopProgress)
	report(st, total, time.Since(start))
}

func runConn(dialer *websocket.Dialer, host, aid, tok string, bidder bool, endAt time.Time, st *stats) {
	wsURL := host + "/ws?token=" + url.QueryEscape(tok)
	c, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		st.connectFail.Add(1)
		st.recordDialErr(err)
		return
	}
	st.connectOK.Add(1)
	st.markActive(1)
	defer func() {
		st.markActive(-1)
		_ = c.Close()
	}()
	_ = c.SetReadDeadline(endAt)

	uid := tok
	if i := strings.IndexByte(tok, '.'); i > 0 {
		uid = tok[:i]
	}

	// ROOM_JOIN (single write before any concurrent writer starts).
	if err := c.WriteMessage(websocket.TextMessage, envelope("ROOM_JOIN", aid, map[string]string{"auctionId": aid})); err != nil {
		st.closedEarly.Add(1)
		return
	}

	if !bidder {
		readLoop(c, uid, endAt, st, nil, nil)
		return
	}

	// Bidder: a reader goroutine (price tracking + ack matching) plus this
	// goroutine driving the 200ms bid ticker. gorilla permits one concurrent
	// reader and one concurrent writer, which is exactly this split.
	var mu sync.Mutex
	cur := int64(100000) // matches k6-setup startPriceCents; overwritten by snapshot
	pending := map[string]int64{}
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		readLoop(c, uid, endAt, st, &mu, func(f *frame, now int64) {
			switch f.Type {
			case "ROOM_SNAPSHOT":
				if n, ok := parseCents(f.Data.CurrentPriceCents); ok && n > cur {
					cur = n
				}
			case "BID_ACCEPTED":
				if n, ok := parseCents(f.Data.AmountCents); ok && n > cur {
					cur = n
				}
				if f.Data.UserID == uid {
					if t0, ok := pending[f.Data.AmountCents]; ok {
						st.recordAck(float64(now-t0) / 1e6)
						delete(pending, f.Data.AmountCents)
						st.bidsAccepted.Add(1)
					}
				}
			case "BID_REJECTED":
				st.recordReject(f.Data.Code)
			}
		})
	}()

	stop := time.NewTimer(time.Until(endAt))
	defer stop.Stop()
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-stop.C:
			_ = c.Close()
			<-readerDone
			return
		case <-ticker.C:
			mu.Lock()
			amt := cur + 1
			amtS := strconv.FormatInt(amt, 10)
			pending[amtS] = time.Now().UnixNano()
			mu.Unlock()
			cb := "wsload_" + uid + "_" + amtS
			_ = c.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err := c.WriteMessage(websocket.TextMessage, envelope("BID_PLACE", aid,
				map[string]string{"clientBidId": cb, "amountCents": amtS})); err != nil {
				_ = c.Close()
				<-readerDone
				return
			}
			st.bidsSent.Add(1)
		}
	}
}

// readLoop reads frames until the read deadline (endAt) or a connection error.
// onFrame (optional) is called under mu for bidder price/ack bookkeeping.
func readLoop(c *websocket.Conn, uid string, endAt time.Time, st *stats, mu *sync.Mutex, onFrame func(*frame, int64)) {
	for {
		_, raw, err := c.ReadMessage()
		if err != nil {
			// A read past endAt is the intended wind-down; anything earlier
			// means the server (or network) dropped us — a real signal.
			if time.Now().Before(endAt.Add(-1 * time.Second)) {
				st.closedEarly.Add(1)
			}
			return
		}
		st.framesRecv.Add(1)
		if onFrame == nil {
			continue
		}
		var f frame
		if err := jsonUnmarshal(raw, &f); err != nil {
			continue
		}
		now := time.Now().UnixNano()
		mu.Lock()
		onFrame(&f, now)
		mu.Unlock()
	}
}

func report(st *stats, target int, elapsed time.Duration) {
	st.mu.Lock()
	acks := append([]float64(nil), st.ackMs...)
	dialErr := st.dialErr
	rejCode := st.rejCode
	st.mu.Unlock()
	sort.Float64s(acks)

	fmt.Printf("\n──────── wsload summary (%.0fs) ────────\n", elapsed.Seconds())
	fmt.Printf("target connections   : %d\n", target)
	fmt.Printf("connect OK           : %d\n", st.connectOK.Load())
	fmt.Printf("connect FAIL         : %d\n", st.connectFail.Load())
	fmt.Printf("peak concurrent      : %d   (server /metrics activeConns is the authority)\n", st.peakActive.Load())
	fmt.Printf("closed early (server): %d   (>0 = gateway dropped live conns — investigate)\n", st.closedEarly.Load())
	fmt.Printf("frames received      : %d\n", st.framesRecv.Load())
	fmt.Printf("bids sent / acc / rej: %d / %d / %d\n", st.bidsSent.Load(), st.bidsAccepted.Load(), st.bidsRejected.Load())
	if len(rejCode) > 0 {
		codes := make([]string, 0, len(rejCode))
		for code := range rejCode {
			codes = append(codes, code)
		}
		sort.Strings(codes)
		fmt.Printf("bid rejects by code  :\n")
		for _, code := range codes {
			fmt.Printf("  %7d  %s\n", rejCode[code], code)
		}
	}
	if len(acks) > 0 {
		fmt.Printf("bid-ack RTT (client) : p50=%.1fms p95=%.1fms p99=%.1fms max=%.1fms  (n=%d, incl wire+client sched)\n",
			pct(acks, 50), pct(acks, 95), pct(acks, 99), acks[len(acks)-1], len(acks))
	}
	if len(dialErr) > 0 {
		fmt.Printf("dial errors:\n")
		for msg, n := range dialErr {
			fmt.Printf("  %5d  %s\n", n, msg)
		}
	}
	fmt.Println("─────────────────────────────────────────")
}

func pct(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	i := int(math.Ceil(p/100*float64(len(sorted)))) - 1
	if i < 0 {
		i = 0
	}
	if i >= len(sorted) {
		i = len(sorted) - 1
	}
	return sorted[i]
}

func parseCents(s string) (int64, bool) {
	if s == "" {
		return 0, false
	}
	n, err := strconv.ParseInt(s, 10, 64)
	return n, err == nil
}

func envelope(typ, aid string, data any) []byte {
	b, _ := json.Marshal(map[string]any{
		"schemaVersion": 2,
		"type":          typ,
		"auctionId":     aid,
		"serverTimeMs":  time.Now().UnixMilli(),
		"data":          data,
	})
	return b
}

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }

func loadTokens(path string) ([]string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, ln := range strings.Split(string(b), "\n") {
		if s := strings.TrimSpace(ln); s != "" {
			out = append(out, s)
		}
	}
	return out, nil
}
