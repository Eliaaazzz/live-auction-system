# Component 01 — WebSocket Gateway

> **Path**: `apps/lumen/internal/gateway/` + `apps/lumen/cmd/lumen/main.go` (mode=gateway)
> **Owner discipline**: leader; envelope changes are **all-member approve** (V9 §6).
> **Gates trunk**: T1 (single-gateway bid roundtrip) → T5 (horizontal scale + Pub/Sub fanout + catchup).
> **Cross-references**: `proto/ws-envelope.md`, `proto/security-baseline.md`, [02-bid-engine](02-bid-engine.md), [12-shared-package](12-shared-package.md).

## Purpose

WS Gateway terminates client WebSocket connections, routes messages to Bid Engine or AI Sidecar, and broadcasts engine events to room subscribers. It does **not** mutate auction truth — that's exclusively the Bid Engine through Lua. Per V9 architecture: WS Gateway is **horizontally scalable**, Bid Engine is single-instance.

The gateway is the only place that talks to client WS connections; everything else in the system talks to the gateway over internal RPC or Redis Pub/Sub.

## Directory layout

```
apps/lumen/internal/gateway/
├── server.go             ws upgrade, mode=gateway entry
├── connection.go         per-connection goroutine pair + state
├── hub.go                room → connections registry (per-process)
├── inbound.go            decode → route (bid/chat/ping/catchup)
├── outbound.go           Pub/Sub subscriber → broadcast to room
├── catchup.go            on ROOM_JOIN with lastSeq, replay from Stream
├── backpressure.go       bufferedAmount thresholds + slow-client policy
├── middleware/
│   ├── origin.go         Origin allowlist (CSWSH defense)
│   ├── auth.go           handshake token validation
│   ├── ratelimit.go      per-connection bid rate limit
│   └── recover.go        panic isolation per connection
├── metrics.go            Prometheus collectors
└── server_test.go        with real WS client + miniredis
```

## Connection lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│  HTTP upgrade → middleware chain                                │
│   1. CORS preflight (admin/mobile only)                         │
│   2. Origin allowlist check  → reject if not in FRONTEND_ORIGIN │
│   3. Token validation  → reject if missing/invalid              │
│   4. Rate limit check (IP-based, pre-upgrade)                   │
└────────────┬────────────────────────────────────────────────────┘
             │ ok → upgrade
             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Connection created: bind userId from token, spawn pumps       │
│   • readPump: read frames → decode envelope → route to inbound  │
│   • writePump: receive from out chan → write frame              │
│   • heartbeat: send PING every 25s, expect PONG within 10s      │
└─────────────────────────────────────────────────────────────────┘

Read pump (goroutine A):
  loop:
    msg = readJSON()
    if err: closeConnection(reason); return
    envelope = decode(msg)
    if envelope.type == ROOM_JOIN:    hub.join(conn, auctionId); catchup(conn, lastSeq)
    if envelope.type == ROOM_LEAVE:   hub.leave(conn, auctionId)
    if envelope.type == BID_PLACE:    inbound.handleBid(conn, envelope)
    if envelope.type == CHAT_SEND:    inbound.handleChat(conn, envelope)
    if envelope.type == PING:         writePump.enqueue(PONG)

Write pump (goroutine B):
  loop:
    msg = <-conn.out (buffered chan, capacity 256)
    if conn.bufferedAmount > criticalThreshold:
        applyBackpressurePolicy(conn, msg.channel)
    writeJSON(msg)

Subscriber pump (goroutine C, one per gateway process):
  PSUBSCRIBE Redis "auction:*:pub" (canonical channel per proto/redis-keys.md)
  on event: parse auctionId from channel, lookup local hub, fan-out to all conn.out

Close handler:
  hub.leaveAll(conn); close conn; record reason metric
```

## Key types

```go
// internal/gateway/connection.go
type Connection struct {
    ID          string          // uuid
    UserID      string          // from token
    DisplayName string
    Origin      string
    ws          *websocket.Conn
    out         chan Envelope    // buffered, capacity 256
    rooms       map[string]bool  // auctions joined
    mu          sync.Mutex
    closed      atomic.Bool
    metrics     *connectionMetrics
}

// internal/gateway/hub.go
type Hub struct {
    mu       sync.RWMutex
    rooms    map[string]map[*Connection]struct{}  // aid → set
    metrics  *hubMetrics
}

func (h *Hub) Join(c *Connection, auctionID string)
func (h *Hub) Leave(c *Connection, auctionID string)
func (h *Hub) Broadcast(auctionID string, env Envelope)  // fan-out to all conns in room
func (h *Hub) RoomSize(auctionID string) int

// internal/gateway/inbound.go
type Router struct {
    engine    bidengine.Engine  // RPC client to Bid Engine
    aiSidecar aisidecar.Client  // HTTP client to AI sidecar
    hub       *Hub
    metrics   *routerMetrics
}

func (r *Router) HandleBid(c *Connection, env Envelope) error
func (r *Router) HandleChat(c *Connection, env Envelope) error
```

## Key functions

### `Server.Upgrade` — entry point

```go
func (s *Server) Upgrade(w http.ResponseWriter, r *http.Request) {
    // 1. Origin check
    origin := r.Header.Get("Origin")
    if !s.originAllow(origin) {
        http.Error(w, "origin not allowed", http.StatusForbidden)
        s.metrics.rejected.WithLabelValues("origin").Inc()
        return
    }
    // 2. Token validation
    token := r.URL.Query().Get("token")
    claims, err := s.auth.Validate(token)
    if err != nil {
        http.Error(w, "unauthorized", http.StatusUnauthorized)
        s.metrics.rejected.WithLabelValues("auth").Inc()
        return
    }
    // 3. Upgrade
    ws, err := s.upgrader.Upgrade(w, r, nil)
    if err != nil { return }

    conn := newConnection(ws, claims.UserID, claims.DisplayName, origin)
    s.connections.add(conn)
    s.metrics.connected.Inc()
    defer s.metrics.connected.Dec()

    go conn.writePump(s.metrics)
    conn.readPump(s.router, s.hub, s.metrics)  // blocking, returns when closed
    conn.close()
    s.connections.remove(conn)
    s.hub.leaveAll(conn)
}
```

### `Connection.readPump` — main per-conn loop

```go
func (c *Connection) readPump(r *Router, h *Hub, m *Metrics) {
    defer c.close()
    c.ws.SetReadLimit(MaxFrameBytes)  // 16KB per V9 §8
    c.ws.SetReadDeadline(time.Now().Add(60 * time.Second))
    c.ws.SetPongHandler(func(string) error {
        c.ws.SetReadDeadline(time.Now().Add(60 * time.Second))
        return nil
    })

    for {
        _, raw, err := c.ws.ReadMessage()
        if err != nil { return }

        env, err := decodeEnvelope(raw)
        if err != nil {
            c.sendError("ERR_BAD_ENVELOPE")
            m.envelopeDecodeErr.Inc()
            continue
        }

        switch env.Type {
        case "ROOM_JOIN":
            h.Join(c, env.AuctionID)
            go r.HandleCatchup(c, env.AuctionID, env.LastSeq)  // separate goroutine; doesn't block reads
        case "ROOM_LEAVE":
            h.Leave(c, env.AuctionID)
        case "BID_PLACE":
            if !c.rateLimit.allow() {
                c.send(Envelope{Type: "BID_REJECTED", Data: map[string]string{"code": "ERR_RATE_LIMITED"}})
                continue
            }
            if err := r.HandleBid(c, env); err != nil {
                c.sendError("ERR_INTERNAL")
                m.handlerErr.WithLabelValues("bid").Inc()
            }
        case "CHAT_SEND":
            r.HandleChat(c, env)
        case "PING":
            c.send(Envelope{Type: "PONG", Data: map[string]int64{"serverTimeMs": time.Now().UnixMilli()}})
        default:
            c.sendError("ERR_UNKNOWN_TYPE")
        }
    }
}
```

### `Router.HandleBid` — dispatch to Bid Engine

```go
func (r *Router) HandleBid(c *Connection, env Envelope) error {
    var data BidPlaceData
    if err := unmarshalData(env.Data, &data); err != nil {
        return err
    }
    // amountCents is string at the protocol boundary — parse to int64
    amount, err := strconv.ParseInt(data.AmountCents, 10, 64)
    if err != nil {
        c.send(Envelope{Type: "BID_REJECTED", Data: map[string]string{"code": "ERR_BAD_AMOUNT"}})
        return nil
    }

    ctx, cancel := context.WithTimeout(c.ctx, 200*time.Millisecond)
    defer cancel()

    result, err := r.engine.PlaceBid(ctx, bidengine.PlaceBidRequest{
        AuctionID:   env.AuctionID,
        UserID:      c.UserID,
        DisplayName: c.DisplayName,
        ClientBidID: data.ClientBidID,
        AmountCents: amount,
    })
    if err != nil {
        c.send(Envelope{Type: "BID_REJECTED", Data: map[string]string{"code": "ERR_ENGINE_TIMEOUT"}})
        r.metrics.engineErr.Inc()
        return err
    }

    // Always send ack back to originating client (even for DUPLICATE; payload is same)
    c.send(result.Wire.ToEnvelope(env.AuctionID))

    // For accepted bids, the broadcast to OTHER room members comes via the
    // subscriber pump (Bid Engine PUBLISHes on auction:{<aid>}:pub inside
    // place_bid.lua). We always direct-ack the originating socket first
    // (lossy Pub/Sub fanout can drop ack to the sender's slow queue) — the
    // double-delivery (direct ack + room broadcast) is fine because clients
    // dedupe by seq. Matches PR #19 apps/lumen/internal/server/ws.go:194-203.
    return nil
}
```

### `outbound.SubscriberPump` — Redis Pub/Sub → room fanout

```go
func (s *SubscriberPump) Run(ctx context.Context) {
    // Canonical channel format per proto/redis-keys.md: auction:{<aid>}:pub
    sub := s.redis.PSubscribe(ctx, "auction:*:pub")
    defer sub.Close()

    for msg := range sub.Channel() {
        // Channel = "auction:<aid>:pub" — extract <aid> from middle segment
        parts := strings.Split(msg.Channel, ":")
        if len(parts) != 3 { continue }
        auctionID := parts[1]
        env := decodePublishedEvent(msg.Payload)
        s.hub.Broadcast(auctionID, env)
        s.metrics.fanoutCount.WithLabelValues(env.Type).Inc()
    }
}
```

**Important**: Pub/Sub is a hint, not the source of truth. Stream is canonical. If a Pub/Sub message is lost, clients still receive the event via:
- their next bid's ack (carries current state)
- catchup on reconnect (XRANGE from Stream)
- explicit ROOM_SNAPSHOT request (REST fallback)

### `catchup.HandleCatchup` — replay on join

```go
func (r *Router) HandleCatchup(c *Connection, auctionID string, lastSeq int64) {
    // 1. Quick path: if gap is small, XRANGE from Stream
    streamKey := fmt.Sprintf("auction:{%s}:events", auctionID)  // canonical per proto/redis-keys.md
    entries, err := r.redis.XRange(ctx, streamKey,
        fmt.Sprintf("%d-0", lastSeq+1),
        "+",
    ).Result()
    if err != nil {
        r.metrics.catchupErr.Inc()
        return
    }
    if len(entries) > 200 {
        // Slow path: send a full ROOM_SNAPSHOT (same shape as initial ROOM_JOIN
        // response and REST /api/auctions/{id}/snapshot — single canonical
        // snapshot type per V9 §6 "snapshot fallback shape (shared $ref)").
        snap, err := r.snapshotter.Build(ctx, auctionID)
        if err != nil {
            r.metrics.catchupErr.Inc()
            return
        }
        c.send(Envelope{Type: "ROOM_SNAPSHOT", AuctionID: auctionID, Seq: snap.Seq, Data: snap})
        r.metrics.catchupFallback.Inc()
        return
    }
    // Replay in order
    catchupEvents := make([]Envelope, 0, len(entries))
    for _, e := range entries {
        catchupEvents = append(catchupEvents, decodeStreamEntry(e))
    }
    c.send(Envelope{Type: "CATCHUP_EVENTS", AuctionID: auctionID, Data: catchupEvents})
}
```

### `backpressure.Apply` — slow client policy

```go
const (
    CriticalThresholdBytes = 1 << 20  // 1MB per V9 §0
    HardThresholdBytes     = 4 << 20  // 4MB per V9 §0
)

func (c *Connection) bufferedAmount() int { return cap(c.out) - len(c.out) }

func (c *Connection) applyBackpressure(channel string) {
    b := c.bufferedAmount()
    switch {
    case b < CriticalThresholdBytes:
        return  // normal
    case b < HardThresholdBytes:
        // critical: drop soft-channel messages (chat, ai), keep bid+presence
        if channel == "chat" || channel == "ai" {
            c.metrics.droppedSoft.WithLabelValues(channel).Inc()
            return
        }
    default:
        // hard: force close. Force-closed clients are NOT excluded from p99 metrics (V9 §4.3).
        c.metrics.forceClose.Inc()
        c.ws.Close()
    }
}
```

## Per-channel bufferedAmount semantics

Per V9 §6 boundary "WS bufferedAmount 1MB/4MB" and §0 boundary 8.

- **bid channel** = critical, never dropped, force-close on 4MB.
- **presence** = critical, never dropped.
- **chat** = soft, dropped at 1MB.
- **ai** = soft, dropped at 1MB.

The out chan is per-connection; channel routing happens at enqueue:

```go
func (c *Connection) send(env Envelope) {
    select {
    case c.out <- env:
        return
    default:
        c.applyBackpressure(env.Channel)
        select {
        case c.out <- env:
        case <-time.After(50 * time.Millisecond):
            c.metrics.sendTimeout.Inc()
            c.ws.Close()
        }
    }
}
```

## Metrics emitted

- `ws_connections_total` (gauge by gateway_instance)
- `ws_messages_received_total{type}` (counter)
- `ws_messages_sent_total{type}` (counter)
- `ws_envelope_decode_errors_total` (counter)
- `ws_buffered_amount_bytes{conn_id}` (gauge) — high-cardinality; use exemplar sampling
- `ws_dropped_soft_total{channel}` (counter)
- `ws_force_close_total` (counter)
- `ws_catchup_events_total` (histogram, label=`mode={stream,snapshot}`)
- `ws_handler_duration_seconds{handler}` (histogram)

## Test surface (Go)

| Test | Verifies |
|---|---|
| `TestUpgrade_OriginAllowed` | known origin → 101 Switching Protocols |
| `TestUpgrade_OriginBlocked` | unknown origin → 403, no upgrade |
| `TestUpgrade_NoToken` | missing token → 401 |
| `TestBidPlace_RoundTrip` | client sends BID_PLACE → engine called → BID_ACCEPTED returned to same conn |
| `TestBidPlace_AmountAsString` | amountCents must be string; integer literal → BID_REJECTED ERR_BAD_AMOUNT |
| `TestRoomJoin_TriggersCatchup` | ROOM_JOIN with lastSeq=10 → CATCHUP_EVENTS received with seq>10 |
| `TestRoomJoin_LargeCatchup_Fallback` | lastSeq with gap > 200 → full `ROOM_SNAPSHOT` envelope sent (same shape as initial join response, per V9 §6 "shared `$ref`") |
| `TestBroadcast_FromPubSub` | publish to `auction:<aid>:pub` → all connections in that room receive (canonical channel per proto/redis-keys.md) |
| `TestBroadcast_OnlyToJoinedRoom` | connection in room A doesn't receive room B events |
| `TestBackpressure_SoftDrop` | fill out chan past 1MB → chat dropped, bid still delivered |
| `TestBackpressure_HardClose` | fill out chan past 4MB → connection closed, force_close metric +1 |
| `TestForceClose_NotExcludedFromMetrics` | force-closed slow clients still counted in latency histogram per V9 §4.3 |
| `TestHeartbeat_PongResetsDeadline` | client sends PING every 25s → connection stays alive 60s+ |
| `TestRateLimit_PerConnection` | 1000 bids/sec from one conn → after limit, ERR_RATE_LIMITED |
| `TestPanicIsolation` | one connection's handler panics → other connections unaffected |

Coverage target: **≥80%** per V9 §9.

## NEEDS HUMAN REVIEW

1. **Catchup gap threshold**: 200 events is in V9 §4.2 ("catchup fallback `gap > 200 → snapshot`"). Tune after T2 perf smoke; the right number depends on average event size.
2. **Heartbeat interval 25s** vs spec — V9 doesn't pin a number. PR #13 ws-protocol.md doesn't either. 25s is the typical balance (faster catches dropped conns; slower saves battery on mobile). Open.
3. **Per-message vs per-connection rate limit**: I went per-connection. Per-IP might be needed if a single user opens many tabs; defer to T8 if load tests show abuse vector.
4. **Sticky routing in nginx**: V9 has multiple gateways. Without sticky, ROOM_JOIN catchup from a different gateway than the one holding the connection is fine (Stream is global), but per-connection state isn't. Solution: stateless gateways + stateful Pub/Sub fanout. nginx config in [13-observability](13-observability.md) / `infra/nginx/`.
5. **DUPLICATE wire treatment**: I built it as `BID_ACCEPTED` with `replayed: true` flag. Per PR #13 ws-protocol.md `DUPLICATE(previousResult) is a replayed idempotent ack/result, not a client rejection.` — that matches. But the protocol doesn't yet specify the `replayed` field — needs to be added to `proto/ws-envelope.md` v1.
