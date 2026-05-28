package server

// T9 chaos drill harness (V9 plan §10): assertable building blocks for `make
// chaos PHASE=<mysql|ws|timer|ai|redis>`. The Makefile is the high-level
// orchestrator (it stops/starts containers between assertions); this file
// supplies the low-level WS/REST assertions so each chaos run produces grep-able
// log lines ("CHAOS_OK ..." / "CHAOS_FAIL ...") and exits non-zero on any miss.
//
// Why a subcommand (not just shell + curl): the bid path is WebSocket-only, so
// every degrade/recover assertion needs to dial /ws, send BID_PLACE, and read
// the BID_ACCEPTED/BID_REJECTED envelope. Go reuses the existing e2e helpers
// (devLogin/createProduct/createAuction/dialAndJoin/waitForType) instead of
// reimplementing the same dance in bash. The Makefile glues calls together with
// `docker compose stop <svc>` between phases — that is the actual fault
// injection. See docs/t9-chaos.md for the per-phase runbook.

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

// ChaosOptions is the parsed flag set for `lumen chaos`. Each phase reads the
// subset it cares about; unused fields stay zero-valued.
type ChaosOptions struct {
	Target     string        // TARGET base URL (http://localhost:8080)
	Phase      string        // see Phase* constants below
	AID        string        // auction id (carried between phases via a state file)
	Token      string        // buyer JWT — if set, bid-expect skips devLogin so the drill can keep bidding even when MySQL is down (devLogin writes users to MySQL). Set by PhaseSetup output.
	Code       string        // expected BID_PLACE result code (OK_ACCEPTED / ERR_AUCTION_PAUSED / ERR_NOT_LIVE / ...)
	State      string        // expected GET /api/auctions/{id}.status (LIVE / SOLD / NO_BID / ...)
	LastSeq    int64         // ROOM_JOIN.lastSeq for the catchup phase
	WantSeq    int64         // minimum seq expected after catchup; or events-count threshold
	DurationMs int64         // PhaseSetup: auction duration (default 600_000ms = 10min)
	Timeout    time.Duration // per-phase wall-clock budget (default 10s)
}

// Phase identifiers. The Makefile passes these via `--phase=<name>`. Names match
// the V9 plan §10 chaos taxonomy + the building-blocks each Make target wires
// (e.g. PHASE=redis composes setup → bid-expect ERR_AUCTION_PAUSED → bid-expect
// OK_ACCEPTED on a fresh auction → verify).
const (
	PhaseSetup        = "setup"          // create auction + warm 1 bid → prints CHAOS_AID=...
	PhaseBidExpect    = "bid-expect"     // send BID_PLACE, assert BID_ACCEPTED (any OK_*) or BID_REJECTED.code == Code
	PhaseConnectFails = "connect-fails"  // dial /ws, assert the dial itself errors (gateway down)
	PhaseStateExpect  = "state-expect"   // GET /api/auctions/{aid}, assert state == State
	PhaseCatchup      = "catchup-expect" // dial with lastSeq, assert ROOM_SNAPSHOT.seq >= WantSeq
	PhaseWaitEvents   = "wait-events"    // poll /events-count until >= WantSeq (persistence drain)
)

// RunChaos is the entry point dispatched from cmd/lumen/main.go.
func RunChaos(opts ChaosOptions) error {
	if opts.Target == "" {
		return errors.New("chaos: TARGET required")
	}
	if opts.Timeout == 0 {
		opts.Timeout = 10 * time.Second
	}
	switch opts.Phase {
	case PhaseSetup:
		return chaosSetup(opts)
	case PhaseBidExpect:
		return chaosBidExpect(opts)
	case PhaseConnectFails:
		return chaosConnectFails(opts)
	case PhaseStateExpect:
		return chaosStateExpect(opts)
	case PhaseCatchup:
		return chaosCatchup(opts)
	case PhaseWaitEvents:
		return chaosWaitEvents(opts)
	default:
		return fmt.Errorf("chaos: unknown phase %q", opts.Phase)
	}
}

// chaosSetup creates a fresh auction, freezes rules, starts it, and warms with
// one accepted bid so the auction has known state (currentPrice=11000, seq=1)
// before the chaos drill stops a dependency. Prints CHAOS_AID=<aid> on stdout
// so the Make orchestrator can capture it for downstream phases.
func chaosSetup(opts ChaosOptions) error {
	hc := &http.Client{Timeout: opts.Timeout}
	seller, err := devLogin(hc, opts.Target, fmt.Sprintf("Chaos Seller %d", time.Now().UnixNano()), "seller")
	if err != nil {
		return fmt.Errorf("seller login: %w", err)
	}
	productID, err := createProduct(hc, opts.Target, seller.Token)
	if err != nil {
		return fmt.Errorf("create product: %w", err)
	}
	aid, err := createAuction(hc, opts.Target, seller.Token, productID)
	if err != nil {
		return fmt.Errorf("create auction: %w", err)
	}
	if err := postExpectCode(hc, opts.Target+"/api/auctions/"+aid+"/freeze", seller.Token, nil, model.CodeOKFrozen); err != nil {
		return fmt.Errorf("freeze: %w", err)
	}
	// Long-duration default keeps the auction LIVE through every drill (no
	// accidental timer hammer mid-chaos). The timer-chaos Make target overrides
	// via --duration-ms so the auction expires inside the drill window.
	durMs := opts.DurationMs
	if durMs <= 0 {
		durMs = 600000 // 10 minutes
	}
	if err := postExpectCode(hc, opts.Target+"/api/auctions/"+aid+"/start", seller.Token,
		map[string]int64{"durationMs": durMs}, model.CodeOKLive); err != nil {
		return fmt.Errorf("start: %w", err)
	}
	// Create a long-lived buyer that drills can reuse for BID_PLACE without
	// re-doing devLogin each call (devLogin upserts to MySQL → would hang
	// during the MySQL chaos drill). Print the token so the Make target can
	// thread it back into subsequent --phase=bid-expect calls via --token.
	buyer, err := devLogin(hc, opts.Target, fmt.Sprintf("Chaos Buyer %d", time.Now().UnixNano()), "user")
	if err != nil {
		return fmt.Errorf("buyer login: %w", err)
	}
	// Warm one bid so we have a known seq baseline (seq=1).
	if err := chaosPlaceBidExpect(opts.Target, aid, buyer.Token, "11000", model.CodeOKAccepted, opts.Timeout); err != nil {
		return fmt.Errorf("warm bid: %w", err)
	}
	fmt.Printf("CHAOS_AID=%s\n", aid)
	fmt.Printf("CHAOS_BUYER_TOKEN=%s\n", buyer.Token)
	fmt.Printf("CHAOS_OK phase=%s aid=%s durationMs=%d\n", opts.Phase, aid, durMs)
	return nil
}

// chaosBidExpect dials the gateway, sends one BID_PLACE, and asserts the
// resulting code (BID_ACCEPTED.* or BID_REJECTED.code) equals opts.Code.
// `opts.Code` accepts OK_* or ERR_* — both are accepted equivalents on the
// wire (BID_ACCEPTED carries no code field, BID_REJECTED carries Code).
// If opts.Token is empty, devLogin is called (works only when MySQL is up);
// for the MySQL drill the Make target threads the token from PhaseSetup.
func chaosBidExpect(opts ChaosOptions) error {
	if opts.AID == "" || opts.Code == "" {
		return errors.New("bid-expect: --aid and --code required")
	}
	token := opts.Token
	if token == "" {
		hc := &http.Client{Timeout: opts.Timeout}
		buyer, err := devLogin(hc, opts.Target, fmt.Sprintf("Chaos Buyer %d", time.Now().UnixNano()), "user")
		if err != nil {
			return fmt.Errorf("buyer login: %w", err)
		}
		token = buyer.Token
	}
	return chaosPlaceBidExpect(opts.Target, opts.AID, token, "12000", opts.Code, opts.Timeout)
}

// chaosPlaceBidExpect is the shared implementation: use the caller-provided
// token (PhaseSetup hands out a long-lived buyer to avoid devLogin during
// MySQL drills), dial+join, send BID_PLACE, read frames until we see
// BID_ACCEPTED or BID_REJECTED. amount is the literal AmountCents string
// (kept as string to preserve the JS-visible money boundary).
//
// Critically this function does NOT use the e2e helper `dialAndJoin` — that one
// waits for ROOM_SNAPSHOT, which the gateway can't produce when Redis is down
// (the JOIN handler returns silently on Snapshot error). For the chaos drill
// we only need c.aid to be set on the connection (the gateway DOES set it
// before the snapshot read), then BID_PLACE flows through the Lua dispatch
// which produces the expected error code. We dial and send JOIN without
// waiting for the snapshot ack.
func chaosPlaceBidExpect(target, aid, token, amount, expectCode string, timeout time.Duration) error {
	conn, err := chaosDialJoinNoWait(target, token, aid, timeout)
	if err != nil {
		return fmt.Errorf("dial+join: %w", err)
	}
	defer conn.Close()
	bid, _ := model.NewEnvelope(model.TypeBidPlace, aid, 0, model.BidPlaceData{
		ClientBidID: fmt.Sprintf("cb_chaos_%d", time.Now().UnixNano()),
		AmountCents: amount,
	})
	if err := conn.WriteJSON(bid); err != nil {
		return fmt.Errorf("send bid: %w", err)
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		_ = conn.SetReadDeadline(deadline)
		var env model.Envelope
		if err := conn.ReadJSON(&env); err != nil {
			return fmt.Errorf("read frame: %w", err)
		}
		switch env.Type {
		case model.TypeBidAccepted:
			// any OK_* / DUPLICATE collapses to BID_ACCEPTED on the wire.
			if !isAcceptCode(expectCode) {
				return fmt.Errorf("got BID_ACCEPTED but expected reject code %s", expectCode)
			}
			fmt.Printf("CHAOS_OK phase=bid-expect aid=%s code=%s observed=BID_ACCEPTED\n", aid, expectCode)
			return nil
		case model.TypeBidRejected:
			var rd model.BidRejectedData
			if err := json.Unmarshal(env.Data, &rd); err != nil {
				return fmt.Errorf("parse BID_REJECTED data: %w", err)
			}
			if rd.Code != expectCode {
				return fmt.Errorf("got BID_REJECTED code=%s, expected %s", rd.Code, expectCode)
			}
			fmt.Printf("CHAOS_OK phase=bid-expect aid=%s code=%s observed=BID_REJECTED\n", aid, expectCode)
			return nil
		default:
			// skip ROOM_SNAPSHOT / AUCTIONEER_TEXT / etc.
			continue
		}
	}
	return fmt.Errorf("timed out waiting for BID_ACCEPTED/BID_REJECTED (expected %s)", expectCode)
}

// chaosConnectFails dials /ws expecting a hard transport failure (gateway is
// stopped). The drill caller has just `docker compose stop lumen` and the
// kernel returns ECONNREFUSED. Returns nil if the dial errors, an error if it
// somehow connects.
func chaosConnectFails(opts ChaosOptions) error {
	d := websocket.Dialer{HandshakeTimeout: 2 * time.Second}
	wsURL := strings.Replace(opts.Target, "http://", "ws://", 1)
	wsURL = strings.Replace(wsURL, "https://", "wss://", 1) + "/ws"
	conn, _, err := d.Dial(wsURL, nil)
	if err == nil {
		_ = conn.Close()
		return fmt.Errorf("expected /ws dial to fail, but it succeeded")
	}
	fmt.Printf("CHAOS_OK phase=connect-fails err=%s\n", short(err.Error()))
	return nil
}

// chaosStateExpect GETs /api/auctions/{aid} and asserts the auction.status
// equals opts.State. Used after the timer chaos recovery to confirm the
// reinstated Timer Worker hammered the expired auction (LIVE → SOLD/NO_BID).
// Polls within opts.Timeout because state transitions are async (scan tick +
// persistence projection).
func chaosStateExpect(opts ChaosOptions) error {
	if opts.AID == "" || opts.State == "" {
		return errors.New("state-expect: --aid and --state required")
	}
	hc := &http.Client{Timeout: opts.Timeout}
	deadline := time.Now().Add(opts.Timeout)
	var lastSeen string
	for time.Now().Before(deadline) {
		var out struct {
			Status string `json:"status"`
		}
		if err := getJSON(hc, opts.Target+"/api/auctions/"+opts.AID, &out); err == nil {
			lastSeen = out.Status
			if out.Status == opts.State {
				fmt.Printf("CHAOS_OK phase=state-expect aid=%s state=%s\n", opts.AID, opts.State)
				return nil
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("state-expect aid=%s want=%s lastSeen=%s timeout", opts.AID, opts.State, lastSeen)
}

// chaosCatchup dials /ws with ROOM_JOIN.lastSeq=opts.LastSeq and asserts the
// returned ROOM_SNAPSHOT.seq >= opts.WantSeq — i.e. the gateway delivered
// either an XRANGE catchup or a snapshot fallback that covers every event the
// observer missed during the WS outage. Crucially this proves seq gap == 0
// across the fault (the V9 §10 chaos exit evidence).
func chaosCatchup(opts ChaosOptions) error {
	if opts.AID == "" {
		return errors.New("catchup-expect: --aid required")
	}
	hc := &http.Client{Timeout: opts.Timeout}
	buyer, err := devLogin(hc, opts.Target, fmt.Sprintf("Chaos Reconnect %d", time.Now().UnixNano()), "user")
	if err != nil {
		return fmt.Errorf("buyer login: %w", err)
	}
	u := strings.Replace(opts.Target, "http://", "ws://", 1)
	u = strings.Replace(u, "https://", "wss://", 1) + "/ws?token=" + buyer.Token
	d := websocket.Dialer{HandshakeTimeout: opts.Timeout}
	conn, _, err := d.Dial(u, nil)
	if err != nil {
		return fmt.Errorf("ws dial: %w", err)
	}
	defer conn.Close()
	join, _ := model.NewEnvelope(model.TypeRoomJoin, opts.AID, 0, model.RoomJoinData{
		AuctionID: opts.AID,
		LastSeq:   opts.LastSeq,
	})
	if err := conn.WriteJSON(join); err != nil {
		return fmt.Errorf("send JOIN: %w", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(opts.Timeout))
	var env model.Envelope
	if err := conn.ReadJSON(&env); err != nil {
		return fmt.Errorf("read JOIN response: %w", err)
	}
	if env.Type != model.TypeRoomSnapshot {
		return fmt.Errorf("expected ROOM_SNAPSHOT after catchup JOIN, got %s", env.Type)
	}
	var rs model.RoomSnapshotData
	if err := json.Unmarshal(env.Data, &rs); err != nil {
		return fmt.Errorf("parse ROOM_SNAPSHOT data: %w", err)
	}
	if rs.Seq < opts.WantSeq {
		return fmt.Errorf("catchup-expect aid=%s lastSeq=%d wantSeq>=%d gotSeq=%d (seq gap suspected)",
			opts.AID, opts.LastSeq, opts.WantSeq, rs.Seq)
	}
	fmt.Printf("CHAOS_OK phase=catchup-expect aid=%s lastSeq=%d gotSeq=%d wantSeq>=%d status=%s\n",
		opts.AID, opts.LastSeq, rs.Seq, opts.WantSeq, rs.Status)
	return nil
}

// chaosWaitEvents polls /events-count for opts.AID until it reaches
// opts.WantSeq (the persistence-drain assertion for the MySQL chaos drill).
// Times out and returns an error if persistence stays stuck.
func chaosWaitEvents(opts ChaosOptions) error {
	if opts.AID == "" || opts.WantSeq == 0 {
		return errors.New("wait-events: --aid and --want-seq required")
	}
	hc := &http.Client{Timeout: opts.Timeout}
	if err := waitEventsCount(hc, opts.Target, opts.AID, int(opts.WantSeq), opts.Timeout); err != nil {
		return fmt.Errorf("persistence drain: %w", err)
	}
	fmt.Printf("CHAOS_OK phase=wait-events aid=%s want=%d\n", opts.AID, opts.WantSeq)
	return nil
}

// --- helpers ---

// isAcceptCode reports whether a wire result is the "BID_ACCEPTED" family.
// Anything else (ERR_* / DUPLICATE) lands as BID_REJECTED on the wire.
func isAcceptCode(code string) bool {
	switch code {
	case model.CodeOKAccepted, model.CodeOKExtended, model.CodeOKSold:
		return true
	}
	return false
}

// chaosDialJoinNoWait opens a WS connection and sends ROOM_JOIN but does NOT
// wait for ROOM_SNAPSHOT. The gateway sets the connection's auction-id BEFORE
// reading the snapshot from Redis, so even when Redis is down the connection
// is correctly bound for BID_PLACE — the difference from dialAndJoin is that
// we don't block on a snapshot the gateway never sent. Used by the chaos
// bid-expect path only; production clients always wait for the snapshot.
func chaosDialJoinNoWait(target, token, aid string, timeout time.Duration) (*websocket.Conn, error) {
	u := strings.Replace(target, "http://", "ws://", 1)
	u = strings.Replace(u, "https://", "wss://", 1) + "/ws?token=" + token
	d := websocket.Dialer{HandshakeTimeout: timeout}
	conn, _, err := d.Dial(u, nil)
	if err != nil {
		return nil, err
	}
	join, _ := model.NewEnvelope(model.TypeRoomJoin, aid, 0, model.RoomJoinData{AuctionID: aid})
	if err := conn.WriteJSON(join); err != nil {
		conn.Close()
		return nil, err
	}
	// A small client-side delay so the gateway has time to process JOIN (set
	// c.aid + hub.join) before the BID_PLACE arrives. Without this, a fast
	// BID_PLACE can land before JOIN is processed and the handler rejects it
	// with c.aid=="" → ERR_BAD_INPUT — masking the real fault we are testing.
	time.Sleep(50 * time.Millisecond)
	return conn, nil
}

// short truncates a long error string for log-line readability.
func short(s string) string {
	const max = 80
	if len(s) > max {
		return s[:max] + "…"
	}
	return s
}
