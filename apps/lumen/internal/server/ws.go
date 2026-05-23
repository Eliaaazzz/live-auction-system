package server

import (
	"context"
	"encoding/json"
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
		select {
		case c.send <- msg:
		default: // slow client: drop rather than block the room (full backpressure = T5)
		}
	}
}

// subscribe consumes the Pub/Sub fanout hints and broadcasts BID_ACCEPTED to the
// matching room. Runs for the lifetime of ctx.
func (h *Hub) subscribe(ctx context.Context, st *store.Store) {
	ps := st.Redis().PSubscribe(ctx, store.PubPattern)
	defer func() { _ = ps.Close() }()
	ch := ps.Channel() // create once; go-redis starts a delivery goroutine here
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			aid := store.AIDFromPubChannel(msg.Channel)
			if aid == "" {
				continue
			}
			env, ok := decodePub(aid, msg.Payload)
			if !ok {
				continue
			}
			b, _ := json.Marshal(env)
			h.broadcast(aid, b)
		}
	}
}

// decodePub turns a Pub/Sub fanout payload (a typed model.PubMessage written by
// the Lua hot path) into the WS envelope to broadcast to the room. One channel
// fans out BID_ACCEPTED / AUCTION_EXTENDED / AUCTION_SOLD; type + seq are
// forwarded verbatim and data is already the wire payload. Returns ok=false for
// a malformed or typeless message (the subscriber skips it).
func decodePub(aid, payload string) (model.Envelope, bool) {
	var pm model.PubMessage
	if err := json.Unmarshal([]byte(payload), &pm); err != nil || pm.Type == "" {
		return model.Envelope{}, false
	}
	return model.Envelope{
		Type:         pm.Type,
		AuctionID:    aid,
		Seq:          pm.Seq,
		ServerTimeMs: time.Now().UnixMilli(),
		Data:         pm.Data,
	}, true
}

// Conn is one WS client connection with a serialized write pump.
type Conn struct {
	ws          *websocket.Conn
	send        chan []byte
	userID      string
	displayName string // human nickname, resolved at connect (falls back to userID)
	aid         string
}

func (c *Conn) writePump() {
	for msg := range c.send {
		_ = c.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if err := c.ws.WriteMessage(websocket.TextMessage, msg); err != nil {
			return
		}
	}
}

func (c *Conn) push(env model.Envelope) {
	b, err := json.Marshal(env)
	if err != nil {
		return
	}
	select {
	case c.send <- b:
	default:
	}
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
	c := &Conn{ws: ws, send: make(chan []byte, 64), userID: userID, displayName: display}
	go c.writePump()
	defer func() {
		s.hub.leave(c)
		close(c.send)
		_ = ws.Close()
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
		if out, err := model.NewEnvelope(model.TypeRoomSnapshot, d.AuctionID, snap.Seq, snap); err == nil {
			c.push(out)
		}

	case model.TypeBidPlace:
		var d model.BidPlaceData
		_ = json.Unmarshal(env.Data, &d)
		// §8: strictly validate envelope/amount BEFORE the Lua call. A non-numeric
		// or non-positive amount is a malformed client message (ERR_BAD_INPUT), not
		// a business "too low" (ERR_TOO_LOW). Range checks vs increment/cap need
		// auction state and stay in place_bid.lua.
		if c.aid == "" || d.ClientBidID == "" || len(d.ClientBidID) > maxClientBidIDLen || !validAmount(d.AmountCents) {
			c.push(rejected(c.aid, model.CodeErrBadInput))
			return
		}
		// TODO(T3, [全员 approve]): per-connection inbound bid rate limit + wire code
		// ERR_RATE_LIMITED (§8). Deferred: the new code is an all-member-approve
		// contract change and dedupe already makes retries cheap. At T2 scale (single
		// gateway/Redis) the blast radius is bounded; revisit before multi-gateway T5.
		code, _, payload, err := s.st.PlaceBid(ctx, c.aid, c.userID, d.ClientBidID, d.AmountCents, c.displayName)
		if err != nil {
			log.Printf("place_bid %s: %v", c.aid, err)
			c.push(rejected(c.aid, bidErrCode(err)))
			return
		}
		switch code {
		case model.CodeOKAccepted, model.CodeOKExtended, model.CodeOKSold, model.CodeDuplicate:
			// Ack the originating socket directly, in addition to the Pub/Sub room
			// broadcast the subscriber fans out to observers. push is best-effort
			// (drops if the send buffer is full), but for a responsive client the
			// 64-slot buffer makes the direct ack effectively reliable; the client
			// also receives the broadcast copy and dedupes by seq. OK_EXTENDED/
			// OK_SOLD ack the bid here; their AUCTION_EXTENDED / AUCTION_SOLD event
			// reaches the room (incl. this socket) via Pub/Sub.
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

// validAmount reports whether s is a positive base-10 integer that fits int64
// (cents). Range validation against increment/cap is the Lua hot path's job.
func validAmount(s string) bool {
	n, err := strconv.ParseInt(s, 10, 64)
	return err == nil && n > 0
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
