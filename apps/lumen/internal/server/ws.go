package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/auth"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/metrics"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

// maxWSFrameBytes bounds an inbound WS frame (§8 WS hardening). Client messages
// are a few hundred bytes; 32 KiB is generous headroom without inviting abuse.
const maxWSFrameBytes = 32 * 1024

// maxClientBidIDLen bounds the client-supplied idempotency key. It becomes a
// Redis hash field name in the dedupe Hash, so cap it well below the frame limit.
const maxClientBidIDLen = 128

// catchupMaxGap is the largest ROOM_JOIN lastSeq delta replayed from the Stream;
// past it the client gets a snapshot instead (cheaper than a huge replay).
const catchupMaxGap = 200

// sendBufFrames sizes the per-conn CRITICAL lane. It MUST exceed catchupMaxGap
// so a full Stream replay into the buffer never trips the trySend force-close
// before writePump can drain — the catchup case is exactly the one where the
// client may be slow (just-reconnected, possibly high-RTT), and force-closing
// it would re-enter the reconnect loop the catchup is meant to break.
const sendBufFrames = 256
const schemaMismatchCloseCode = 4001

// fanoutSweepInterval is the backstop cadence for Stream-driven broadcast (a lost
// Pub/Sub wakeup can't permanently stall the room).
const fanoutSweepInterval = 2 * time.Second

// pongWait is the deadline on an inbound PONG; if the client doesn't reply
// within the window the server reads time-out and the read goroutine exits
// (defer hub.leave + close fire promptly). Without this the OS-level TCP
// timeout runs ~2h on Linux, which leaks one read + one writePump goroutine
// AND keeps the conn in hub.rooms for every silently-dead mobile/NAT/sleep
// client. 60s matches the gorilla/websocket example default — long enough
// to absorb a normal mobile NAT hop, short enough for prompt cleanup.
//
// pongWait/pingPeriod are vars (not consts) so tests can drive sub-second
// reaping without waiting 60s of wall-clock; production reads them once at
// connection time. Mutate only via setKeepaliveForTest under t.Cleanup —
// production callers MUST NOT change these.
var (
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10
)

// writeWait bounds writePump's per-frame data and PING writes. The typed
// CLOSE frame uses the tighter closeFrameWait below — see flushClose.
const writeWait = 10 * time.Second

// closeFrameWait bounds the typed-CLOSE WriteControl emitted from flushClose.
// Kept tight (vs. writeWait) so writePump's exit path can't park for 10s on a
// hung socket — the close frame is best-effort: if it can't land in this
// window, the immediately-following ws.Close() races to RST and the client
// surfaces a generic read error instead of a typed code 4000. The frame is
// ~12 bytes so this is generous on any healthy socket.
const closeFrameWait = 1 * time.Second

// closeCodeBackpressureDrop is the application-level close code emitted when
// trySend force-closes a slow client. WS spec reserves 4000-4999 for app use
// (RFC 6455 §7.4.2). Distinguishes a server-initiated backpressure drop from
// a raw network failure so a thin client can back off + ROOM_SNAPSHOT instead
// of tight-looping into another force-close.
const closeCodeBackpressureDrop = 4000

// maxOutboundFrameBytes bounds the size of any server-emitted WS frame.
// Today's frames are small (BID_ACCEPTED ~200B, ROOM_SNAPSHOT ~150B); the
// bound is defensive against a future contributor pushing a large event
// payload (e.g. an evidence-card timeline push) — get a logged fail-fast
// rather than weird socket behavior.
const maxOutboundFrameBytes = 32 * 1024

// streamIDForSeq returns the XRANGE-exclusive lower bound for "events after seq".
func streamIDForSeq(seq int64) string { return fmt.Sprintf("%d-0", seq) }

func eventsUpToSnapshot(events []store.StreamEvent, snapshotSeq int64) []store.StreamEvent {
	out := make([]store.StreamEvent, 0, len(events))
	for _, e := range events {
		if e.Seq <= snapshotSeq {
			out = append(out, e)
		}
	}
	return out
}

// Hub tracks room membership and fans out broadcasts. The bid path is decoupled
// from the broadcast path via Redis Pub/Sub (subscribe), so adding gateways at
// T5 needs no re-plumbing.
type Hub struct {
	mu    sync.RWMutex
	rooms map[string]map[*Conn]struct{}
}

func newHub() *Hub { return &Hub{rooms: make(map[string]map[*Conn]struct{})} }

func (h *Hub) join(aid string, c *Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.rooms[aid] == nil {
		h.rooms[aid] = make(map[*Conn]struct{})
	}
	h.rooms[aid][c] = struct{}{}
}

func (h *Hub) leave(c *Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if c.aid != "" && h.rooms[c.aid] != nil {
		delete(h.rooms[c.aid], c)
		// Drop the room entry once it's empty so roomAIDs() / the fanout sweep
		// don't keep scheduling work for zero-client rooms. Broadcasts to an
		// empty room were already no-ops; this is read-side bookkeeping that
		// also bounds map growth as auctions cycle through their lifetimes.
		if len(h.rooms[c.aid]) == 0 {
			delete(h.rooms, c.aid)
		}
	}
}

func (h *Hub) broadcast(aid string, msg []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.rooms[aid] {
		// critical room events: enqueue or drop the slow client (it reconnects +
		// re-snapshots) rather than silently lose the event. close() defers the
		// hub.leave to the read goroutine, so it can't deadlock under this RLock.
		c.trySend(msg)
	}
}

// roomAIDs snapshots the auction ids with at least one connection.
func (h *Hub) roomAIDs() []string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	aids := make([]string, 0, len(h.rooms))
	for aid := range h.rooms {
		aids = append(aids, aid)
	}
	return aids
}

// subscribe drives room broadcast from the **canonical Redis Stream**. Pub/Sub is
// only a wakeup hint (RFC v2: non-authoritative) — on a hint, or on a periodic
// backstop tick, the gateway reads the Stream from the room's last-broadcast seq
// and fans out those events. A forged/stale Pub/Sub message not backed by the
// Stream therefore can never reach clients. Runs for the lifetime of ctx in a
// single goroutine (lastSeq needs no lock).
// T8 instrumentation: each fanout records broadcast latency (now - payload
// serverTimeMs, the Lua-authoritative Redis TIME at adjudication) and detects
// seq gaps against the prior lastSeq. Stream length is sampled on the backstop
// ticker so the gauge tracks the peak even under bursty traffic. auctioneer/m may
// be nil in unit tests that wire paths without those dependencies.
func (h *Hub) subscribe(ctx context.Context, st *store.Store, auctioneer *AuctioneerHooks, m *metrics.Registry) {
	ps := st.Redis().PSubscribe(ctx, store.PubPattern)
	defer func() { _ = ps.Close() }()
	ch := ps.Channel() // create once; go-redis starts a delivery goroutine here

	lastSeq := make(map[string]int64)
	fanout := func(aid string) {
		events, _, err := st.ReadEventsAfter(ctx, aid, streamIDForSeq(lastSeq[aid]))
		if err != nil {
			log.Printf("fanout read %s: %v", aid, err)
			return
		}
		for _, e := range events {
			// T8 §4.1 seq-gap detector: under healthy operation lastSeq advances by
			// exactly 1 per event (Lua-monotonic, no parallel writer). A jump > 1
			// after a successful read is a correctness break — record the magnitude
			// (not just "did it happen") so the load report can quantify the gap.
			// lastSeq==0 with a non-1 start means we joined a pre-existing stream
			// → not a gap (mid-room subscriber, no missed event).
			if m != nil && lastSeq[aid] > 0 && e.Seq > lastSeq[aid]+1 {
				m.SeqGap.Add(e.Seq - lastSeq[aid] - 1)
			}
			env := model.Envelope{
				Type: e.Type, AuctionID: aid, Seq: e.Seq,
				ServerTimeMs: time.Now().UnixMilli(), Data: json.RawMessage(e.Payload),
			}
			b, err := json.Marshal(env)
			if err != nil {
				// Corrupt Stream payload (e.g. a non-UTF-8 byte from a future
				// contributor's event type that breaks json.RawMessage round-trip):
				// surface in the log and SKIP the broadcast rather than fan out a
				// zero-byte / nil frame to every client in the room. The next sweep
				// re-reads the same Stream window so a transient marshal error gets
				// another chance; a persistent one shows up as a tight log loop.
				log.Printf("fanout marshal %s seq=%d type=%s: %v", aid, e.Seq, e.Type, err)
				continue
			}
			h.broadcast(aid, b)
			if m != nil {
				// Broadcast latency = wall-clock now - payload.serverTimeMs (Lua TIME
				// at adjudication). Use a typed unmarshal of the small "serverTimeMs"
				// field rather than parse the full payload — the event payloads share
				// this field across BID_ACCEPTED / AUCTION_EXTENDED / AUCTION_SOLD /
				// AUCTION_NO_BID / AUCTION_CANCELLED. Failing to unmarshal (e.g. an
				// older event that predates the field) silently skips the observation,
				// which is the correct behaviour: no fake zero in p50.
				if ts := eventServerTimeMs(e.Payload); ts > 0 {
					m.BroadcastLatency.Observe(time.Since(time.UnixMilli(ts)))
				}
			}
			lastSeq[aid] = e.Seq
			// T7 §4.2: feed the auctioneer trigger detectors. nil-safe
			// for legacy paths (test harness, alt-mode startup) that
			// don't initialize the hooks. Bid path NEVER awaits these
			// (each method dispatches via `go a.fire(...)` internally).
			if auctioneer != nil {
				dispatchAuctioneer(ctx, auctioneer, aid, st, e)
			}
		}
	}

	// Stream-length sampler: XLEN is O(1) Redis-side but each call costs an RTT,
	// so we sample on the backstop ticker (every 2 s) NOT on every Pub/Sub hint
	// — at 500 bids/s the per-event sampling would mean ~500 XLEN RTTs/s. The
	// gauge tracks the peak (ObserveStreamLen is monotonic), so a 2 s cadence
	// is sufficient resolution to catch a backlog buildup without burning Redis.
	sampleStreamLens := func() {
		if m == nil {
			return
		}
		for _, aid := range h.roomAIDs() {
			if n, err := st.StreamLen(ctx, aid); err == nil {
				m.ObserveStreamLen(n)
			}
		}
	}

	ticker := time.NewTicker(fanoutSweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			for _, aid := range h.roomAIDs() { // backstop: independent of Pub/Sub delivery
				fanout(aid)
			}
			sampleStreamLens()
		case msg, ok := <-ch:
			if !ok {
				return
			}
			if aid := store.AIDFromPubChannel(msg.Channel); aid != "" {
				fanout(aid) // wakeup hint: read + broadcast the authoritative Stream
			}
		}
	}
}

// eventServerTimeMs extracts the optional "serverTimeMs" field from a Lua-authored
// payload (cjson output). All hot-path payloads include it (model.BidAcceptedData
// etc.); returns 0 on any decode/missing-field condition so the caller can skip
// the observation without poisoning percentiles.
func eventServerTimeMs(payload string) int64 {
	var probe struct {
		ServerTimeMs int64 `json:"serverTimeMs"`
	}
	if err := json.Unmarshal([]byte(payload), &probe); err != nil {
		return 0
	}
	return probe.ServerTimeMs
}

// Conn is one WS client connection with a serialized write pump and a two-lane
// send (T5 backpressure channel split):
//   - `send`  — CRITICAL frames (bid acks, AUCTION_* terminals, ROOM_SNAPSHOT,
//     catchup). Must be delivered; if the buffer fills, the connection is
//     force-closed so the client reconnects and re-syncs (never a silent loss).
//   - `lossy` — BEST-EFFORT frames (PONG heartbeat; future presence/chat). Dropped
//     individually when full, without tearing down the connection.
//
// Shutdown is signalled by closing `done` (once); the send channels are never
// closed, so concurrent senders (direct ack + Pub/Sub broadcast) can't panic on a
// closed channel.
type Conn struct {
	ws          *websocket.Conn
	send        chan []byte // critical lane: drop the connection if full
	lossy       chan []byte // best-effort lane: drop the frame if full
	done        chan struct{}
	closeOnce   sync.Once
	userID      string
	displayName string // human nickname, resolved at connect (falls back to userID)
	aid         string
	// metrics is the process-wide T8 registry. Nil-safe (every Observe call
	// checks for nil) so unit tests can construct a Conn without wiring it.
	metrics *metrics.Registry

	// closeCode / closeReason are set under closeOnce BEFORE close(done) and
	// then read by writePump's defer (flushClose) AFTER it receives done. The
	// close(done) → <-c.done synchronizes-with edge in Go's memory model makes
	// the write→read race-free without a mutex. Writers MUST go through
	// closeWithCode; readers MUST only access these in flushClose.
	closeCode   int
	closeReason string
}

// close tears the connection down exactly once: signal writePump via done and
// close the socket (which unblocks the read loop). Nil-safe for unit-test Conns.
// Callers that need to signal an application-level reason (e.g. backpressure
// drop) use closeWithCode instead so the client can distinguish a typed close
// from a raw socket failure.
func (c *Conn) close() {
	c.closeWithCode(0, "")
}

// closeWithCode tears down the connection, recording an optional typed WS
// close reason (e.g. application code 4000 BACKPRESSURE_DROP) for writePump
// to emit on its way out. code == 0 means "no typed close frame" — used by
// close() and the read/write error paths where the reason is "socket gone".
// closeOnce guarantees one teardown across concurrent callers.
//
// MUST be non-blocking: this is invoked from trySend on the broadcast
// goroutine while hub.RLock is held (ws.go:122 broadcast). The actual
// CLOSE-frame WriteControl + ws.Close() are deferred to writePump's
// flushClose (single-writer goroutine, no RLock), so a congested socket
// can't stall the whole room — see flushClose for the bounded deadline.
// Fairy PR #48 review: a writeWait-deadlined WriteControl here would have
// blocked broadcast for up to 10s under hub.RLock when the socket was full.
func (c *Conn) closeWithCode(code int, reason string) {
	c.closeOnce.Do(func() {
		c.closeCode = code
		c.closeReason = reason
		if c.done != nil {
			close(c.done)
		}
	})
}

// trySend enqueues a CRITICAL frame, or — if the buffer is full — force-closes the
// connection (client reconnects and re-syncs via catchup/ROOM_SNAPSHOT) rather than
// silently losing a critical event (BID_ACCEPTED / AUCTION_*). Non-blocking, so one
// slow client never stalls the broadcast to the rest of the room.
//
// The leading non-blocking done-check drops post-close sends instead of letting
// them accumulate in the buffer: hub.leave runs in the read goroutine's defer,
// so there's a window after close() where the conn still sits in hub.rooms and
// would otherwise receive (un-drained) broadcast frames.
//
// T8 instrumentation: the BackpressureDrop counter is incremented on each
// force-close so the load report ties slow-client trims to ack-p95 spikes
// (V9 §4.3: "force-close of the slow client counts as a high sample, NOT
// 剔除"). m may be nil if the conn was created without a registry (unit tests).
func (c *Conn) trySend(b []byte) {
	select {
	case <-c.done:
		return
	default:
	}
	select {
	case c.send <- b:
	default:
		log.Printf("ws backpressure: force-closing slow client (room=%s user=%s)", c.aid, c.userID)
		// Emit a typed close (code 4000 BACKPRESSURE_DROP) so the client can
		// distinguish this from a raw network failure and back off its
		// reconnect intelligently instead of tight-looping into another drop.
		c.closeWithCode(closeCodeBackpressureDrop, "backpressure")
	}
}

// trySendLossy enqueues a BEST-EFFORT frame, dropping it (and keeping the connection)
// when the lossy buffer is full — so a slow client is never force-closed over a
// replaceable frame like a heartbeat. Same post-close drop as trySend.
func (c *Conn) trySendLossy(b []byte) {
	select {
	case <-c.done:
		return
	default:
	}
	select {
	case c.lossy <- b:
	default: // drop the frame; the connection survives
	}
}

// writePump serializes all socket writes, draining the CRITICAL lane with
// best-effort priority over the lossy lane: a pending critical frame always
// pre-empts a pending lossy frame in the leading non-blocking poll, so a lossy
// flood can delay a critical frame by at most one in-flight lossy write (Go's
// select is pseudo-random when multiple cases are ready, but the loop tops back
// to the critical-first poll on every iteration). Also drives server-initiated
// PINGs on `pingPeriod` so a silently-dead client trips the read deadline (set
// by handleWS and refreshed in the PONG handler) and is reaped promptly.
func (c *Conn) writePump() {
	ping := time.NewTicker(pingPeriod)
	defer ping.Stop()
	defer c.flushClose() // emit typed CLOSE (if any) and close the socket
	for {
		// Critical-first: take a pending critical frame (or shutdown) before lossy.
		select {
		case <-c.done:
			return
		case msg := <-c.send:
			if !c.write(msg) {
				return
			}
			continue
		default:
		}
		select {
		case <-c.done:
			return
		case msg := <-c.send:
			if !c.write(msg) {
				return
			}
		case msg := <-c.lossy:
			if !c.write(msg) {
				return
			}
		case <-ping.C:
			// Best-effort: a stuck socket trips the bounded write deadline; the
			// client's PONG handler resets the server's read deadline. No PONG
			// within pongWait → ReadMessage in handleWS errors → defer fires.
			if c.ws == nil {
				continue
			}
			_ = c.ws.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeWait)); err != nil {
				c.close()
				return
			}
		}
	}
}

// flushClose runs on writePump's exit path: it emits the typed CLOSE frame
// (when closeWithCode set a non-zero code) and closes the socket. Running
// here — not in closeWithCode — keeps the CLOSE-frame WriteControl off the
// broadcast goroutine and out of hub.RLock, so a congested socket can stall
// at most this single conn's writePump (bounded by closeFrameWait) instead
// of the whole room's fanout. Safe to read c.closeCode/c.closeReason without
// a lock: closeWithCode writes them under closeOnce *before* close(done),
// and we only get here after writePump observes done — the channel close
// is the synchronizes-with edge.
func (c *Conn) flushClose() {
	if c.ws == nil {
		return
	}
	if code := c.closeCode; code > 0 {
		_ = c.ws.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(code, c.closeReason),
			time.Now().Add(closeFrameWait),
		)
	}
	_ = c.ws.Close()
}

// write sends one frame with a bounded deadline; on error (or oversize frame)
// it closes the conn and reports false so writePump exits. The outbound size
// bound is defensive — today's frames are small; the check fails-fast for a
// future contributor who adds a fat event type rather than producing weird
// socket behavior.
func (c *Conn) write(msg []byte) bool {
	if len(msg) > maxOutboundFrameBytes {
		log.Printf("ws outbound frame oversized (len=%d > %d room=%s user=%s)", len(msg), maxOutboundFrameBytes, c.aid, c.userID)
		c.close()
		return false
	}
	_ = c.ws.SetWriteDeadline(time.Now().Add(writeWait))
	if err := c.ws.WriteMessage(websocket.TextMessage, msg); err != nil {
		c.close()
		return false
	}
	return true
}

func (c *Conn) push(env model.Envelope) {
	b, err := json.Marshal(env)
	if err != nil {
		return
	}
	c.trySend(b)
}

// pushLossy marshals + enqueues a best-effort frame (heartbeat).
func (c *Conn) pushLossy(env model.Envelope) {
	b, err := json.Marshal(env)
	if err != nil {
		return
	}
	c.trySendLossy(b)
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	upgrader := websocket.Upgrader{
		CheckOrigin: func(req *http.Request) bool {
			return auth.OriginAllowed(req.Header.Get("Origin"), s.cfg.FrontendOrigin)
		},
	}
	userID, err := auth.Verify(s.cfg.JWTSecret, r.URL.Query().Get("token"))
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return // upgrader already wrote the error
	}
	// §8 WS hardening: bound inbound frame size. Client messages (BID_PLACE,
	// ROOM_JOIN, PING) are tiny; a multi-KB frame is abuse. Gorilla closes the
	// connection with 1009 when the limit is exceeded.
	ws.SetReadLimit(maxWSFrameBytes)
	// WS keepalive: a read deadline + PONG handler refresh (paired with the
	// PING ticker in writePump). Without this a silently-dead client (cable
	// unplugged, NAT timeout, OS sleep) blocks ws.ReadMessage() for the OS-
	// level TCP timeout (~2h on Linux) and leaks the read + writePump
	// goroutines for the lifetime of that window. The handler refreshes the
	// deadline on every PONG so a healthy client never trips it.
	_ = ws.SetReadDeadline(time.Now().Add(pongWait))
	ws.SetPongHandler(func(string) error {
		_ = ws.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})
	// Resolve the human nickname once at connect so bids broadcast a display name,
	// not the opaque user id. Falls back to the id if the lookup fails/empty.
	display := userID
	if nick, err := s.st.UserNickname(r.Context(), userID); err == nil && nick != "" {
		display = nick
	}
	c := &Conn{
		ws: ws, send: make(chan []byte, sendBufFrames), lossy: make(chan []byte, 16),
		done: make(chan struct{}), userID: userID, displayName: display,
		metrics: s.metrics,
	}
	if s.metrics != nil {
		s.metrics.ActiveConns.Add(1)
	}
	go c.writePump()
	defer func() {
		s.hub.leave(c)
		c.close()
		if s.metrics != nil {
			s.metrics.ActiveConns.Add(-1)
		}
	}()

	for {
		_, raw, err := ws.ReadMessage()
		if err != nil {
			return
		}
		var frame struct {
			model.Envelope
			SchemaVersion int `json:"schemaVersion"`
		}
		if err := json.Unmarshal(raw, &frame); err != nil {
			continue
		}
		if frame.SchemaVersion != model.SchemaVersion {
			// Write the protocol close frame and tear down immediately so callers
			// can reliably observe the intended close code and reason.
			_ = ws.WriteMessage(
				websocket.CloseMessage,
				websocket.FormatCloseMessage(schemaMismatchCloseCode, "schema mismatch"),
			)
			c.close()
			return
		}
		s.dispatchWS(r.Context(), c, frame.Envelope)
	}
}

func (s *Server) dispatchWS(ctx context.Context, c *Conn, env model.Envelope) {
	switch env.Type {
	case model.TypePing:
		// heartbeat is best-effort: a dropped PONG must not force-close a busy client.
		c.pushLossy(model.Envelope{Type: model.TypePong, ServerTimeMs: time.Now().UnixMilli()})

	case model.TypeRoomJoin:
		var d model.RoomJoinData
		_ = json.Unmarshal(env.Data, &d)
		if d.AuctionID == "" {
			return
		}
		// Leave any previously joined room first, otherwise a re-JOIN to a
		// different auction would leave a stale reference in the old room's map
		// (memory leak + send-on-closed-channel panic on later broadcast).
		if c.aid != "" {
			s.hub.leave(c)
		}
		c.aid = d.AuctionID
		s.hub.join(d.AuctionID, c)
		// T8 catchup latency (V9 §4.2: 200 events < 1s p95). Only Observe when
		// catchup actually runs (lastSeq > 0 and we read at least one event) so the
		// histogram isn't polluted by trivial joins. Capture t0 before the snapshot
		// read so the snapshot RTT is part of the budget too (the client can't apply
		// catchup events without it).
		t0 := time.Now()
		snap, err := s.st.Snapshot(ctx, d.AuctionID)
		if err != nil {
			log.Printf("snapshot %s: %v", d.AuctionID, err)
			return
		}
		// Catchup: replay the missed Stream events (seq > lastSeq) before the
		// snapshot when the gap is small. An up-to-date client (lastSeq >= seq) or
		// a gap > catchupMaxGap falls back to the snapshot only (proto: gap > 200 →
		// snapshot). lastSeq 0 with a small backlog replays the whole short history.
		// Catchup reads the authoritative Stream, not Pub/Sub.
		catchupRan := false
		if snap.Seq > d.LastSeq && snap.Seq-d.LastSeq <= catchupMaxGap {
			if events, _, err := s.st.ReadEventsAfter(ctx, d.AuctionID, streamIDForSeq(d.LastSeq)); err == nil {
				for _, e := range eventsUpToSnapshot(events, snap.Seq) {
					c.push(model.Envelope{
						Type: e.Type, AuctionID: d.AuctionID, Seq: e.Seq,
						ServerTimeMs: time.Now().UnixMilli(), Data: json.RawMessage(e.Payload),
					})
					catchupRan = true
				}
			}
		}
		if out, err := model.NewEnvelope(model.TypeRoomSnapshot, d.AuctionID, snap.Seq, snap); err == nil {
			c.push(out)
		}
		// catchupRan == we replayed ≥1 Stream event into the snapshot. That's the
		// "user is paying catchup latency" case the §4.2 1-s budget targets — both
		// a reconnect with lastSeq > 0 AND a cold-join into an active room (lastSeq=0,
		// short history) need to land inside the budget. Earlier guard had
		// `d.LastSeq > 0` which silently dropped cold-joins, making the SLO
		// unverifiable in the load harness (observers join with lastSeq=0).
		if catchupRan && c.metrics != nil {
			c.metrics.CatchupLatency.Observe(time.Since(t0))
		}

	case model.TypeBidPlace:
		var d model.BidPlaceData
		_ = json.Unmarshal(env.Data, &d)
		// §8: strictly validate AND canonicalize the amount BEFORE the Lua call. A
		// non-numeric/non-positive amount is a malformed message (ERR_BAD_INPUT),
		// not a business "too low" (ERR_TOO_LOW). place_bid.lua echoes ARGV[3]
		// verbatim into the ack/Stream/broadcast, so canonicalize here ("0123" /
		// "+123" -> "123") to keep money-as-string canonical on the wire. Range
		// checks vs increment/cap need auction state and stay in place_bid.lua.
		amount, ok := canonicalAmount(d.AmountCents)
		if c.aid == "" || d.ClientBidID == "" || len(d.ClientBidID) > maxClientBidIDLen || !ok {
			c.push(rejected(c.aid, model.CodeErrBadInput))
			if c.metrics != nil {
				c.metrics.BidsRejected.Inc()
			}
			return
		}
		// T8 ack latency: includes envelope decode (caller), canonicalAmount, Lua
		// dispatch, payload unmarshal, and the trySend (non-blocking enqueue). It is
		// the full server-side processing time for one BID_PLACE — the user-visible
		// "click → toast" budget. Script_time is the same call's narrow EVALSHA
		// portion (Lua exec + Redis RTT), measured separately so a hot-path Lua
		// regression separates from a Go-side regression.
		// TODO(T3, [全员 approve]): per-connection inbound bid rate limit + wire code
		// ERR_RATE_LIMITED (§8). Deferred: the new code is an all-member-approve
		// contract change and dedupe already makes retries cheap. At T2 scale (single
		// gateway/Redis) the blast radius is bounded; revisit before multi-gateway T5.
		ackStart := time.Now()
		scriptStart := time.Now()
		code, _, payload, err := s.st.PlaceBid(ctx, c.aid, c.userID, d.ClientBidID, amount, c.displayName)
		if c.metrics != nil {
			c.metrics.ScriptTime.Observe(time.Since(scriptStart))
		}
		if err != nil {
			log.Printf("place_bid %s: %v", c.aid, err)
			c.push(rejected(c.aid, bidErrCode(err)))
			if c.metrics != nil {
				c.metrics.BidsRejected.Inc()
			}
			return
		}
		switch code {
		case model.CodeOKAccepted, model.CodeOKExtended, model.CodeOKSold, model.CodeDuplicate:
			// Ack the originating socket directly, in addition to the Pub/Sub room
			// broadcast the subscriber fans out to observers. trySend enqueues or, if
			// the buffer is full, drops the connection so the client reconnects and
			// re-syncs (never silently loses a critical ack). The client also gets
			// the broadcast copy and dedupes by seq. OK_EXTENDED/OK_SOLD ack the bid
			// here; their AUCTION_EXTENDED / AUCTION_SOLD reaches the room via Pub/Sub.
			c.push(bidAccepted(c.aid, payload))
			if c.metrics != nil {
				c.metrics.AckLatency.Observe(time.Since(ackStart))
				// DUPLICATE is not a fresh accept (proto/error-codes.md: it replays the
				// original ack and is intentionally not flagged as an error), so it
				// doesn't bump BidsAccepted. The retry already counted on first land.
				if code != model.CodeDuplicate {
					c.metrics.BidsAccepted.Inc()
				}
			}
		default:
			c.push(rejected(c.aid, code))
			if c.metrics != nil {
				c.metrics.AckLatency.Observe(time.Since(ackStart))
				c.metrics.BidsRejected.Inc()
			}
		}
	}
}

func rejected(aid, code string) model.Envelope {
	env, _ := model.NewEnvelope(model.TypeBidRejected, aid, 0, model.BidRejectedData{Code: code})
	return env
}

// canonicalAmount validates that s is a positive base-10 integer fitting int64
// (cents) and returns its canonical decimal form, so "0123" / "+123" -> "123".
// ok=false ⇒ malformed (ERR_BAD_INPUT). Range checks vs increment/cap are the
// Lua hot path's job. Canonicalizing here keeps the money-as-string boundary
// canonical, since place_bid.lua echoes the amount string verbatim.
func canonicalAmount(s string) (string, bool) {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 || n > int64(model.MaxMoneyCents) {
		return "", false
	}
	return strconv.FormatInt(n, 10), true
}

func bidAccepted(aid, payload string) model.Envelope {
	var bad model.BidAcceptedData
	_ = json.Unmarshal([]byte(payload), &bad)
	env, _ := model.NewEnvelope(model.TypeBidAccepted, aid, bad.Seq, bad)
	return env
}

// bidErrCode honours the frozen boundary "Redis down -> ERR_AUCTION_PAUSED": a
// NOSCRIPT (flushed script cache) is a genuine internal/dispatcher fault, but
// any other EVALSHA transport error means Redis is effectively unavailable.
func bidErrCode(err error) string {
	if strings.Contains(strings.ToUpper(err.Error()), "NOSCRIPT") {
		return model.CodeErrInternal
	}
	return model.CodeErrPaused
}
