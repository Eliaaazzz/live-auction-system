package server

// T5 follow-up tests for the post-PR-#38 hardening surface (addresses @fariZzzz's
// second-pass design feedback on PR #38 and #48):
//
//   - empty-room cleanup in Hub.leave (Eliaaazzz's own non-blocking finding)
//   - typed close code 4000 BACKPRESSURE_DROP on trySend force-close (P3 #3)
//   - typed CLOSE emission moved off the broadcast goroutine — P1 from PR #48
//     review: closeWithCode must NOT block under hub.RLock, the WriteControl
//     fires from writePump's flushClose instead
//   - WS keepalive (PING/PONG + ReadDeadline) reaping silently-dead clients,
//     tested at sub-second pongWait via setKeepaliveForTest (P2 from PR #48)
//   - outbound frame size bound (P3 #2)

import (
	"fmt"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

// setKeepaliveForTest swaps the package's pongWait / pingPeriod vars for the
// duration of a single test (restored via t.Cleanup). Lets a test drive the
// keepalive path in hundreds of milliseconds instead of waiting 60s of
// wall-clock. Mark the calling test as NOT t.Parallel — these are package
// vars and concurrent mutation would race.
func setKeepaliveForTest(t *testing.T, pw, pp time.Duration) {
	t.Helper()
	keepaliveMu.Lock()
	origPW, origPP := pongWait, pingPeriod
	pongWait, pingPeriod = pw, pp
	keepaliveMu.Unlock()
	t.Cleanup(func() {
		keepaliveMu.Lock()
		pongWait, pingPeriod = origPW, origPP
		keepaliveMu.Unlock()
	})
}

// joinRoom sends a ROOM_JOIN frame and drains the SNAPSHOT — the minimal flow
// to land a server-side *Conn in hub.rooms[aid]. Tests that only need the
// server-side hub bookkeeping skip the rest of the dispatch path.
func joinRoom(t *testing.T, c *websocket.Conn, aid string) {
	t.Helper()
	if err := c.WriteJSON(map[string]any{
		"schemaVersion": model.SchemaVersion,
		"type":         "ROOM_JOIN",
		"auctionId":    aid,
		"serverTimeMs": time.Now().UnixMilli(),
		"data":         map[string]any{"auctionId": aid},
	}); err != nil {
		t.Fatalf("ROOM_JOIN write: %v", err)
	}
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := c.ReadMessage(); err != nil {
		t.Fatalf("ROOM_JOIN read SNAPSHOT: %v", err)
	}
}

// connInRoom reports whether c is in hub.rooms[aid] right now.
func connInRoom(h *Hub, aid string, c *Conn) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if room := h.rooms[aid]; room != nil {
		_, ok := room[c]
		return ok
	}
	return false
}

// waitForRoomSize blocks until len(hub.rooms[aid]) >= n or d elapses.
func waitForRoomSize(t *testing.T, h *Hub, aid string, n int, d time.Duration) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		h.mu.RLock()
		got := len(h.rooms[aid])
		h.mu.RUnlock()
		if got >= n {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("hub.rooms[%s] never reached size %d within %v", aid, n, d)
}

// waitForConnGone polls hub.rooms[aid] until c is no longer a member (or until
// d elapses, returning false). Used to verify a Conn was reaped by the keepalive
// path or the force-close path.
func waitForConnGone(h *Hub, aid string, c *Conn, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if !connInRoom(h, aid, c) {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

// firstConnInRoom snapshots one *Conn from hub.rooms[aid], or nil if empty.
func firstConnInRoom(h *Hub, aid string) *Conn {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.rooms[aid] {
		return c
	}
	return nil
}

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
		"schemaVersion": model.SchemaVersion,
		"type":         "ROOM_JOIN",
		"auctionId":    "test_t5_cwc",
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

// Keepalive constants sanity: in production these are read once at handleWS /
// writePump start. A regression that flipped pingPeriod ≥ pongWait would mean
// the read deadline can trip before the next PING goes out — i.e. healthy
// clients get reaped. Cheap fail-fast guard.
func TestT5KeepaliveConstantsValid(t *testing.T) {
	pw, pp := keepaliveSnapshot()
	if pw <= 0 || pp <= 0 || pp >= pw {
		t.Fatalf("keepalive constants invalid: pongWait=%v pingPeriod=%v (need 0 < pingPeriod < pongWait)", pw, pp)
	}
	if writeWait <= 0 {
		t.Fatalf("writeWait=%v must be > 0", writeWait)
	}
	if closeFrameWait <= 0 || closeFrameWait > writeWait {
		t.Fatalf("closeFrameWait=%v out of band; want 0 < closeFrameWait <= writeWait", closeFrameWait)
	}
}

// TestT5KeepaliveReapsSilentClient — Fairy PR #48 P2.
//
// The previous behavioral test asserted "healthy client not torn down in 1.5s"
// against the production 60s pongWait, which would pass even if SetPongHandler
// or the PING ticker were misconfigured. This drives the keepalive at a
// sub-second pongWait via setKeepaliveForTest and asserts that a client which
// refuses to PONG is reaped from hub.rooms within ~pongWait, proving the read
// deadline + reap chain is actually wired.
func TestT5KeepaliveReapsSilentClient(t *testing.T) {
	testPongWait := 300 * time.Millisecond
	setKeepaliveForTest(t, testPongWait, 200*time.Millisecond)

	target, srv := startTestServer(t)
	hc := &http.Client{Timeout: 5 * time.Second}
	buyer, err := devLogin(hc, target, "T5 Silent Client", "user")
	if err != nil {
		t.Fatal(err)
	}

	c := dialRaw(t, target, buyer.Token)
	// Disable gorilla's auto-PONG: the client receives the PING but does
	// nothing, so the server's read deadline must do the reaping.
	c.SetPingHandler(func(string) error { return nil })

	aid := "test_t5_silent"
	joinRoom(t, c, aid)

	waitForRoomSize(t, srv.hub, aid, 1, 1*time.Second)
	srvConn := firstConnInRoom(srv.hub, aid)
	if srvConn == nil {
		t.Fatal("expected one server-side Conn in room after ROOM_JOIN")
	}

	// pongWait=300ms; the conn was alive at t≈50ms (the ROOM_JOIN read), so
	// the deadline trips ~250ms later. Give 4x pongWait (1.2s) of slack so
	// CI scheduling jitter doesn't false-fail.
	if !waitForConnGone(srv.hub, aid, srvConn, 4*testPongWait) {
		t.Fatalf("silent client not reaped within %v (pongWait=%v); read deadline not firing", 4*testPongWait, testPongWait)
	}
	_ = c.Close()
}

// TestT5KeepaliveHealthyClientSurvivesPastPongWait — Fairy PR #48 P2.
//
// The companion of TestT5KeepaliveReapsSilentClient: a healthy client whose
// read loop auto-PONGs the server's PING must survive past pongWait. Together
// these prove SetPongHandler is actually refreshing the deadline (silent
// dies, healthy lives).
func TestT5KeepaliveHealthyClientSurvivesPastPongWait(t *testing.T) {
	testPongWait := 300 * time.Millisecond
	setKeepaliveForTest(t, testPongWait, 200*time.Millisecond)

	target, srv := startTestServer(t)
	hc := &http.Client{Timeout: 5 * time.Second}
	buyer, err := devLogin(hc, target, "T5 Healthy Client", "user")
	if err != nil {
		t.Fatal(err)
	}

	// gorilla's default PingHandler auto-PONGs from within ReadMessage —
	// so we need a continuously-reading client loop for the PONG path to fire.
	c := dialRaw(t, target, buyer.Token)
	aid := "test_t5_healthy"
	joinRoom(t, c, aid)

	waitForRoomSize(t, srv.hub, aid, 1, 1*time.Second)
	srvConn := firstConnInRoom(srv.hub, aid)
	if srvConn == nil {
		t.Fatal("expected one server-side Conn in room after ROOM_JOIN")
	}

	readDone := make(chan struct{})
	stop := make(chan struct{})
	go func() {
		defer close(readDone)
		for {
			select {
			case <-stop:
				return
			default:
			}
			_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
			if _, _, err := c.ReadMessage(); err != nil {
				return
			}
		}
	}()
	defer func() {
		close(stop)
		_ = c.Close()
		<-readDone
	}()

	// Wait 3x pongWait (900ms). With auto-PONG the server's read deadline
	// keeps getting refreshed, so the conn must still be in hub.rooms.
	time.Sleep(3 * testPongWait)
	if !connInRoom(srv.hub, aid, srvConn) {
		t.Fatalf("healthy auto-PONG client was reaped after %v; SetPongHandler isn't refreshing the deadline", 3*testPongWait)
	}
}

// TestT5CloseWithCodeIsNetworkFree — Fairy PR #48 P1 structural test.
//
// closeWithCode runs on the broadcast goroutine under hub.RLock. The pre-fix
// implementation called ws.WriteControl(CloseMessage, …, now+writeWait) here,
// which on a congested socket would block for up to 10s — freezing the room's
// fanout to every other client.
//
// The fix moves the typed CLOSE frame to writePump's flushClose, so this
// method must never touch the network. We assert that structurally: invoke
// closeWithCode against a Conn whose ws is nil, and it must (a) return in
// microseconds without panic, (b) close c.done, (c) record code+reason for
// flushClose to consume. If a future refactor accidentally re-introduces a
// WriteControl here, the nil ws will panic and this test will fail loudly.
func TestT5CloseWithCodeIsNetworkFree(t *testing.T) {
	c := &Conn{
		send:  make(chan []byte, 1),
		lossy: make(chan []byte, 1),
		done:  make(chan struct{}),
		ws:    nil, // any network access would panic
	}

	ret := make(chan time.Duration, 1)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("closeWithCode panicked (likely touched ws): %v", r)
			}
		}()
		start := time.Now()
		c.closeWithCode(closeCodeBackpressureDrop, "backpressure")
		ret <- time.Since(start)
	}()

	select {
	case d := <-ret:
		if d > 50*time.Millisecond {
			t.Fatalf("closeWithCode took %v; broadcast under hub.RLock requires it to be non-blocking", d)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("closeWithCode did not return within 500ms; broadcast under hub.RLock would stall the room")
	}

	select {
	case <-c.done:
	default:
		t.Fatal("closeWithCode must close c.done so writePump's flushClose can run")
	}
	if c.closeCode != closeCodeBackpressureDrop {
		t.Fatalf("closeCode=%d want %d", c.closeCode, closeCodeBackpressureDrop)
	}
	if c.closeReason != "backpressure" {
		t.Fatalf("closeReason=%q want %q", c.closeReason, "backpressure")
	}
}

// TestT5BroadcastReturnsImmediatelyOnForceClose — Fairy PR #48 P1 contract
// test driven through hub.broadcast (the actual production path).
//
// Two Conns in the same room. The stalled conn's send is already full + its
// writePump isn't running, so the next broadcast triggers a trySend force-
// close on it. The healthy conn keeps a goroutine draining its send. We
// measure the broadcast call's wall-time: even with the force-close firing
// inline, broadcast must return promptly (the RLock-held loop can't wait on
// the close path) and the healthy conn must still receive the frame.
func TestT5BroadcastReturnsImmediatelyOnForceClose(t *testing.T) {
	h := newHub()
	aid := "test_t5_no_stall_hub"

	stalled := &Conn{
		send:  make(chan []byte, 1),
		lossy: make(chan []byte, 1),
		done:  make(chan struct{}),
		aid:   aid,
	}
	stalled.send <- []byte("filler") // send full → next trySend force-closes

	healthy := &Conn{
		send:  make(chan []byte, 4),
		lossy: make(chan []byte, 1),
		done:  make(chan struct{}),
		aid:   aid,
	}
	delivered := make(chan []byte, 4)
	drainStop := make(chan struct{})
	go func() {
		for {
			select {
			case <-drainStop:
				return
			case msg := <-healthy.send:
				delivered <- msg
			}
		}
	}()
	defer close(drainStop)

	h.join(aid, stalled)
	h.join(aid, healthy)

	payload := []byte(`{"type":"BROADCAST_PROBE"}`)
	start := time.Now()
	h.broadcast(aid, payload)
	elapsed := time.Since(start)

	if elapsed > 200*time.Millisecond {
		t.Fatalf("broadcast(1 frame) took %v with one stalled conn; the RLock-held loop must not block on force-close (was up to writeWait=%v pre-fix)", elapsed, writeWait)
	}

	select {
	case got := <-delivered:
		if string(got) != string(payload) {
			t.Fatalf("delivered=%q want %q", got, payload)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("healthy conn never received the broadcast — slow client may have stalled the room")
	}

	select {
	case <-stalled.done:
	default:
		t.Fatal("stalled conn should have been force-closed when its send was full")
	}
	if stalled.closeCode != closeCodeBackpressureDrop {
		t.Fatalf("stalled.closeCode=%d want %d", stalled.closeCode, closeCodeBackpressureDrop)
	}
}

// TestT5BroadcastDoesNotStallOnCongestedSocket — Fairy PR #48 P1
// "drive force-close through broadcast against a non-draining client and
// assert the broadcast to a second healthy client completes < 200ms."
//
// End-to-end variant: two real WS clients, one with SetReadBuffer(1) and
// silent (its server-side TCP send queue fills → writePump blocks in
// ws.WriteMessage → c.send fills → trySend force-closes), one healthy. We
// then time a burst of broadcasts and assert the total stays well below
// writeWait. With the pre-fix WriteControl-inside-broadcast, the first
// force-close triggered by the burst would have pinned hub.RLock for
// ~writeWait (10s) on a congested socket.
func TestT5BroadcastDoesNotStallOnCongestedSocket(t *testing.T) {
	target, srv := startTestServer(t)
	hc := &http.Client{Timeout: 5 * time.Second}

	slowAuth, err := devLogin(hc, target, "T5 Slow Buyer", "user")
	if err != nil {
		t.Fatal(err)
	}
	fastAuth, err := devLogin(hc, target, "T5 Fast Buyer", "user")
	if err != nil {
		t.Fatal(err)
	}

	aid := "test_t5_no_stall_e2e"

	slow := dialRaw(t, target, slowAuth.Token)
	if tc, ok := slow.UnderlyingConn().(*net.TCPConn); ok {
		_ = tc.SetReadBuffer(1) // shrink recv buf to force congestion fast
	}
	joinRoom(t, slow, aid)
	// slow stops reading from here on — its TCP recv buffer + the server's
	// send chan will fill under the broadcast burst.

	fast := dialRaw(t, target, fastAuth.Token)
	joinRoom(t, fast, aid)

	fastDelivered := make(chan struct{}, 4096)
	fastStop := make(chan struct{})
	go func() {
		for {
			select {
			case <-fastStop:
				return
			default:
			}
			_ = fast.SetReadDeadline(time.Now().Add(5 * time.Second))
			if _, _, err := fast.ReadMessage(); err != nil {
				return
			}
			select {
			case fastDelivered <- struct{}{}:
			default:
			}
		}
	}()
	defer func() {
		close(fastStop)
		_ = fast.Close()
		_ = slow.Close()
	}()

	waitForRoomSize(t, srv.hub, aid, 2, 2*time.Second)

	// Largest payload allowed by the production guard, so the recv buf fills
	// in a couple of frames. The exact payload doesn't matter — we just need
	// the slow socket to congest before send chan drains.
	bigData := strings.Repeat("x", maxOutboundFrameBytes/2)
	payload := []byte(fmt.Sprintf(`{"type":"BURST","data":"%s"}`, bigData))

	// Enough bursts to overflow the per-conn send chan (sendBufFrames=256)
	// plus headroom so the force-close definitely fires while we are
	// looping. With the pre-fix WriteControl-under-RLock, the broadcast
	// that triggers the force-close would have stalled the loop for
	// ~writeWait (10s); the fix returns in microseconds.
	bursts := sendBufFrames + 100
	start := time.Now()
	for i := 0; i < bursts; i++ {
		srv.hub.broadcast(aid, payload)
	}
	elapsed := time.Since(start)

	if elapsed > 2*time.Second {
		t.Fatalf("broadcast(%d frames) took %v; pre-fix WriteControl-under-RLock would stall the room up to writeWait=%v", bursts, elapsed, writeWait)
	}

	// Fast client must keep receiving — the room isn't being stalled by slow.
	select {
	case <-fastDelivered:
	case <-time.After(2 * time.Second):
		t.Fatal("fast client received zero broadcasts within 2s — broadcast may be stalled by slow client's force-close")
	}
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
