package orchestrator

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"github.com/Eliaaazzz/live-auction-system/tools/chaos-runner/internal/artifact"
)

// steadyBidder is a real WS bidder (per PDGGK PR #24 CR): it dev-logins to get
// a token, opens a WS connection, joins the room, then fires `rate` BID_PLACE
// messages per second and records every ack/reject + WS round-trip latency.
//
// Replaces the original REST stub (which recorded STUB_NO_ENDPOINT because T2
// has no REST /bid). Now the AI drill actually proves "AI down → bid path
// continues" because the bidder drives the real WS hot path that AI never
// touches.
type steadyBidder struct {
	baseURL string
	aid     string
	rate    int
	rec     *artifact.Recorder
	hc      *http.Client
}

func newSteadyBidder(baseURL, aid string, rate int, rec *artifact.Recorder) *steadyBidder {
	return &steadyBidder{
		baseURL: baseURL, aid: aid, rate: rate, rec: rec,
		hc: &http.Client{Timeout: 5 * time.Second},
	}
}

// Run dev-logins, opens WS, joins room, then loops bidding until ctx done.
// On any setup error it logs and exits — drill invariants will fail on the
// "no OK_ACCEPTED" signal which is the correct outcome (Eliaaazzz PR #24 CR
// 🟠 #3: don't pass with zero samples).
func (s *steadyBidder) Run(ctx context.Context) {
	if s.rate <= 0 {
		return
	}

	token, err := s.devLogin(ctx, "ChaosBidder")
	if err != nil {
		slog.ErrorContext(ctx, "bidgen.dev_login_failed", "err", err)
		return
	}
	c, err := s.dialAndJoin(ctx, token)
	if err != nil {
		slog.ErrorContext(ctx, "bidgen.ws_connect_failed", "err", err)
		return
	}
	defer c.Close()

	// Get initial currentPrice + increment so each bid is exactly +increment
	// above the running max. (Could also re-snapshot every N bids; for AI drill
	// the auction state moves slowly so initial snap + counter is fine.)
	snap, err := artifact.GetSnapshot(ctx, s.baseURL, s.aid)
	if err != nil {
		slog.ErrorContext(ctx, "bidgen.snapshot_failed", "err", err)
		return
	}
	startPrice, _ := strconv.ParseInt(snap.CurrentPriceCents, 10, 64)
	if startPrice == 0 {
		startPrice = 10000 // auc_demo seed default
	}
	const increment int64 = 1000

	// Pump WS reads into a channel so bid-send and ack-receive can pipeline.
	reads := make(chan recvMsg, 64)
	go s.readPump(ctx, c, reads)

	interval := time.Second / time.Duration(s.rate)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	var n int
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Drain any leftover messages from the previous iteration (lumen
			// sends BOTH a direct ack AND a room broadcast for the same bid,
			// so the channel can have 2 entries per bid). Recording without
			// a drain mixes direct-ack latency with broadcast-latency, which
			// skews p50/p95 toward 0 because broadcasts arrive ~µs after the
			// send. Drain first → measure only the next round-trip cleanly.
			for {
				select {
				case <-reads: // discard
					continue
				default:
				}
				break
			}
			n++
			amount := startPrice + int64(n)*increment
			cbid := fmt.Sprintf("chaos-bid-%d", n)
			sent := time.Now()
			if err := s.sendBid(c, cbid, strconv.FormatInt(amount, 10)); err != nil {
				s.rec.RecordBid(time.Now(), "ERR_WS_WRITE", time.Since(sent), err.Error())
				return // socket likely broken
			}
			// Block briefly for the matching ack/reject — read pump funnels
			// through `reads`. Timeout means "lost or ack pending" — record
			// as ERR_TIMEOUT so latency_envelope sees a measurable bad signal
			// rather than silently dropping the attempt.
			select {
			case <-ctx.Done():
				return
			case r := <-reads:
				code := r.code
				if code == "" {
					code = r.typ // e.g. ROOM_SNAPSHOT (shouldn't happen post-join but defensive)
				}
				s.rec.RecordBid(time.Now(), code, time.Since(sent), "")
				slog.DebugContext(ctx, "bidgen.attempt", "n", n, "code", code, "dur", time.Since(sent))
			case <-time.After(2 * time.Second):
				s.rec.RecordBid(time.Now(), "ERR_TIMEOUT", time.Since(sent), "no ack within 2s")
			}
		}
	}
}

func (s *steadyBidder) devLogin(ctx context.Context, nickname string) (string, error) {
	body, _ := json.Marshal(map[string]string{"nickname": nickname, "role": "user"})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		s.baseURL+"/api/dev-login", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.hc.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("dev-login status %d", resp.StatusCode)
	}
	var r struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return "", err
	}
	if r.Token == "" {
		return "", fmt.Errorf("dev-login returned empty token")
	}
	return r.Token, nil
}

func (s *steadyBidder) dialAndJoin(ctx context.Context, token string) (*websocket.Conn, error) {
	u, err := url.Parse(s.baseURL)
	if err != nil {
		return nil, err
	}
	scheme := "ws"
	if u.Scheme == "https" {
		scheme = "wss"
	}
	wsURL := fmt.Sprintf("%s://%s/ws?token=%s", scheme, u.Host, url.QueryEscape(token))
	c, _, err := websocket.DefaultDialer.DialContext(ctx, wsURL, nil)
	if err != nil {
		return nil, err
	}
	join := envelope{Type: "ROOM_JOIN", AuctionID: s.aid, ServerTimeMs: time.Now().UnixMilli(),
		Data: rawJSON(map[string]string{"auctionId": s.aid})}
	if err := c.WriteJSON(join); err != nil {
		c.Close()
		return nil, err
	}
	// Drain until ROOM_SNAPSHOT
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		var e envelope
		if err := c.ReadJSON(&e); err != nil {
			c.Close()
			return nil, fmt.Errorf("waiting for ROOM_SNAPSHOT: %w", err)
		}
		if e.Type == "ROOM_SNAPSHOT" {
			_ = c.SetReadDeadline(time.Time{}) // clear deadline; readPump sets per-read deadlines
			return c, nil
		}
	}
}

func (s *steadyBidder) sendBid(c *websocket.Conn, clientBidID, amountCents string) error {
	bid := envelope{
		Type: "BID_PLACE", AuctionID: s.aid, ServerTimeMs: time.Now().UnixMilli(),
		Data: rawJSON(map[string]string{"clientBidId": clientBidID, "amountCents": amountCents}),
	}
	return c.WriteJSON(bid)
}

// recvMsg is the bidgen-internal shape funneled from the WS read goroutine
// to the fire-loop. typ is the wire type, code is the wire-level code (or
// "OK_ACCEPTED" if the type was BID_ACCEPTED).
type recvMsg struct {
	typ  string
	seq  int64
	code string
}

// readPump funnels WS messages into a recvMsg channel. Translates BID_ACCEPTED
// to "OK_ACCEPTED" + the inner code so the fire-loop can record uniformly.
func (s *steadyBidder) readPump(ctx context.Context, c *websocket.Conn, out chan<- recvMsg) {
	for {
		_ = c.SetReadDeadline(time.Now().Add(10 * time.Second))
		var e envelope
		if err := c.ReadJSON(&e); err != nil {
			select {
			case <-ctx.Done():
				return
			default:
				// Push a synthetic terminal marker so the fire-loop notices.
				select {
				case out <- recvMsg{typ: "ERR_WS_READ", code: "ERR_WS_READ"}:
				default:
				}
				return
			}
		}
		var code string
		switch e.Type {
		case "BID_ACCEPTED":
			code = "OK_ACCEPTED"
		case "BID_REJECTED":
			var d struct {
				Code string `json:"code"`
			}
			_ = json.Unmarshal(e.Data, &d)
			code = d.Code
			if code == "" {
				code = "ERR_UNKNOWN"
			}
		case "AUCTION_EXTENDED", "AUCTION_SOLD":
			// Secondary events — broadcast to the room but not the per-bid ack.
			// Skip; the fire-loop is waiting for BID_ACCEPTED/REJECTED.
			continue
		case "ROOM_SNAPSHOT", "PONG":
			continue
		default:
			continue
		}
		select {
		case out <- recvMsg{typ: e.Type, seq: e.Seq, code: code}:
		case <-ctx.Done():
			return
		}
	}
}

// envelope is a minimal WS envelope mirror; we don't import the lumen model
// package because chaos-runner is a separate Go module.
type envelope struct {
	Type         string          `json:"type"`
	AuctionID    string          `json:"auctionId,omitempty"`
	Seq          int64           `json:"seq,omitempty"`
	ServerTimeMs int64           `json:"serverTimeMs"`
	Data         json.RawMessage `json:"data,omitempty"`
}

func rawJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return json.RawMessage(b)
}
