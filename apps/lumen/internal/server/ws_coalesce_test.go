package server

import (
	"bufio"
	"bytes"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Tests for the write-coalescing buffered conn + writePump batching
// (docs/architecture-scaling-v10k.md §3 "buffered writes"). These are
// dependency-free (no Redis/MySQL) — they exercise the gorilla write path over
// a real loopback socket via httptest, so they run in plain `go test`.

// countingConn is a passthrough net.Conn that counts Write calls (= socket
// writes / flushes) and optionally gates each write behind a token so a test
// can deterministically control when writePump's flush reaches the wire. It
// embeds the real hijacked conn, so reads/deadlines/close all pass through and a
// real WS client on the other end still receives every frame.
type countingConn struct {
	net.Conn
	mu      sync.Mutex
	writes  int
	armed   bool
	blocked chan struct{} // signalled right before a gated write blocks
	gate    chan struct{} // one token releases one gated write
}

func (c *countingConn) Write(p []byte) (int, error) {
	c.mu.Lock()
	armed := c.armed
	c.mu.Unlock()
	if armed {
		c.blocked <- struct{}{} // tell the test we're about to write to the socket
		<-c.gate                // wait for the test to release this write
	}
	c.mu.Lock()
	c.writes++
	c.mu.Unlock()
	return c.Conn.Write(p)
}

// arm switches on gating and resets the write counter so the test counts only
// post-handshake socket writes.
func (c *countingConn) arm() {
	c.mu.Lock()
	c.armed = true
	c.writes = 0
	c.mu.Unlock()
}

func (c *countingConn) writeCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.writes
}

// countingUpgradeWriter is the test twin of coalescingUpgradeWriter: it inserts
// a countingConn between the hijacked socket and the bufio buffer so a test can
// observe the actual number of socket writes the coalescing produces.
type countingUpgradeWriter struct {
	http.ResponseWriter
	bc      **bufferedConn
	counter **countingConn
	size    int
}

func (w *countingUpgradeWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hj, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errNoHijack
	}
	conn, brw, err := hj.Hijack()
	if err != nil {
		return nil, nil, err
	}
	cc := &countingConn{Conn: conn, blocked: make(chan struct{}), gate: make(chan struct{})}
	*w.counter = cc
	bc := newBufferedConn(cc, w.size)
	*w.bc = bc
	return bc, brw, nil
}

func TestBufferedConnCoalescesWrites(t *testing.T) {
	cc := &countingConn{Conn: nopConn{}}
	bc := newBufferedConn(cc, wsWriteBufBytes)

	const frames = 10
	for i := 0; i < frames; i++ {
		if _, err := bc.Write([]byte("frame")); err != nil {
			t.Fatalf("buffered write %d: %v", i, err)
		}
	}
	// Nothing should have reached the socket yet — all 10 writes sit in the buffer.
	if got := cc.writeCount(); got != 0 {
		t.Fatalf("buffered writes leaked to socket before flush: %d socket writes (want 0)", got)
	}
	if err := bc.Flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	// The flush collapses all 10 buffered frames into ONE socket write.
	if got := cc.writeCount(); got != 1 {
		t.Fatalf("flush produced %d socket writes, want 1 (coalesced)", got)
	}
}

func TestBufferedConnAutoFlushesWhenBufferFull(t *testing.T) {
	cc := &countingConn{Conn: nopConn{}}
	const size = 64
	bc := newBufferedConn(cc, size)

	chunk := bytes.Repeat([]byte("x"), 50)
	if _, err := bc.Write(chunk); err != nil { // 50 ≤ 64 → buffered, no socket write
		t.Fatal(err)
	}
	if got := cc.writeCount(); got != 0 {
		t.Fatalf("first write should buffer, got %d socket writes", got)
	}
	if _, err := bc.Write(chunk); err != nil { // 50+50 > 64 → bufio auto-flushes
		t.Fatal(err)
	}
	if got := cc.writeCount(); got == 0 {
		t.Fatal("buffer overflow did not trigger an auto-flush (frame would be lost on a real socket)")
	}
}

// TestWritePumpCoalescesBurstIntoFewWrites is the end-to-end proof: a burst of
// many critical frames is delivered to a real WS client intact and in order,
// while the coalescing buffer collapses the burst into TWO socket writes (frame
// 0, then frames 1..N-1 batched) instead of N. The gate makes the batching
// deterministic rather than scheduler-dependent.
func TestWritePumpCoalescesBurstIntoFewWrites(t *testing.T) {
	const n = 100 // n small frames ≪ wsWriteBufBytes, so the batch is one flush
	connCh := make(chan *Conn, 1)
	counterCh := make(chan *countingConn, 1)

	handler := func(w http.ResponseWriter, r *http.Request) {
		up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
		var bc *bufferedConn
		var counter *countingConn
		ws, err := up.Upgrade(&countingUpgradeWriter{ResponseWriter: w, bc: &bc, counter: &counter, size: wsWriteBufBytes}, r, nil)
		if err != nil {
			return
		}
		if err := bc.Flush(); err != nil { // 101 handshake (ungated, armed=false)
			return
		}
		counter.arm() // start gating + counting from here
		c := &Conn{
			ws:         ws,
			wbuf:       bc,
			crit:       make(chan outboundFrame, sendBufFrames),
			lossy:      make(chan []byte, 16),
			done:       make(chan struct{}),
			pingPeriod: time.Hour, // suppress keepalive PINGs during the test
		}
		go c.writePump()
		connCh <- c
		counterCh <- counter
		for { // drain client reads until it disconnects, then tear down
			if _, _, err := ws.ReadMessage(); err != nil {
				c.close()
				return
			}
		}
	}
	ts := httptest.NewServer(http.HandlerFunc(handler))
	defer ts.Close()

	cli, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(ts.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer cli.Close()

	c := <-connCh
	counter := <-counterCh

	waitBlocked := func(stage string) {
		t.Helper()
		select {
		case <-counter.blocked:
		case <-time.After(3 * time.Second):
			t.Fatalf("writePump never reached the gated socket write (%s)", stage)
		}
	}

	// Enqueue frame 0, wait for writePump to park at the socket write of its flush.
	c.trySend([]byte(`{"i":0}`))
	waitBlocked("frame 0")
	// While writePump is parked, enqueue the rest of the burst — they pile up in
	// the send lane and will be drained together on the next iteration.
	for i := 1; i < n; i++ {
		c.trySend([]byte(fmt.Sprintf(`{"i":%d}`, i)))
	}
	counter.gate <- struct{}{} // release write #1 (frame 0 alone)
	waitBlocked("coalesced batch")
	counter.gate <- struct{}{} // release write #2 (frames 1..N-1, coalesced)

	// The client must receive ALL n frames, in order, intact — coalescing batches
	// TCP writes but preserves one WS frame per message.
	_ = cli.SetReadDeadline(time.Now().Add(5 * time.Second))
	for i := 0; i < n; i++ {
		_, msg, err := cli.ReadMessage()
		if err != nil {
			t.Fatalf("client read frame %d/%d: %v", i, n, err)
		}
		if want := fmt.Sprintf(`{"i":%d}`, i); string(msg) != want {
			t.Fatalf("frame %d = %q, want %q (coalescing reordered or corrupted the stream)", i, msg, want)
		}
	}

	if got := counter.writeCount(); got != 2 {
		t.Fatalf("burst of %d frames took %d socket writes, want 2 (coalescing collapsed the batch)", n, got)
	}
}

// TestWSServerFlushesPongPromptly guards the coalescing-specific hazard that a
// client-initiated PING's auto-PONG (written by the read goroutine into the
// coalescing buffer) could sit unflushed until writePump's next frame or PING
// tick (~pingPeriod). It drives the REAL handleWS path: send a client PING with
// no other traffic and assert the PONG comes back within a few seconds, well
// under the server's ~54s pingPeriod. Without the flush-aware ping handler this
// times out. Needs the WS harness (real Redis/MySQL); skips otherwise.
func TestWSServerFlushesPongPromptly(t *testing.T) {
	target, _ := startTestServer(t)
	hc := &http.Client{Timeout: 5 * time.Second}
	buyer, err := devLogin(hc, target, "Pong Flush Buyer", "user")
	if err != nil {
		t.Fatal(err)
	}
	c := dialRaw(t, target, buyer.Token)
	defer c.Close()

	gotPong := make(chan struct{}, 1)
	c.SetPongHandler(func(string) error {
		select {
		case gotPong <- struct{}{}:
		default:
		}
		return nil
	})
	// Drive ReadMessage so gorilla processes the incoming PONG control frame.
	go func() {
		for {
			if _, _, err := c.ReadMessage(); err != nil {
				return
			}
		}
	}()
	if err := c.WriteControl(websocket.PingMessage, []byte("hi"), time.Now().Add(2*time.Second)); err != nil {
		t.Fatalf("client ping: %v", err)
	}
	select {
	case <-gotPong:
	case <-time.After(4 * time.Second):
		t.Fatal("server did not return a PONG within 4s — auto-PONG stranded in the coalescing buffer (idle writePump)?")
	}
}

// TestCoalesceDrainAbortsOnDone proves the per-frame done check (codex review
// HIGH): once the conn is closing, coalesceDrain must stop immediately rather
// than grind a large queued backlog out to a (possibly slow) peer and pin
// writePump for many writeWait windows after the force-close already fired. With
// done already closed it returns false having drained NOTHING — the leading done
// check fires before any c.write, so this needs no real socket.
func TestCoalesceDrainAbortsOnDone(t *testing.T) {
	c := &Conn{
		wbuf:  newBufferedConn(nopConn{}, wsWriteBufBytes),
		crit:  make(chan outboundFrame, sendBufFrames),
		lossy: make(chan []byte, 16),
		done:  make(chan struct{}),
	}
	const backlog = 500 // < sendBufFrames, so all fit; > maxDrainFrames either way
	for i := 0; i < backlog; i++ {
		c.crit <- outboundFrame{raw: []byte("x")}
	}
	close(c.done) // conn force-closed while a big backlog is still queued

	if c.coalesceDrain() {
		t.Fatal("coalesceDrain returned true with done closed; want false so writePump exits to flushClose")
	}
	if remaining := len(c.crit); remaining != backlog {
		t.Fatalf("coalesceDrain drained %d frames after done closed; want 0 (must abort before writing to a closing conn)", backlog-remaining)
	}
}

// TestBufferedConnSerializesDeadlineWithFlush proves the deadline-serialization
// fix (codex review HIGH): while a Flush holds b.mu mid-write, a concurrent
// SetWriteDeadline (as gorilla issues from the read goroutine on a control
// frame) MUST block until the flush finishes — otherwise it could re-arm the
// in-flight write's deadline and let a PING-spamming non-reader outlive writeWait.
func TestBufferedConnSerializesDeadlineWithFlush(t *testing.T) {
	bc := newBufferedConn(&blockingConn{entered: make(chan struct{}, 1), gate: make(chan struct{})}, 64)
	if _, err := bc.Write([]byte("x")); err != nil { // buffered, so Flush does a real write
		t.Fatal(err)
	}
	bcRaw := bc.Conn.(*blockingConn)

	flushed := make(chan struct{})
	go func() { _ = bc.Flush(); close(flushed) }() // takes b.mu, blocks in blockingConn.Write
	<-bcRaw.entered                                // Flush is now inside the raw write, holding b.mu

	deadlineReturned := make(chan struct{})
	go func() { _ = bc.SetWriteDeadline(time.Now().Add(time.Hour)); close(deadlineReturned) }()
	select {
	case <-deadlineReturned:
		t.Fatal("SetWriteDeadline returned while a Flush held b.mu — deadline could be re-armed mid-write")
	case <-time.After(150 * time.Millisecond): // good: serialized behind the in-flight flush
	}

	close(bcRaw.gate) // let the flush's write complete + release b.mu
	<-flushed
	select {
	case <-deadlineReturned:
	case <-time.After(2 * time.Second):
		t.Fatal("SetWriteDeadline did not proceed after the Flush released b.mu")
	}
}

// blockingConn is a net.Conn whose Write signals once (entered) then blocks until
// gate is closed — lets a test pin a Flush inside the raw write to probe locking.
type blockingConn struct {
	nopConn
	entered chan struct{}
	gate    chan struct{}
}

func (b *blockingConn) Write(p []byte) (int, error) {
	select {
	case b.entered <- struct{}{}:
	default:
	}
	<-b.gate
	return len(p), nil
}

// TestCoalesceDrainEmitsBroadcastsBeforeAck proves the cross-lane ordering fix
// (codex review HIGH): the single critical lane must preserve FIFO ENQUEUE order
// across BOTH raw frames (ROOM_SNAPSHOT, catchup, direct ack) AND prepared
// broadcasts — so a just-joined client's snapshot is never overtaken by a newer
// room broadcast, and an ack never overtakes the older broadcasts queued before
// it. The client drops seq<=lastSeq and ROOM_SNAPSHOT resets lastSeq, so any
// reorder loses or regresses events. Interleaves raw + prepared on `crit` and
// asserts the wire order equals the enqueue order. Drives coalesceDrain directly
// (writePump not started, so the test goroutine is the sole writer).
func TestCoalesceDrainPreservesEnqueueOrder(t *testing.T) {
	connCh := make(chan *Conn, 1)
	handler := func(w http.ResponseWriter, r *http.Request) {
		up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
		var bc *bufferedConn
		ws, err := up.Upgrade(&coalescingUpgradeWriter{ResponseWriter: w, out: &bc}, r, nil)
		if err != nil {
			return
		}
		_ = bc.Flush() // 101 handshake
		c := &Conn{
			ws:         ws,
			wbuf:       bc,
			crit:       make(chan outboundFrame, 8),
			lossy:      make(chan []byte, 8),
			done:       make(chan struct{}),
			pingPeriod: time.Hour,
		}
		connCh <- c
		for { // keep the conn alive; no writePump (the test drives coalesceDrain)
			if _, _, err := ws.ReadMessage(); err != nil {
				c.close()
				return
			}
		}
	}
	ts := httptest.NewServer(http.HandlerFunc(handler))
	defer ts.Close()
	cli, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(ts.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer cli.Close()
	c := <-connCh

	// Enqueue a realistic interleaving on the ONE lane: a raw ROOM_SNAPSHOT, then
	// two prepared broadcasts, then a raw direct ack — exactly the mix that the
	// old two-lane split could reorder. FIFO must keep them in this order.
	pm11, _ := websocket.NewPreparedMessage(websocket.TextMessage, []byte(`{"seq":11}`))
	pm12, _ := websocket.NewPreparedMessage(websocket.TextMessage, []byte(`{"seq":12}`))
	c.crit <- outboundFrame{raw: []byte(`{"seq":10}`)} // ROOM_SNAPSHOT (raw)
	c.crit <- outboundFrame{pm: pm11}                  // broadcast (prepared)
	c.crit <- outboundFrame{pm: pm12}                  // broadcast (prepared)
	c.crit <- outboundFrame{raw: []byte(`{"seq":13}`)} // direct ack (raw)
	if !c.coalesceDrain() {
		t.Fatal("coalesceDrain returned false")
	}
	if !c.flush() {
		t.Fatal("flush returned false")
	}

	_ = cli.SetReadDeadline(time.Now().Add(5 * time.Second))
	for i, want := range []string{`{"seq":10}`, `{"seq":11}`, `{"seq":12}`, `{"seq":13}`} {
		_, msg, err := cli.ReadMessage()
		if err != nil {
			t.Fatalf("read frame %d: %v", i, err)
		}
		if string(msg) != want {
			t.Fatalf("frame %d = %q, want %q (single lane must preserve enqueue order across raw+prepared)", i, msg, want)
		}
	}
}

// TestJoinBarrierBuffersLiveBroadcasts proves the ROOM_JOIN barrier (codex review
// HIGH): while a conn is joining, live room broadcasts must be BUFFERED (not raced
// onto crit ahead of the init frames), then spliced in AFTER catchup/snapshot in
// arrival order; once live, broadcasts go straight to crit. Pure-channel unit test
// (no socket): trySend (init/direct) → crit; trySendPrepared (broadcast) → pending
// while joining, crit after.
func TestJoinBarrierBuffersLiveBroadcasts(t *testing.T) {
	c := &Conn{crit: make(chan outboundFrame, 16), done: make(chan struct{}), aid: "auc_jb"}

	c.beginJoinBarrier() // joining = true
	c.trySend([]byte(`{"seq":10}`)) // catchup  → crit (direct, not buffered)
	c.trySend([]byte(`{"seq":11}`)) // snapshot → crit
	pm12, _ := websocket.NewPreparedMessage(websocket.TextMessage, []byte(`{"seq":12}`))
	c.trySendPrepared("auc_jb", pm12) // live broadcast DURING join → buffered

	if got := len(c.crit); got != 2 {
		t.Fatalf("during join, crit has %d frames; want 2 (init only — the live broadcast must buffer)", got)
	}
	if got := len(c.pending); got != 1 {
		t.Fatalf("during join, pending has %d; want 1 buffered broadcast", got)
	}

	c.spliceAndGoLive() // splice pending → crit (after init), joining = false
	if got := len(c.crit); got != 3 {
		t.Fatalf("after splice, crit has %d; want 3 (2 init + 1 spliced broadcast)", got)
	}

	pm13, _ := websocket.NewPreparedMessage(websocket.TextMessage, []byte(`{"seq":13}`))
	c.trySendPrepared("auc_jb", pm13) // post-join broadcast → straight to crit
	if got := len(c.crit); got != 4 {
		t.Fatalf("post-join broadcast: crit has %d; want 4 (delivered live, not buffered)", got)
	}

	// Wire order must be: raw 10, raw 11 (init), then prepared 12, prepared 13.
	for i, want := range []string{`{"seq":10}`, `{"seq":11}`} {
		f := <-c.crit
		if f.raw == nil || string(f.raw) != want {
			t.Fatalf("crit[%d] = raw %q (pm=%v), want raw %q", i, f.raw, f.pm != nil, want)
		}
	}
	for i := 0; i < 2; i++ { // 12 then 13 — prepared, opaque, just confirm they're prepared
		f := <-c.crit
		if f.pm == nil {
			t.Fatalf("crit broadcast frame %d is not a prepared frame", i)
		}
	}
}

// TestJoinBarrierRaceClean hammers the barrier's concurrency: many fan-out
// broadcasters calling enqueueBroadcast WHILE another goroutine cycles
// beginJoinBarrier → trySend(init) → spliceAndGoLive. Run under `go test -race`
// it validates pendMu / joining / pending have no data race and the
// double-checked locking is sound. A drainer empties crit so enqueues don't
// force-close mid-run. No socket (channel/pending only).
func TestJoinBarrierRaceClean(t *testing.T) {
	c := &Conn{crit: make(chan outboundFrame, sendBufFrames), done: make(chan struct{}), aid: "auc_jbr"}
	stop := make(chan struct{})
	go func() {
		for {
			select {
			case <-stop:
				return
			case <-c.crit:
			}
		}
	}()

	pm, _ := websocket.NewPreparedMessage(websocket.TextMessage, []byte(`{"x":1}`))
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 1000; j++ {
				c.trySendPrepared("auc_jbr", pm) // fan-out broadcast (enqueueBroadcast)
			}
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for j := 0; j < 500; j++ {
			c.beginJoinBarrier()
			c.trySend([]byte(`{"init":1}`))
			c.spliceAndGoLive()
		}
	}()
	wg.Wait()
	close(stop)
}

// nopConn is a no-op net.Conn for the pure-buffer unit tests (no real socket).
type nopConn struct{}

func (nopConn) Read([]byte) (int, error)         { return 0, nil }
func (nopConn) Write(p []byte) (int, error)      { return len(p), nil }
func (nopConn) Close() error                     { return nil }
func (nopConn) LocalAddr() net.Addr              { return nopAddr{} }
func (nopConn) RemoteAddr() net.Addr             { return nopAddr{} }
func (nopConn) SetDeadline(time.Time) error      { return nil }
func (nopConn) SetReadDeadline(time.Time) error  { return nil }
func (nopConn) SetWriteDeadline(time.Time) error { return nil }

type nopAddr struct{}

func (nopAddr) Network() string { return "nop" }
func (nopAddr) String() string  { return "nop" }
