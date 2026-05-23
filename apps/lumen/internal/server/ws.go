package server

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/auth"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

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
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-ps.Channel():
			if !ok {
				return
			}
			aid := store.AIDFromPubChannel(msg.Channel)
			var bad model.BidAcceptedData
			if err := json.Unmarshal([]byte(msg.Payload), &bad); err != nil {
				continue
			}
			env, err := model.NewEnvelope(model.TypeBidAccepted, aid, bad.Seq, bad)
			if err != nil {
				continue
			}
			b, _ := json.Marshal(env)
			h.broadcast(aid, b)
		}
	}
}

// Conn is one WS client connection with a serialized write pump.
type Conn struct {
	ws     *websocket.Conn
	send   chan []byte
	userID string
	aid    string
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
	c := &Conn{ws: ws, send: make(chan []byte, 64), userID: userID}
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
		if c.aid == "" || d.ClientBidID == "" || d.AmountCents == "" {
			c.push(rejected(c.aid, model.CodeErrBadState))
			return
		}
		code, _, payload, err := s.st.PlaceBid(ctx, c.aid, c.userID, d.ClientBidID, d.AmountCents, c.userID)
		if err != nil {
			log.Printf("place_bid %s: %v", c.aid, err)
			c.push(rejected(c.aid, bidErrCode(err)))
			return
		}
		switch code {
		case model.CodeOKAccepted, model.CodeDuplicate:
			// Ack the originating socket DIRECTLY (reliable), independent of the
			// Pub/Sub room broadcast that the subscriber fans out to observers.
			// (A slow sender's queue could drop the broadcast copy.) Clients
			// dedupe by seq, so the sender seeing both ack + broadcast is fine.
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
