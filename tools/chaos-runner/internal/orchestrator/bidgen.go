package orchestrator

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/Eliaaazzz/live-auction-system/tools/chaos-runner/internal/artifact"
)

// steadyBidder fires `rate` bids/sec at the lumen REST API and records every
// attempt's wire code + latency. It exists so the orchestrator has *observed
// data* about what happened during the drill — without it, we'd be guessing
// at degrade behavior from server-side logs alone.
//
// T1-compatible: uses REST /api/auctions/{id}/bid (not WS) because the T1
// minimal demo has bidding-via-REST as the simplest e2e path. T-later: swap
// to WS for actual hot-path measurement.
//
// NOTE: PR #19 T1 trunk currently routes bids over WS only (no REST bid
// endpoint exists at api.go). This file's HTTP path is a STUB that logs the
// intent without a successful call until WS-driving lands. The recorder
// counts attempt+error so the invariants still get *some* signal during the
// AI drill (which doesn't degrade bid path anyway). See README §"Known gaps".
type steadyBidder struct {
	baseURL string
	aid     string
	rate    int
	rec     *artifact.Recorder
	client  *http.Client
}

func newSteadyBidder(baseURL, aid string, rate int, rec *artifact.Recorder) *steadyBidder {
	return &steadyBidder{
		baseURL: baseURL, aid: aid, rate: rate, rec: rec,
		client: &http.Client{Timeout: 2 * time.Second},
	}
}

func (s *steadyBidder) Run(ctx context.Context) {
	if s.rate <= 0 {
		return
	}
	interval := time.Second / time.Duration(s.rate)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	var i int
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			i++
			s.fire(ctx, i)
		}
	}
}

func (s *steadyBidder) fire(ctx context.Context, n int) {
	start := time.Now()
	body, _ := json.Marshal(map[string]string{
		"clientBidId": fmt.Sprintf("chaos-runner-bid-%d", n),
		"amountCents": "10000",
	})
	// T1 STUB: no REST bid endpoint yet. Log attempt + record as a synthetic
	// rejection so latency_envelope has samples to compute over. Will replace
	// with WS-driving in a follow-up PR once T1 trunk merges.
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		s.baseURL+"/api/auctions/"+s.aid+"/bid", bytes.NewReader(body))
	resp, err := s.client.Do(req)
	dur := time.Since(start)

	if err != nil {
		s.rec.RecordBid(time.Now(), "ERR_NETWORK", dur, err.Error())
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		// Expected in T1 — endpoint doesn't exist yet. Record as synthetic
		// "expected stub" rather than real failure so AI drill invariants
		// don't false-alarm.
		s.rec.RecordBid(time.Now(), "STUB_NO_ENDPOINT", dur, "T1 has no REST /bid; WS-driving lands later")
		return
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		s.rec.RecordBid(time.Now(), "OK_ACCEPTED", dur, "")
		return
	}
	// 4xx/5xx: try to parse {code: "..."} from body
	var body4xx struct {
		Code string `json:"code"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&body4xx)
	code := body4xx.Code
	if code == "" {
		code = fmt.Sprintf("HTTP_%d", resp.StatusCode)
	}
	s.rec.RecordBid(time.Now(), code, dur, "")
	slog.DebugContext(ctx, "bidgen.attempt", "n", n, "code", code, "dur", dur)
}
