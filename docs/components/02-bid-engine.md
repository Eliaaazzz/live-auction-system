# Component 02 — Bid Engine

> **Path**: `apps/lumen/internal/bidengine/` + `apps/lumen/cmd/lumen/main.go` (mode=bid-engine)
> **Owner discipline**: leader implements; return-code mapping is **all-member approve** (V9 §6).
> **Gates trunk**: T1 (dummy bid roundtrip) → T2 (full atomic with dedupe) → T8 (perf tune to SLO).
> **Cross-references**: [03-lua-scripts](03-lua-scripts.md), `proto/ws-envelope.md`, `proto/error-codes.md`, `proto/redis-keys.md`.

## Purpose

Single-instance Go service that owns the bid command pipeline:

```
WS Gateway → (in-process or RPC) Bid Engine → EVALSHA(place_bid.lua) → return ack → fanout via Stream
```

Bid Engine is the **only** caller of `place_bid.lua` and `close_auction.lua`. Timer Worker calls into Bid Engine (RPC) rather than calling Lua directly, so all Lua-call instrumentation is in one place.

Per V9 §0 boundary: **single instance**. Horizontal scaling = future Stretch. For P0, gateway processes route to the one engine.

## Directory layout

```
apps/lumen/internal/bidengine/
├── engine.go              type Engine struct, NewEngine(), Start/Stop lifecycle
├── dispatch.go            EVALSHA wrappers per script
├── decoder.go             parse Lua return → Go types (Result struct)
├── dedupe.go              dedupe TTL refresh, NX-on-first-create
├── catchup.go             (delegates to internal/catchup) snapshot builder
├── handlers.go            handler functions called by WS Gateway: HandleBidPlace, HandleCancel
├── metrics.go             Prometheus collectors for script-time histogram, return-code counter
├── errors.go              Engine-level error types + wire mapping table
├── interface.go           type Engine interface — what gateway sees
└── engine_test.go         end-to-end with real Redis (miniredis where possible)
```

`apps/lumen/cmd/lumen/main.go` (mode=bid-engine):
```go
case "bid-engine":
    eng, err := bidengine.NewEngine(bidengine.Config{
        Redis:    cfg.RedisClient,
        LuaDir:   "lua/",
        DedupeTTL: 1 * time.Hour,
        Metrics:  reg,
    })
    must(err)
    must(eng.Start(ctx))
    rpcServer.Register(eng)  // exposed to gateway via internal RPC or shared process
    <-ctx.Done()
    eng.Stop()
```

## Key types

```go
// internal/bidengine/interface.go
type Engine interface {
    PlaceBid(ctx context.Context, req PlaceBidRequest) (PlaceBidResult, error)
    Close(ctx context.Context, auctionID string) (CloseResult, error)
    Cancel(ctx context.Context, req CancelRequest) (CancelResult, error)
    Start(ctx context.Context, auctionID string) (StartResult, error)
    Freeze(ctx context.Context, req FreezeRequest) (FreezeResult, error)
}

type PlaceBidRequest struct {
    AuctionID    string
    UserID       string
    DisplayName  string
    ClientBidID  string
    AmountCents  int64  // parsed from string at the gateway
}

type PlaceBidResult struct {
    Code         LuaCode // OK_ACCEPTED | OK_SOLD | OK_EXTENDED | DUPLICATE | ERR_*
    Seq          int64
    CurrentPrice int64
    EndAtMs      int64
    ExtendCount  int32
    Extended     bool
    Status       string
    Wire         WireAck // pre-built wire envelope to send back over WS
    Cached       bool    // true if Code == DUPLICATE
}

type LuaCode string  // see proto/error-codes.md
```

## Key functions

### `NewEngine` — startup

```go
func NewEngine(cfg Config) (*Engine, error) {
    e := &Engine{redis: cfg.Redis, dedupeTTL: cfg.DedupeTTL}
    // Load each .lua file, run SCRIPT LOAD, cache SHA1
    scripts := []string{"place_bid", "close_auction", "cancel_auction", "start_auction", "freeze_rules"}
    for _, name := range scripts {
        src, err := os.ReadFile(filepath.Join(cfg.LuaDir, name+".lua"))
        if err != nil { return nil, err }
        sha, err := e.redis.ScriptLoad(ctx, string(src)).Result()
        if err != nil { return nil, err }
        e.shas[name] = sha
    }
    e.registerMetrics(cfg.Metrics)
    return e, nil
}
```

Startup-fails if any script fails to load or any expected return code isn't covered by `decoder.go`.

### `PlaceBid` — the hot path

```go
func (e *Engine) PlaceBid(ctx context.Context, req PlaceBidRequest) (PlaceBidResult, error) {
    timer := prometheus.NewTimer(e.metricsHist.WithLabelValues("place_bid"))
    defer timer.ObserveDuration()

    keys := []string{
        fmt.Sprintf("state:{%s}", req.AuctionID),
        fmt.Sprintf("lb:{%s}", req.AuctionID),
        fmt.Sprintf("stream:{%s}", req.AuctionID),
        fmt.Sprintf("dedupe:{%s}:%s:%s", req.AuctionID, req.UserID, req.ClientBidID),
    }
    args := []interface{}{
        req.UserID,
        req.ClientBidID,
        strconv.FormatInt(req.AmountCents, 10),
        req.DisplayName,
    }

    raw, err := e.redis.EvalSha(ctx, e.shas["place_bid"], keys, args...).Result()
    if err != nil {
        // EVALSHA NOSCRIPT? reload + retry once.
        if isNoScript(err) {
            if reloadErr := e.reloadScripts(ctx); reloadErr != nil {
                return PlaceBidResult{}, fmt.Errorf("reload after NOSCRIPT: %w", reloadErr)
            }
            raw, err = e.redis.EvalSha(ctx, e.shas["place_bid"], keys, args...).Result()
        }
        if err != nil {
            e.metricsCounter.WithLabelValues("place_bid", "lua_error").Inc()
            return PlaceBidResult{}, fmt.Errorf("evalsha place_bid: %w", err)
        }
    }

    result, decodeErr := decodePlaceBidReturn(raw)
    if decodeErr != nil {
        e.metricsCounter.WithLabelValues("place_bid", "decode_error").Inc()
        return PlaceBidResult{}, decodeErr
    }

    // First-time create of dedupe entry → set TTL.
    // The Lua already HSET the ack; we set TTL out-of-band (HSET preserves TTL on subsequent writes).
    if result.Code != DUPLICATE {
        e.redis.Expire(ctx, keys[3], e.dedupeTTL) // fire-and-forget; ignore error
    }

    // Build wire envelope based on code.
    result.Wire = e.buildWireAck(req, result)

    e.metricsCounter.WithLabelValues("place_bid", string(result.Code)).Inc()
    return result, nil
}
```

### `decodePlaceBidReturn` — Lua → Go boundary

```go
// Lua returns: [code, payload_json] OR [code, ...extra_fields]
func decodePlaceBidReturn(raw interface{}) (PlaceBidResult, error) {
    arr, ok := raw.([]interface{})
    if !ok || len(arr) == 0 {
        return PlaceBidResult{}, errors.New("lua returned non-array")
    }
    code := LuaCode(toString(arr[0]))

    switch code {
    case OK_ACCEPTED, OK_SOLD, OK_EXTENDED, DUPLICATE:
        if len(arr) < 2 {
            return PlaceBidResult{}, fmt.Errorf("missing payload for %s", code)
        }
        var p luaPayload
        if err := json.Unmarshal([]byte(toString(arr[1])), &p); err != nil {
            return PlaceBidResult{}, fmt.Errorf("decode payload: %w", err)
        }
        return PlaceBidResult{
            Code:         code,
            Seq:          p.Seq,
            CurrentPrice: parseCents(p.AmountCents),
            EndAtMs:      p.EndAtMs,
            ExtendCount:  p.ExtendCount,
            Extended:     p.Extended,
            Status:       p.Status,
            Cached:       code == DUPLICATE,
        }, nil

    case ERR_NOT_LIVE, ERR_AFTER_END, ERR_TOO_LOW, ERR_AUCTION_PAUSED:
        // extras for diagnostics, not surfaced to client
        return PlaceBidResult{Code: code}, nil

    default:
        return PlaceBidResult{}, fmt.Errorf("unknown lua code: %s", code)
    }
}
```

### `buildWireAck` — Lua code → wire envelope

```go
func (e *Engine) buildWireAck(req PlaceBidRequest, r PlaceBidResult) WireAck {
    switch r.Code {
    case OK_ACCEPTED, OK_EXTENDED:
        return WireAck{Type: "BID_ACCEPTED", Seq: r.Seq, Data: bidAcceptedData(req, r)}
    case OK_SOLD: // cap hit
        return WireAck{Type: "BID_ACCEPTED", Seq: r.Seq, Data: bidAcceptedData(req, r)}
        // AUCTION_SOLD will be delivered separately as the room broadcast from the stream
    case DUPLICATE:
        return WireAck{Type: "BID_ACCEPTED", Seq: r.Seq, Data: bidAcceptedData(req, r), Replayed: true}
    case ERR_NOT_LIVE, ERR_AFTER_END, ERR_TOO_LOW, ERR_AUCTION_PAUSED:
        return WireAck{Type: "BID_REJECTED", Data: map[string]string{
            "code": string(r.Code),
            "clientBidId": req.ClientBidID,
        }}
    default:
        return WireAck{Type: "BID_REJECTED", Data: map[string]string{"code": "ERR_INTERNAL"}}
    }
}
```

### `Close` — Timer Worker entry

```go
func (e *Engine) Close(ctx context.Context, auctionID string) (CloseResult, error) {
    // similar to PlaceBid but EVALSHA close_auction
    // On ERR_NOT_DUE, return result without error — Timer Worker retries next scan tick.
    // On ERR_ALREADY_TERMINAL, return result without error — Timer Worker treats as idempotent.
    ...
}
```

## Dedupe TTL strategy

- TTL set by Engine after first successful PlaceBid (Lua doesn't manage TTL — that's app concern).
- TTL = max auction duration + 30 min buffer. Default: 1 hour.
- HSET in Lua + EXPIRE in Go is racy if a second retry arrives between HSET and EXPIRE. Mitigation: use Lua's `HSET k f v` then `EXPIRE` as a separate call right after — the dedupe ack is preserved regardless (HSET overwrites the same field with the same value on retry; TTL is just re-applied).
- Edge case: server crash between Lua HSET and Go EXPIRE → dedupe entry has no TTL, persists forever. Mitigation: `redis-cli SCAN` cleanup job in `tools/seed/cleanup.go` runs on engine startup, sets TTL on any TTL-less dedupe keys.

## Error handling

- **Redis down** → all EVALSHA fail. Engine sets `paused=true` on Redis-back recovery via separate paused-flag manager (see [13-observability](13-observability.md)). Engine returns `ERR_AUCTION_PAUSED` for the duration. Client sees the wire code and shows "Auction temporarily paused".
- **NOSCRIPT** (Redis restarted, lost cache) → automatic reload + single retry.
- **Decode error** (Lua return changed without engine update) → log + counter + return ERR_INTERNAL. CI test `TestDecodeAllReturnCodes` fails on any new code without decoder support.
- **Context cancellation** (gateway client disconnected during EVALSHA) → engine still completes the Lua call (atomic in Redis); ack is cached in dedupe; client retry pattern recovers.

## Test surface (Go)

| Test | Verifies |
|---|---|
| `TestEngine_PlaceBid_E2E` | full path: WS message → engine.PlaceBid → Redis state mutated, Stream entry written, ack returned |
| `TestEngine_PlaceBid_NoScriptRecovery` | flush Redis SCRIPT cache; next bid still succeeds via auto-reload |
| `TestEngine_PlaceBid_DedupeTTL` | retry after 100ms → cached ack; retry after TTL → fresh accept |
| `TestEngine_Close_NotDue_NoError` | engine.Close on LIVE+not-due returns result, no error — Timer Worker treats as retry |
| `TestEngine_HammerRace` | 100 concurrent PlaceBid + 1 Close at endAtMs; exactly one OK_SOLD from Close, all PlaceBid after endAtMs return ERR_AFTER_END |
| `TestEngine_DecodeAllReturnCodes` | for each LuaCode in error-codes.md, decoder produces a valid PlaceBidResult |
| `TestEngine_LuaErrorIncrementsMetric` | force a Lua error (e.g. inject bad ARGV); counter increments; returned err |
| `TestEngine_MetricsCardinality` | run 10k bids; assert label cardinality on `lua_script_duration_seconds` stays bounded |

Coverage target: **≥80%** per V9 §9.

## NEEDS HUMAN REVIEW

1. **In-process vs RPC between Gateway and Engine**: simplest is in-process if they share the binary (mode=gateway and mode=bid-engine in same process), but the trunk plan has them as separate processes for scaling. Need to pick: gRPC, Connect-RPC, or shared Redis queue. **My recommendation: Connect-RPC over HTTP/2** — typed, easy to mock, fits Go ecosystem. Performance overhead ~50µs, within budget.
2. **Backpressure on slow Engine**: if EVALSHA p99 spikes (Redis pause / network), gateway accumulates pending requests. Need explicit timeout (default 200ms) and `ERR_ENGINE_TIMEOUT` wire code. Currently not in proto/error-codes.md.
3. **Cap-hit terminal**: see [03-lua-scripts NEEDS HUMAN REVIEW #2](03-lua-scripts.md) — Engine treats `OK_SOLD` from place_bid same as from close_auction; downstream Order Service can't tell the difference. That's fine but document it.
