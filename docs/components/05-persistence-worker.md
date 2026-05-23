# Component 05 — Persistence Worker

> **Path**: `apps/lumen/internal/persistence/` + `apps/lumen/cmd/lumen/main.go` (mode=pg-writer)
> **Owner discipline**: leader; `event_hash` algorithm + canonical serialization are **all-member approve** (V9 §6).
> **Gates trunk**: T4 (Stream → MySQL idempotent + hash chain compute).
> **Cross-references**: [03-lua-scripts](03-lua-scripts.md), [08-replay-verifier](08-replay-verifier.md), `proto/db-schema.md`, `proto/evidence-card.md`.

## Purpose

Reads Redis Stream events, writes them idempotently to MySQL `auction_events`, computes the `event_hash` chain on the way through. This is where the **integrity layer** lives — Lua scripts do not compute hashes (no HMAC primitive in Redis Lua), so per #14 challenge 3 the chain is on the *projection*, not the *log*.

Single instance per cluster (consumer group `pg_writer` with one consumer = exactly-once-ish processing).

## Directory layout

```
apps/lumen/internal/persistence/
├── worker.go              type Worker; XREADGROUP loop
├── projector.go           map StreamEvent → MySQL rows
├── hash.go                event_hash = HMAC(key, prev_hash ‖ canonical(seq,type,payload))
├── canonical.go           canonical JSON serialization (sorted keys, no whitespace, RFC8785 subset)
├── idempotency.go         INSERT ... ON DUPLICATE KEY UPDATE; UNIQUE(auction_id, seq)
├── order_trigger.go       on AUCTION_SOLD → call order service
├── metrics.go             stream_lag, processed_total, hash_compute_seconds
└── worker_test.go         with real MySQL container + miniredis or real Redis
```

## Consumer group setup

On startup:
```go
// Create consumer group if not exists
err := w.redis.XGroupCreateMkStream(ctx, streamKey, "pg_writer", "0").Err()
// Ignore BUSYGROUP error (already exists)
```

Each auction has its own Stream (`auction:{<aid>}:events` — canonical per proto/redis-keys.md, materialized in PR #19). Worker can't pre-subscribe to streams that don't yet exist — uses a **scanner** to discover active auctions every 5s:

```go
func (w *Worker) discoverStreams(ctx context.Context) {
    auctionIDs, _ := w.redis.SMembers(ctx, "active:auctions").Result()
    for _, aid := range auctionIDs {
        streamKey := fmt.Sprintf("auction:{%s}:events", aid)
        if !w.subscribed[streamKey] {
            w.subscribed[streamKey] = true
            go w.consumeStream(ctx, streamKey, aid)
        }
    }
}
```

Each per-stream consumer does:
```go
func (w *Worker) consumeStream(ctx context.Context, streamKey, auctionID string) {
    consumer := "pg_writer-1"
    for {
        // Read NEW events (`>`) blocking up to 5s
        res, err := w.redis.XReadGroup(ctx, &redis.XReadGroupArgs{
            Group:    "pg_writer",
            Consumer: consumer,
            Streams:  []string{streamKey, ">"},
            Block:    5 * time.Second,
            Count:    100,
        }).Result()
        if err == redis.Nil { continue }
        if err != nil {
            w.metrics.readErr.Inc()
            time.Sleep(time.Second)
            continue
        }
        for _, stream := range res {
            for _, msg := range stream.Messages {
                if err := w.processOne(ctx, auctionID, msg); err != nil {
                    // Don't XACK on error → message redelivered to PEL
                    w.metrics.processErr.WithLabelValues("project").Inc()
                    continue
                }
                w.redis.XAck(ctx, streamKey, "pg_writer", msg.ID)
            }
        }
    }
}
```

Pending-entries-list (PEL) recovery on restart: `XAUTOCLAIM` reclaims messages older than 30s from any consumer name (including the dead previous instance).

## Key types

```go
type Worker struct {
    redis     *redis.Client
    db        *sql.DB
    hmacKey   []byte           // loaded from env at startup; startup-fails if missing
    orderClnt order.Client     // for AUCTION_SOLD trigger
    metrics   *workerMetrics
    subscribed map[string]bool
    mu        sync.Mutex
}

type StreamMessage struct {
    StreamID  string  // "<seq>-<offset>"
    Type      string
    Seq       int64
    Payload   json.RawMessage
}

type AuctionEventRow struct {
    AuctionID  string
    Seq        int64
    EventType  string
    Payload    json.RawMessage
    EventHash  string  // hex(HMAC-SHA256)
    PrevHash   string  // hex(prev event_hash); empty for seq=1
    CreatedAt  time.Time
}
```

## Key functions

### `processOne` — single event projection

```go
func (w *Worker) processOne(ctx context.Context, auctionID string, msg redis.XMessage) error {
    sm, err := parseStreamMessage(msg)
    if err != nil { return err }

    // 1. Look up previous event's hash (for chain)
    var prevHash string
    err = w.db.QueryRowContext(ctx,
        `SELECT event_hash FROM auction_events
         WHERE auction_id = ? AND seq = ? - 1`,
        auctionID, sm.Seq).Scan(&prevHash)
    if err != nil && err != sql.ErrNoRows {
        return fmt.Errorf("lookup prev_hash: %w", err)
    }
    if err == sql.ErrNoRows && sm.Seq > 1 {
        // Out-of-order delivery — Stream is in order so this shouldn't happen.
        // Defensive: error → message remains in PEL, retried.
        return fmt.Errorf("missing prev event at seq %d", sm.Seq-1)
    }

    // 2. Compute hash
    timer := prometheus.NewTimer(w.metrics.hashCompute)
    eventHash := w.computeHash(prevHash, sm)
    timer.ObserveDuration()

    // 3. Idempotent insert
    _, err = w.db.ExecContext(ctx,
        `INSERT INTO auction_events
           (auction_id, seq, event_type, payload, event_hash, prev_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE seq = seq`,  // no-op on retry; UNIQUE(auction_id, seq)
        auctionID, sm.Seq, sm.Type, sm.Payload, eventHash, prevHash, time.Now())
    if err != nil { return fmt.Errorf("insert event: %w", err) }

    // 4. Side-effects on terminal events
    switch sm.Type {
    case "AUCTION_SOLD":
        // Trigger order creation (idempotent in Order Service)
        if err := w.orderClnt.CreateForSold(ctx, auctionID, sm); err != nil {
            // Non-fatal for projection — order can be retried separately
            w.metrics.orderTriggerErr.Inc()
        }
    case "AUCTION_NO_BID", "AUCTION_CANCELLED":
        // Mark auction terminal in auctions table (for query convenience; Redis is still source)
        _, _ = w.db.ExecContext(ctx,
            `UPDATE auctions SET status = ?, terminal_at = NOW() WHERE id = ?`,
            sm.Type, auctionID)
    }

    w.metrics.processed.WithLabelValues(sm.Type).Inc()
    return nil
}
```

### `computeHash` — the integrity layer

```go
func (w *Worker) computeHash(prevHashHex string, sm StreamMessage) string {
    prev, _ := hex.DecodeString(prevHashHex)  // empty for seq=1
    canonical := canonicalSerialize(sm.Seq, sm.Type, sm.Payload)
    mac := hmac.New(sha256.New, w.hmacKey)
    mac.Write(prev)
    mac.Write(canonical)
    return hex.EncodeToString(mac.Sum(nil))
}
```

### `canonicalSerialize` — bit-identical to Replay Verifier

```go
// CRITICAL: this function MUST produce identical bytes to
// tools/replay-verifier/internal/hash/canonical.go.
// Both should import packages/shared-go/canonical/canonical.go
// to eliminate the duplication risk.
func canonicalSerialize(seq int64, eventType string, payload json.RawMessage) []byte {
    // Canonical = JCS (RFC 8785) subset: sorted keys, no whitespace, fixed types.
    m := map[string]interface{}{
        "seq":     seq,
        "type":    eventType,
        "payload": payload,  // already canonical JSON (Lua used cjson.encode with sorted keys)
    }
    out, _ := canonicaljson.Marshal(m)
    return out
}
```

**Verification**: a CI test `TestCanonicalSerialize_StableAcrossVersions` feeds 50 known inputs and asserts byte-identical outputs against fixtures. If the Go JSON library version bumps and changes serialization, the test catches it.

### `Worker.Run` — lifecycle

```go
func (w *Worker) Run(ctx context.Context) error {
    // Single-instance lease (similar to Timer Worker but key = "pg_writer:lease")
    held, err := w.lease.Acquire(ctx)
    if err != nil { return err }
    if !held { return errors.New("another pg-writer holds lease") }
    defer w.lease.Release(ctx)
    go w.lease.RefreshLoop(ctx, 500*time.Millisecond)

    // Discover streams periodically
    discoverTicker := time.NewTicker(5 * time.Second)
    defer discoverTicker.Stop()
    w.discoverStreams(ctx)

    // PEL recovery for dead consumers
    go w.recoverPELLoop(ctx)

    for {
        select {
        case <-ctx.Done():
            return nil
        case <-discoverTicker.C:
            w.discoverStreams(ctx)
        }
    }
}
```

### `recoverPELLoop` — claim dead consumer's pending messages

```go
func (w *Worker) recoverPELLoop(ctx context.Context) {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()
    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            for streamKey := range w.subscribed {
                // XAUTOCLAIM messages idle > 60s from any consumer
                _, _, _ = w.redis.XAutoClaim(ctx, &redis.XAutoClaimArgs{
                    Stream:   streamKey,
                    Group:    "pg_writer",
                    Consumer: w.instanceID,
                    MinIdle:  60 * time.Second,
                    Start:    "0",
                    Count:    100,
                }).Result()
            }
        }
    }
}
```

## Metrics emitted

- `stream_consumer_lag{stream}` — gauge: `XLEN(stream) - last_processed_id`. Alert if >1000 for 1m.
- `pg_writer_processed_total{event_type}` — counter
- `pg_writer_process_errors_total{phase}` — counter (phases: read, lookup_prev, hash, insert)
- `pg_writer_hash_compute_seconds` — histogram
- `pg_writer_insert_seconds` — histogram
- `pg_writer_order_trigger_errors_total` — counter
- `pg_writer_pel_reclaimed_total` — counter

## Error handling and recovery

- **MySQL down**: insert fails → don't XACK → message stays in PEL → retried when MySQL recovers. Stream consumer lag grows; alert fires; eventually catches up.
- **Hash mismatch on insert** (shouldn't happen since hash is computed here, but defensive): row insert succeeds; chain is broken; Replay Verifier later detects.
- **HMAC key change**: catastrophic — all future events get unverifiable hashes against old ones. Mitigation: key versioning (out of P0); for P0, don't rotate.
- **Out-of-order Stream delivery**: theoretically impossible (Stream IDs are monotonic, consumer reads in order). Defensive: `seq != prev_seq + 1` returns error → message re-queued. If persistent, manual intervention.
- **Persistence Worker crash mid-batch**: messages in PEL but not XACKed. On restart, `XAUTOCLAIM` reclaims after 60s.

## Test surface (Go)

| Test | Verifies |
|---|---|
| `TestWorker_ProcessSingleEvent` | one Stream event → one MySQL row with correct fields |
| `TestWorker_HashChain_Build` | 10 events → walk chain, all hashes verify against HMAC(key, prev ‖ canon) |
| `TestWorker_HashChain_GenesisCase` | seq=1 has empty prev_hash; HMAC computed over empty prev correctly |
| `TestWorker_Idempotent_SameEventTwice` | XAUTOCLAIM same message → INSERT ON DUPLICATE KEY no-ops; row unchanged |
| `TestWorker_OrderTriggerOnSold` | AUCTION_SOLD event → orderClient.CreateForSold called with correct args |
| `TestWorker_OrderTriggerFailure_NonFatal` | order RPC errors → event still XACKed; metric incremented |
| `TestWorker_TerminalUpdatesAuctionStatus` | AUCTION_NO_BID → auctions.status updated |
| `TestWorker_PEL_Recovery` | crash mid-processing → restart claims via XAUTOCLAIM, completes |
| `TestWorker_ConsumerLagMetric` | XADD 100 events, process 50, gauge = 50 |
| `TestCanonicalSerialize_StableAcrossVersions` | golden inputs → byte-identical outputs |
| `TestComputeHash_MatchesVerifier` | same inputs into persistence and verifier → identical hash hex |
| `TestWorker_LeaseAcquireSingleInstance` | two workers race → one wins |

Coverage target: **≥85%**.

## NEEDS HUMAN REVIEW

1. **Per-stream goroutine model**: with N active auctions, that's N goroutines. For 1k concurrent auctions, that's 1k goroutines × small XReadGroup buffers — fine. For 10k, consider work-stealing pool. Defer until needed.
2. **`active:auctions` SMembers polling 5s**: latency to start consuming a new stream. Alternative: gateway emits a "new auction created" event that worker subscribes to. Adds coupling. P0: keep poll.
3. **HMAC algorithm**: SHA256 is standard. Could use SHA512 for extra margin. SHA256 chosen for compatibility (most languages have native HMAC-SHA256).
4. **Canonical JSON library**: Go standard `encoding/json` is NOT canonical (map iteration randomization). Need `gibson042/canonicaljson-go` or similar. Pin version.
5. **Order trigger as in-process call vs RPC**: I drafted as RPC. If Order Service is in same binary (single-binary architecture), make it an in-process call to reduce latency. **My vote: in-process import for P0, expose as RPC later.**
6. **MAXLEN trim conflict with Verifier** (V9 §11 risk): Persistence Worker doesn't trim; that's a separate cron. Trimming cap = 10000 per stream; Verifier-during-load needs 50000+. Operationalize: pause trim cron during verifier runs.
