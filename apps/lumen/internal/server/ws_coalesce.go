package server

import (
	"bufio"
	"errors"
	"net"
	"net/http"
	"sync"
	"time"
)

// wsWriteBufBytes sizes the per-connection coalescing write buffer
// (docs/architecture-scaling-v10k.md §3, source [¹] "buffered writes give ~10×
// throughput"). gorilla flushes ONE TCP write per WriteMessage/WritePreparedMessage;
// at 10k connected × ~500 broadcast frames/s that is millions of write syscalls/s
// across the fleet. writePump instead drains every frame already queued into this
// buffer and flushes ONCE per batch (see Conn.coalesceDrain), collapsing a fan-out
// burst into a single syscall. 8 KiB holds ~32 of our ~250-byte envelopes, so a
// typical burst flushes once; a deeper burst auto-flushes when the buffer fills
// (still far fewer syscalls than one-per-frame). Per-conn resident cost is 8 KiB →
// ~80 MiB at 10k connected, the same order as the existing send-channel buffer
// (sendBufFrames) — well within the deploy box's GOMEMLIMIT budget.
const wsWriteBufBytes = 8 * 1024

// errNoHijack is returned when the wrapped ResponseWriter cannot be hijacked.
// Never expected in production (net/http and httptest both support Hijack); a
// typed error keeps the Upgrade failure path honest instead of panicking.
var errNoHijack = errors.New("server: ResponseWriter does not support Hijack")

// bufferedConn wraps the hijacked WebSocket net.Conn with a flush-on-demand
// write buffer so writePump can coalesce a burst of frames into one TCP write.
// Reads and connection control (SetDeadline / Close / addrs) pass straight
// through to the embedded net.Conn; only Write is buffered, and Flush drains the
// batch to the socket.
//
// Concurrency. gorilla serializes every frame write to the underlying conn
// behind its own internal c.mu (conn.go: both c.write and WriteControl hold it
// across the whole net.Conn.Write), so complete frames never interleave at this
// layer. But writePump calls Flush OUTSIDE gorilla's lock, and gorilla can issue
// control-frame writes (auto-PONG, CLOSE echo) from the READ goroutine, so a
// Write and a Flush can run concurrently. A bufio.Writer is not goroutine-safe,
// so the mutex below guards Write-vs-Flush (and Write-vs-Write, redundantly but
// cheaply). It cannot deadlock with gorilla's c.mu: Flush takes only b.mu, while
// the gorilla write path takes c.mu then b.mu — there is no opposite ordering.
type bufferedConn struct {
	net.Conn
	mu sync.Mutex
	bw *bufio.Writer
}

// newBufferedConn wraps c so writes accumulate in a `size`-byte buffer that is
// flushed explicitly by writePump (or auto-flushed by bufio when it fills). The
// bufio.Writer targets the RAW conn `c`, not the bufferedConn, so Flush writes
// straight to the socket with no recursion.
func newBufferedConn(c net.Conn, size int) *bufferedConn {
	return &bufferedConn{Conn: c, bw: bufio.NewWriterSize(c, size)}
}

// Write buffers p (shadowing the embedded net.Conn.Write). gorilla calls this
// for the 101 handshake response and for every frame; nothing reaches the socket
// until Flush (or a buffer-full auto-flush). Buffering is byte-stream, NOT
// frame-aware: when p would overflow the buffer, bufio.Writer fills the remaining
// space with a prefix of p and auto-flushes, so one socket write (syscall) can end
// mid-frame. That is harmless over TCP — the peer reassembles the stream and parses
// frames by their length headers no matter how bytes were chunked into writes. The
// invariant this layer guarantees is byte ORDER (via b.mu, plus gorilla's c.mu
// serializing each whole frame into this Write); frame-boundary alignment of flushes
// is explicitly NOT promised, only that coalescing collapses the common burst into
// far fewer syscalls than one-per-frame (codex review LOW).
func (b *bufferedConn) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.bw.Write(p)
}

// Flush writes the coalesced batch to the underlying conn as a single write.
// A nil/empty buffer flush is a cheap no-op. Production code flushes via
// flushWithDeadline (below); plain Flush stays for the deadline-free unit tests.
func (b *bufferedConn) Flush() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.bw.Flush()
}

// flushWithDeadline sets the underlying write deadline AND flushes the batch
// under ONE b.mu hold, so the intended deadline governs the entire socket write
// and cannot be re-armed by a concurrent control-frame SetWriteDeadline between
// the set and the flush. Every production flush site (writePump batch flush,
// handshake, ping handler, close) uses this so each flush is hard-bounded.
func (b *bufferedConn) flushWithDeadline(t time.Time) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	_ = b.Conn.SetWriteDeadline(t) // embedded conn, NOT the override below (no re-lock)
	return b.bw.Flush()
}

// SetWriteDeadline serializes the underlying-conn write-deadline update with
// Write/Flush via b.mu. gorilla's c.write and WriteControl both call
// SetWriteDeadline on the conn immediately before writing; without this lock a
// control-frame deadline update from the READ goroutine (auto-PONG / our PING
// handler / CLOSE echo) could re-arm the deadline of a write ALREADY in flight
// inside a concurrent Flush. A client that streams PINGs while never reading
// could then push that deadline forward indefinitely, so the "one in-flight
// write" outlives writeWait, the force-close `done` can't be observed, and
// flushClose can't apply closeFrameWait (codex review HIGH). Holding b.mu makes
// any deadline change wait for an in-flight flush to finish first; combined with
// flushWithDeadline, every flush runs under a deadline that can't be mutated
// mid-write. No deadlock with gorilla's c.mu: this and Flush take only b.mu,
// while the gorilla write path takes c.mu then b.mu — never the reverse.
func (b *bufferedConn) SetWriteDeadline(t time.Time) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.Conn.SetWriteDeadline(t)
}

// SetDeadline likewise serializes the (write-affecting) deadline update. Only
// gorilla's Upgrade calls it — to clear deadlines, before any writePump/read
// goroutine exists — but guarding it keeps the invariant total.
func (b *bufferedConn) SetDeadline(t time.Time) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.Conn.SetDeadline(t)
}

// coalescingUpgradeWriter wraps the http.ResponseWriter passed to
// websocket.Upgrader.Upgrade so the net.Conn gorilla hijacks for the WS session
// is our bufferedConn. Upgrade obtains the raw conn via Hijack(); we wrap it and
// publish the *bufferedConn through `out` so the Conn/writePump can flush the
// coalesced batch. Every other ResponseWriter method delegates to the embedded
// writer — gorilla only touches Header()/WriteHeader()/Write() on the
// upgrade-FAILURE path (before Hijack), so plain delegation suffices.
type coalescingUpgradeWriter struct {
	http.ResponseWriter
	out **bufferedConn
}

// Hijack returns the bufferedConn-wrapped network connection plus the original
// buffered reader/writer. gorilla writes the 101 response and all frames through
// the returned net.Conn, so wrapping it here is what makes writes coalesce.
func (w *coalescingUpgradeWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hj, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errNoHijack
	}
	conn, brw, err := hj.Hijack()
	if err != nil {
		return nil, nil, err
	}
	bc := newBufferedConn(conn, wsWriteBufBytes)
	*w.out = bc
	return bc, brw, nil
}
