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

// fanoutSweepInterval is the backstop cadence for Stream-driven broadcast (a lost
// Pub/Sub wakeup can't permanently stall the room).
const fanoutSweepInterval = 2 * time.Second

// streamIDForSeq returns the XRANGE-exclusive lower bound for "events after seq".
func streamIDForSeq(seq int64) string { return fmt.Sprintf("%d-0", seq) }

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
func (h *Hub) subscribe(ctx context.Context, st *store.Store) {
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
			env := model.Envelope{
				Type: e.Type, AuctionID: aid, Seq: e.Seq,
				ServerTimeMs: time.Now().UnixMilli(), Data: json.RawMessage(e.Payload),
			}
			b, _ := json.Marshal(env)
			h.broadcast(aid, b)
			lastSeq[aid] = e.Seq
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

// Conn is one WS client connection with a serialized write pump. Shutdown is
// signalled by closing `done` (once); `send` is never closed, so concurrent
// senders (direct ack + Pub/Sub broadcast) can't panic on a closed channel.
type Conn struct {
	ws          *websocket.Conn
	send        chan []byte
	done        chan struct{}
	closeOnce   sync.Once
	userID      string
	displayName string // human nickname, resolved at connect (falls back to userID)
	aid         string
}

// close tears the connection down exactly once: signal writePump via done and
// close the socket (which unblocks the read loop). Nil-safe for unit-test Conns.
func (c *Conn) close() {
	c.closeOnce.Do(func() {
		if c.done != nil {
			close(c.done)
		}
		if c.ws != nil {
			_ = c.ws.Close()
		}
	})
}

// trySend enqueues a frame, or — if the send buffer is full — drops the whole
// connection (close → client reconnects and re-syncs via ROOM_SNAPSHOT) rather
// than silently losing a critical event (BID_ACCEPTED / AUCTION_*). Full
// priority-queue backpressure (separating chat/presence from critical) is T5.
func (c *Conn) trySend(b []byte) {
	select {
	case c.send <- b:
	default:
		c.close()
	}
}

func (c *Conn) writePump() {
	for {
		select {
		case msg := <-c.send:
			_ = c.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.ws.WriteMessage(websocket.TextMessage, msg); err != nil {
				c.close()
				return
			}
		case <-c.done:
			return
		}
	}
}

func (c *Conn) push(env model.Envelope) {
	b, err := json.Marshal(env)
	if err != nil {
		return
	}
	c.trySend(b)
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
	// Resolve the human nickname once at connect so bids broadcast a display name,
	// not the opaque user id. Falls back to the id if the lookup fails/empty.
	display := userID
	if nick, err := s.st.UserNickname(r.Context(), userID); err == nil && nick != "" {
		display = nick
	}
	c := &Conn{ws: ws, send: make(chan []byte, 64), done: make(chan struct{}), userID: userID, displayName: display}
	go c.writePump()
	defer func() {
		s.hub.leave(c)
		c.close()
	}()

	for {
		_, raw, err := ws.ReadMessage()
		if err != nil {
			return
		}
		var env model.Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			continue
		}
		s.dispatchWS(r.Context(), c, env)
	}
}

func (s *Server) dispatchWS(ctx context.Context, c *Conn, env model.Envelope) {
	switch env.Type {
	case model.TypePing:
		c.push(model.Envelope{Type: model.TypePong, ServerTimeMs: time.Now().UnixMilli()})

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
		if snap.Seq > d.LastSeq && snap.Seq-d.LastSeq <= catchupMaxGap {
			if events, _, err := s.st.ReadEventsAfter(ctx, d.AuctionID, streamIDForSeq(d.LastSeq)); err == nil {
				for _, e := range events {
					c.push(model.Envelope{
						Type: e.Type, AuctionID: d.AuctionID, Seq: e.Seq,
						ServerTimeMs: time.Now().UnixMilli(), Data: json.RawMessage(e.Payload),
					})
				}
			}
		}
		if out, err := model.NewEnvelope(model.TypeRoomSnapshot, d.AuctionID, snap.Seq, snap); err == nil {
			c.push(out)
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
			return
		}
		// TODO(T3, [全员 approve]): per-connection inbound bid rate limit + wire code
		// ERR_RATE_LIMITED (§8). Deferred: the new code is an all-member-approve
		// contract change and dedupe already makes retries cheap. At T2 scale (single
		// gateway/Redis) the blast radius is bounded; revisit before multi-gateway T5.
		code, _, payload, err := s.st.PlaceBid(ctx, c.aid, c.userID, d.ClientBidID, amount, c.displayName)
		if err != nil {
			log.Printf("place_bid %s: %v", c.aid, err)
			c.push(rejected(c.aid, bidErrCode(err)))
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
		default:
			c.push(rejected(c.aid, code))
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
