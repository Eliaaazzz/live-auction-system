package server

// T5 follow-up tests for the post-PR-#38 hardening surface (addresses @fariZzzz's
// second-pass design feedback on PR #38):
//
//   - empty-room cleanup in Hub.leave (Eliaaazzz's own non-blocking finding)
//   - typed close code 4000 BACKPRESSURE_DROP on trySend force-close (P3 #3)
//   - WS keepalive (PING/PONG + ReadDeadline) reaping silently-dead clients (P3 #1)
//   - outbound frame size bound (P3 #2)

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Hub.leave must drop an empty rooms[aid] entry so roomAIDs() / the fanout
// sweep stop scheduling work for zero-client rooms.
func TestT5HubLeaveCleansEmptyRoom(t *testing.T) {
	h := newHub()
	aid := "test_t5_emptyroom"
	cA := &Conn{aid: aid}
	cB := &Conn{aid: aid}
	h.join(aid, cA)
	h.join(aid, cB)
	if got := len(h.roomAIDs()); got != 1 {
		t.Fatalf("after 2 joins: rooms=%d want 1", got)
	}

	h.leave(cA)
	if got := len(h.roomAIDs()); got != 1 {
		t.Fatalf("after 1 leave: rooms=%d want 1 (room still has cB)", got)
	}

	h.leave(cB)
	if got := len(h.roomAIDs()); got != 0 {
		t.Fatalf("after 2 leaves: rooms=%d want 0 (empty room must be cleaned)", got)
	}
	if _, ok := h.rooms[aid]; ok {
		t.Fatalf("rooms[%s] still present in map; want cleaned up", aid)
	}
}

// closeWithCode emits a typed WS close that the client can read off the wire
// (defense-in-depth check: any caller that picks an app code 4000-4999 will
// reach the client as a *websocket.CloseError carrying that code + reason).
func TestT5CloseWithCodeEmitsTypedCloseFrame(t *testing.T) {
	target, srv := startTestServer(t)
	hc := &http.Client{Timeout: 5 * time.Second}
	buyer, err := devLogin(hc, target, "T5 CloseCode Buyer", "user")
	if err != nil {
		t.Fatal(err)
	}
	c := dialRaw(t, target, buyer.Token)
	c.SetCloseHandler(func(int, string) error { return nil })

	// Force the server-side Conn into hub.rooms via ROOM_JOIN so we can grab it.
	_ = c.WriteJSON(map[string]any{
		"type": "ROOM_JOIN", "auctionId": "test_t5_cwc",
		"serverTimeMs": time.Now().UnixMilli(),
		"data":         map[string]any{"auctionId": "test_t5_cwc"},
	})
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, _ = c.ReadMessage() // drain ROOM_SNAPSHOT

	conn := waitForFirstConnVisitable(t, srv.hub, 2*time.Second)
	if conn == nil {
		t.Fatal("server-side Conn never appeared in hub")
	}

	// Trigger a typed close.
	conn.closeWithCode(closeCodeBackpressureDrop, "backpressure")

	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, _, err = c.ReadMessage()
	ce, ok := err.(*websocket.CloseError)
	if !ok {
		t.Fatalf("expected websocket.CloseError, got %T %v", err, err)
	}
	if ce.Code != closeCodeBackpressureDrop {
		t.Fatalf("close code=%d want %d (BACKPRESSURE_DROP)", ce.Code, closeCodeBackpressureDrop)
	}
	if !strings.Contains(strings.ToLower(ce.Text), "backpressure") {
		t.Fatalf("close text=%q want to contain 'backpressure'", ce.Text)
	}
}

// Keepalive wiring sanity: handleWS sets a finite read deadline + pong handler,
// and writePump runs a PING ticker. We can't easily inject a sub-second pongWait
// without refactoring constants, so this test asserts (a) the constants are
// internally consistent (pingPeriod < pongWait, both finite), and (b) a healthy
// gorilla client (which auto-PONGs the server's PING) survives a 1.5s read.
// The point being: handleWS is no longer blocked on the ~2h OS TCP timeout.
func TestT5KeepaliveConstantsValidAndHealthyClientSurvives(t *testing.T) {
	if pongWait <= 0 || pingPeriod <= 0 || pingPeriod >= pongWait {
		t.Fatalf("keepalive constants invalid: pongWait=%v pingPeriod=%v (need 0 < pingPeriod < pongWait)", pongWait, pingPeriod)
	}
	if writeWait <= 0 {
		t.Fatalf("writeWait=%v must be > 0", writeWait)
	}

	target, _ := startTestServer(t)
	hc := &http.Client{Timeout: 5 * time.Second}
	buyer, err := devLogin(hc, target, "T5 Keepalive Buyer", "user")
	if err != nil {
		t.Fatal(err)
	}
	c := dialRaw(t, target, buyer.Token)

	// Healthy client: gorilla auto-replies to server PINGs (default PingHandler).
	// Set a short read deadline; expect a timeout (no data was sent), NOT a
	// CloseError — meaning the conn is alive and the keepalive isn't tearing
	// us down spuriously.
	_ = c.SetReadDeadline(time.Now().Add(1500 * time.Millisecond))
	_, _, err = c.ReadMessage()
	if ce, ok := err.(*websocket.CloseError); ok {
		t.Fatalf("healthy client got unexpected CloseError code=%d text=%q", ce.Code, ce.Text)
	}
	// A net.Error timeout here is the expected outcome (no traffic + healthy
	// keepalive in the background).
}

// Outbound frame oversize trips the bounded check in write() and closes the
// connection instead of producing weird socket behavior — a fail-fast for a
// future contributor who pushes a fat event payload.
func TestT5OversizeOutboundFrameClosesConn(t *testing.T) {
	c := &Conn{ws: nil, send: make(chan []byte, 1), lossy: make(chan []byte, 1), done: make(chan struct{})}
	huge := make([]byte, maxOutboundFrameBytes+1)
	if c.write(huge) {
		t.Fatal("write(huge) should return false on oversized frame")
	}
	select {
	case <-c.done:
	default:
		t.Fatal("write(huge) should close the conn")
	}
}

// waitForFirstConnVisitable polls the hub until at least one *Conn appears in
// any room, then returns it. The handler may need a few ms after Upgrade to
// land + complete ROOM_JOIN; returns nil if the deadline expires (caller may
// then trigger a join to make the Conn visible).
func waitForFirstConnVisitable(t *testing.T, h *Hub, d time.Duration) *Conn {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		h.mu.RLock()
		for _, room := range h.rooms {
			for c := range room {
				h.mu.RUnlock()
				return c
			}
		}
		h.mu.RUnlock()
		time.Sleep(20 * time.Millisecond)
	}
	return nil
}
