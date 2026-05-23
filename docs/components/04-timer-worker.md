# Component 04 — Timer Worker

> **Path**: `apps/lumen/internal/timer/` + `apps/lumen/cmd/lumen/main.go` (mode=timer)
> **Owner discipline**: leader; scan interval and lease are **all-member approve** if they affect SLO budget (V9 §6).
> **Gates trunk**: T3 (hammer-by-time without depending on next bid).
> **Cross-references**: [03-lua-scripts](03-lua-scripts.md), [02-bid-engine](02-bid-engine.md), `proto/redis-keys.md`.

## Purpose

Timer Worker is the *only* component that triggers `close_auction.lua` when an auction's `endAtMs` has elapsed. The whole point of having it is to break the "hammer-on-next-bid" anti-pattern: an auction with no late bidder must still close on time. Per V9: hammer p95 < 500ms budget = scan interval 100ms + detection-lag ≤ 120ms + Lua + fanout.

Single instance per cluster (uses Redis lease to prevent split-brain if Timer accidentally runs in two pods).

## Directory layout

```
apps/lumen/internal/timer/
├── worker.go              type Worker; main scan loop
├── scanner.go             ZRANGEBYSCORE active timers
├── lease.go               SET NX EX lease, refresh, release
├── dispatch.go            calls bidengine.Close via RPC
├── metrics.go             detection_lag_ms histogram, scan_duration histogram
└── worker_test.go         with miniredis + faketime
```

## Active timer index

Single Redis Sorted Set: `active:timers` with member = `auctionID`, score = `endAtMs`.

- Added on `start_auction.lua` success: `ZADD active:timers <endAtMs> <aid>`.
- Updated on anti-snipe extend: `ZADD active:timers <new_endAtMs> <aid>` (ZADD with score replaces).
- Removed after `close_auction.lua` success: `ZREM active:timers <aid>`.
- Removed after `cancel_auction.lua` success: `ZREM active:timers <aid>`.

**Hash tag exception**: this set is global (not per-auction), so no `{<aid>}` tag. The Lua scripts that touch it (`start_auction`, `cancel_auction`, anti-snipe extend in `place_bid`, `close_auction`) need to **call ZADD/ZREM separately** because cross-slot Lua is forbidden. Bid Engine wraps each Lua call with a follow-up ZADD/ZREM in Go — racy but acceptable because the Lua already determined the auction state.

**Better alternative (NEEDS HUMAN REVIEW)**: move the timer index into the same Redis slot via `active:timers:{global}` and accept that there's only one slot — fine for one Redis primary in P0.

## Key types

```go
type Worker struct {
    redis     *redis.Client
    engine    bidengine.Engine  // RPC client to Bid Engine
    leaseTTL  time.Duration     // 5 * scan interval, e.g. 500ms
    scanEvery time.Duration     // 100ms per V9 §4.2 budget
    metrics   *workerMetrics
}

type DueAuction struct {
    AuctionID string
    EndAtMs   int64
}
```

## Key functions

### `Worker.Run` — main loop

```go
func (w *Worker) Run(ctx context.Context) error {
    // Acquire lease (only one Timer instance globally)
    held, err := w.lease.Acquire(ctx)
    if err != nil { return err }
    if !held {
        return errors.New("another timer instance holds the lease; exiting")
    }
    defer w.lease.Release(ctx)

    // Refresh lease in background
    go w.lease.RefreshLoop(ctx, w.scanEvery)

    ticker := time.NewTicker(w.scanEvery)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return nil
        case <-ticker.C:
            w.scanAndDispatch(ctx)
        }
    }
}
```

### `Worker.scanAndDispatch`

```go
func (w *Worker) scanAndDispatch(ctx context.Context) {
    scanStart := time.Now()
    nowMs := scanStart.UnixMilli()

    // Find all auctions with endAtMs <= now
    due, err := w.scanner.DueBefore(ctx, nowMs)
    if err != nil {
        w.metrics.scanErr.Inc()
        return
    }

    for _, d := range due {
        // Spawn goroutine per auction so a slow Close doesn't block others.
        // Bound concurrency to avoid Redis overload.
        w.semaphore <- struct{}{}
        go func(d DueAuction) {
            defer func() { <-w.semaphore }()
            w.closeOne(ctx, d, nowMs)
        }(d)
    }
    w.metrics.scanDuration.Observe(time.Since(scanStart).Seconds())
}

func (w *Worker) closeOne(ctx context.Context, d DueAuction, scanNowMs int64) {
    // detection_lag_ms = how late we detected vs ground truth endAtMs
    detectionLag := scanNowMs - d.EndAtMs
    w.metrics.detectionLag.Observe(float64(detectionLag))

    result, err := w.engine.Close(ctx, d.AuctionID)
    if err != nil {
        w.metrics.closeErr.WithLabelValues("rpc_error").Inc()
        return
    }
    switch result.Code {
    case "OK_SOLD", "OK_NO_BID":
        w.redis.ZRem(ctx, "active:timers", d.AuctionID)
        w.metrics.closed.WithLabelValues(string(result.Code)).Inc()
    case "ERR_NOT_DUE":
        // Race: anti-snipe extended endAtMs between scan and close.
        // Next scan will see updated score and try again. Don't ZREM.
        w.metrics.closeRetry.Inc()
    case "ERR_ALREADY_TERMINAL":
        // Another close path won (cap-hit terminal in place_bid; or duplicate scan).
        w.redis.ZRem(ctx, "active:timers", d.AuctionID)
        w.metrics.closeIdempotent.Inc()
    default:
        w.metrics.closeErr.WithLabelValues("unknown_code").Inc()
    }
}
```

### `scanner.DueBefore`

```go
func (s *Scanner) DueBefore(ctx context.Context, nowMs int64) ([]DueAuction, error) {
    // Use ZRANGEBYSCORE with limit to bound a single scan's work
    raw, err := s.redis.ZRangeByScoreWithScores(ctx, "active:timers", &redis.ZRangeBy{
        Min:   "-inf",
        Max:   strconv.FormatInt(nowMs, 10),
        Count: 256,  // process at most 256 due auctions per scan tick
    }).Result()
    if err != nil { return nil, err }

    out := make([]DueAuction, 0, len(raw))
    for _, z := range raw {
        out = append(out, DueAuction{
            AuctionID: z.Member.(string),
            EndAtMs:   int64(z.Score),
        })
    }
    return out, nil
}
```

### `lease.Acquire` / `Refresh` / `Release`

```go
func (l *Lease) Acquire(ctx context.Context) (bool, error) {
    ok, err := l.redis.SetNX(ctx, "timer:lease", l.instanceID, l.ttl).Result()
    return ok, err
}

func (l *Lease) RefreshLoop(ctx context.Context, every time.Duration) {
    ticker := time.NewTicker(every / 2)  // refresh at half-ttl to be safe
    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            // Refresh only if we still hold the lease (instanceID match)
            script := `
                if redis.call('GET', KEYS[1]) == ARGV[1] then
                    return redis.call('PEXPIRE', KEYS[1], ARGV[2])
                end
                return 0
            `
            l.redis.Eval(ctx, script, []string{"timer:lease"}, l.instanceID, l.ttl.Milliseconds())
        }
    }
}

func (l *Lease) Release(ctx context.Context) error {
    // Only release if we still own
    script := `
        if redis.call('GET', KEYS[1]) == ARGV[1] then
            return redis.call('DEL', KEYS[1])
        end
        return 0
    `
    return l.redis.Eval(ctx, script, []string{"timer:lease"}, l.instanceID).Err()
}
```

## Detection-lag SLO instrumentation

Per V9 §4.2: scan 100ms → detection-lag ≤ 120ms (allowance for one missed tick + jitter).

Histogram buckets: `[10, 25, 50, 75, 100, 120, 150, 250, 500, 1000]` ms.

Alert: `histogram_quantile(0.95, timer_detection_lag_ms_bucket) > 120` for 1m.

Mitigation if alert fires:
- Check `scan_duration_ms` — if scan itself > 50ms, the index may be too large; investigate.
- Check `go_gc_pause_seconds` — if GC stalling >100ms, tune `GOGC` or upgrade box.
- Worst case: reduce scan interval to 50ms (doubles Redis read load but halves max lag).

## Error handling

- **Bid Engine RPC fails**: Timer Worker keeps trying on next scan. Auction stays in `active:timers`; lag grows. Alert fires.
- **Lease lost** (network partition → refresh failed): goroutine detects via `GET timer:lease != instanceID`, exits cleanly. Another instance can acquire on next start.
- **ZRem after close fails**: stale entry in `active:timers`. Next scan calls Close again; engine returns `ERR_ALREADY_TERMINAL`; we ZRem then. Self-healing.
- **Auction stuck**: if same auction returns `ERR_NOT_DUE` for >10 consecutive scans, log warning (anti-snipe loop suspected). Operator can investigate.

## Test surface (Go)

| Test | Verifies |
|---|---|
| `TestWorker_LeaseAcquireSingleInstance` | two workers race for lease; only one wins |
| `TestWorker_LeaseRefreshKeepsAlive` | lease TTL doesn't expire while worker active |
| `TestWorker_LeaseLostExitsCleanly` | force-delete lease key; refresh loop detects, worker exits |
| `TestWorker_ScanFindsDueAuctions` | ZADD 3 auctions with past endAtMs; scan returns all 3 |
| `TestWorker_ScanRespectsCount` | ZADD 1000; one scan returns ≤256 |
| `TestWorker_CloseSold` | due auction with bids → engine.Close returns OK_SOLD → ZRem |
| `TestWorker_CloseNoBid` | due auction without bids → OK_NO_BID → ZRem |
| `TestWorker_AntiSnipeRace_NotDueRetried` | engine returns ERR_NOT_DUE; ZRem NOT called; next scan retries |
| `TestWorker_AlreadyTerminal_ZRemmed` | engine returns ERR_ALREADY_TERMINAL; ZRem called |
| `TestWorker_DetectionLagMeasured` | inject scan delay; histogram observed value > 0 |
| `TestWorker_RPCFailure_Retries` | engine RPC errors; next scan calls again |
| `TestWorker_ConcurrentCloseBounded` | 100 due auctions; semaphore holds Redis pressure |

Coverage target: **≥85%**.

## NEEDS HUMAN REVIEW

1. **Single Timer instance** (per V9): fine for P0. Restart time = ~1s. Means up to 1s of detection-lag during restart. Acceptable. Document in runbook.
2. **Cross-slot `active:timers` set**: today this is one global key. Won't scale to Redis Cluster (Stretch). For P0, single Redis primary makes it moot. Flag for Cluster Stretch design.
3. **256 per-scan cap**: bumps to next scan if more due. Worst case during a "lots of auctions ending at once" scenario, detection-lag grows. Mitigation: dynamically size cap based on `len(due)/scanEvery`. P0: cap at 256, scan every 100ms = 2560/sec capacity, way more than 1k concurrent auctions.
4. **Scan jitter**: `time.NewTicker` jitter is OS-dependent. For tight SLO, replace with sleep-until-next-100ms-boundary. Defer until T8 if lag histogram shows issue.
5. **Anti-snipe loop detection**: 10 consecutive `ERR_NOT_DUE` → warning. Threshold arbitrary; tune in T8.
