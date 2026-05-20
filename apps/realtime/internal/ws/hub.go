package ws

import (
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     func(r *http.Request) bool { return true }, // P0 dev. Tighten for prod.
}

type Hub struct {
	mu    sync.RWMutex
	conns map[*Conn]struct{}
}

type Conn struct {
	hub  *Hub
	ws   *websocket.Conn
	send chan []byte
}

func NewHub() *Hub {
	return &Hub{conns: make(map[*Conn]struct{})}
}

func (h *Hub) Run() {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for range t.C {
		h.mu.RLock()
		log.Printf("[ws] active conns: %d", len(h.conns))
		h.mu.RUnlock()
	}
}

func (h *Hub) add(c *Conn) {
	h.mu.Lock()
	h.conns[c] = struct{}{}
	h.mu.Unlock()
}

func (h *Hub) remove(c *Conn) {
	h.mu.Lock()
	delete(h.conns, c)
	h.mu.Unlock()
}

func UpgradeHandler(hub *Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("upgrade err: %v", err)
			return
		}
		c := &Conn{hub: hub, ws: ws, send: make(chan []byte, 64)}
		hub.add(c)
		go c.writePump()
		c.readPump()
	}
}

func (c *Conn) readPump() {
	defer func() {
		c.hub.remove(c)
		_ = c.ws.Close()
	}()
	c.ws.SetReadLimit(64 * 1024)
	_ = c.ws.SetReadDeadline(time.Now().Add(30 * time.Second))
	c.ws.SetPongHandler(func(string) error {
		_ = c.ws.SetReadDeadline(time.Now().Add(30 * time.Second))
		return nil
	})
	for {
		_, _, err := c.ws.ReadMessage()
		if err != nil {
			return
		}
		// TODO: decode msgpack Envelope, dispatch to Bid Engine via gRPC / direct call.
	}
}

func (c *Conn) writePump() {
	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	for {
		select {
		case msg, ok := <-c.send:
			if !ok {
				_ = c.ws.WriteMessage(websocket.CloseMessage, nil)
				return
			}
			if err := c.ws.WriteMessage(websocket.BinaryMessage, msg); err != nil {
				return
			}
		case <-ping.C:
			if err := c.ws.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
