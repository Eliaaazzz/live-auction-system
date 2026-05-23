# Component 14 — Chaos Engineering

> **Path**: `tools/chaos-runner/`, `apps/lumen/internal/chaos/`, `scripts/chaos/`, `infra/toxiproxy/`, `infra/docker-compose.chaos.yml`
> **Owner discipline**: leader builds; scenario list + assertion invariants are **all-member approve** (V9 §6).
> **Gates trunk**: T9 (5 fault drills with recorded artifacts).
> **Cross-references**: V9 §4.4 (5 fault recordings demo-required), V9 §9 (assertable logs per chaos run), [02-bid-engine](02-bid-engine.md), [08-replay-verifier](08-replay-verifier.md).

## Purpose

V9 demands **5 fault drills** (MySQL / WS / Timer / AI / Redis) in T9, each with:
- Recorded video for demo (≤30s clip per phase)
- Assertable log artifact (per V9 §9) — not just video, machine-checked invariants
- Verifier still returns `consistent` after the drill ends (system self-heals)

Per #14 challenge 12, `kill -9` isn't enough. We need proper network-level chaos plus in-process awareness so the engine logs "this disconnect is a drill" rather than panicking.

## Directory layout

```
tools/chaos-runner/
├── cmd/runner/main.go         CLI; --phase <p> --duration <d>
├── internal/
│   ├── orchestrator.go        flag setter + toxiproxy controller + assertion runner
│   ├── phases/
│   │   ├── redis.go           Redis pause / drop
│   │   ├── mysql.go           MySQL down / slow
│   │   ├── ws.go              gateway kill / slow
│   │   ├── timer.go           timer worker kill
│   │   └── ai.go              ai-sidecar 503
│   ├── invariants/
│   │   ├── seq_no_gap.go      assertion: seq monotonic across drill window
│   │   ├── verifier.go        post-drill: tools/replay-verifier consistent
│   │   ├── recovery.go        next bid after drill end → OK_ACCEPTED
│   │   └── degrade.go         during drill: bid → ERR_AUCTION_PAUSED (Redis case)
│   └── artifact/
│       ├── recorder.go        captures process logs + metrics snapshots
│       └── writer.go          emits chaos-run-<phase>-<timestamp>.json
└── README.md

apps/lumen/internal/chaos/
├── flags.go                   in-process flags read from env at startup + refreshed on SIGHUP
├── inject.go                  hooks the bidengine/timer/persistence to honor flags
└── flags_test.go

infra/toxiproxy/
├── toxiproxy.json             proxies for Redis (16379), MySQL (13306)
└── README.md

scripts/chaos/
├── redis.sh                   wraps `chaos-runner --phase redis`
├── mysql.sh
├── ws.sh
├── timer.sh
└── ai.sh
```

## Toxiproxy setup

`infra/docker-compose.chaos.yml` adds:
```yaml
services:
  toxiproxy:
    image: ghcr.io/shopify/toxiproxy:2.9.0
    command: -config /etc/toxiproxy/toxiproxy.json -host 0.0.0.0
    volumes:
      - ./toxiproxy:/etc/toxiproxy
    ports:
      - "8474:8474"  # admin API
      - "16379:16379"  # Redis proxy
      - "13306:13306"  # MySQL proxy
```

Compose `lumen` service `REDIS_URL` and `MYSQL_URL` point to the proxy ports when running in chaos mode. Toxiproxy admin API at `:8474` lets the runner inject latency / drop / disable in real time:

```bash
# Pause Redis access (no packets flow)
curl -X POST localhost:8474/proxies/redis/toxics \
  -d '{"type":"timeout","attributes":{"timeout":0},"name":"pause"}'

# Disable entirely (TCP RST)
curl -X POST localhost:8474/proxies/redis -d '{"enabled":false}'
```

## In-process chaos flags

Some scenarios need the engine to know "this is a drill" so it logs cleanly instead of panicking:

```go
// apps/lumen/internal/chaos/flags.go
type Flags struct {
    PauseAcceptingBids   atomic.Bool  // simulate Redis-pause without actually killing Redis
    SimulateAIDown       atomic.Bool  // sidecar returns 503 even if alive
    InjectSlowBid        atomic.Int64 // ms to sleep before EVALSHA (test backpressure)
}

func LoadFromEnv() *Flags { ... }
func (f *Flags) ReloadOnSIGHUP() { ... }
```

Bid Engine consults `chaos.Flags.PauseAcceptingBids` before EVALSHA:
```go
if chaos.PauseAcceptingBids.Load() {
    slog.Info("chaos: bid paused", "phase", "redis-pause")
    return PlaceBidResult{Code: "ERR_AUCTION_PAUSED"}, nil
}
```

Gives us the same observable behavior as Redis being down, without the recovery latency cost when we want to test the bid-side response specifically.

## The 5 phases

### Phase 1: Redis pause/drop

**Inject**: Toxiproxy disables Redis proxy (TCP RST on existing conns; new conns refused).
**Duration**: 5 seconds.

**Expected behavior**:
- Existing bids in flight return Redis errors → engine maps to `ERR_AUCTION_PAUSED`
- Active conns stay open but receive `BID_REJECTED ERR_AUCTION_PAUSED` for new bids
- Timer Worker scan errors are silent (retry on next tick)
- Persistence Worker XReadGroup errors → backs off
- After Toxiproxy re-enables: next bid succeeds with continuous `seq`

**Assertions**:
- During drill: ≥1 `BID_REJECTED ERR_AUCTION_PAUSED` observed
- After drill: `OK_ACCEPTED` resumes within 5s
- After drill: `tools/replay-verifier --mode settled` returns `consistent`
- No `seq_gap > 0` anywhere in the window

### Phase 2: MySQL down

**Inject**: Toxiproxy disables MySQL proxy.
**Duration**: 30 seconds.

**Expected behavior**:
- Bidding continues normally (MySQL not on hot path per V9)
- Stream events still written to Redis
- Persistence Worker fails inserts → events stay in PEL
- After MySQL recovers: Persistence Worker XAUTOCLAIM + replays backlog

**Assertions**:
- During drill: `lumen_bidengine_return_code_total{code="OK_ACCEPTED"}` continues increasing (bidding unaffected)
- During drill: `lumen_persistence_consumer_lag` grows
- After drill: lag returns to 0 within 30s
- After drill: `replay-verifier --mode settled` `consistent`

### Phase 3: WebSocket gateway kill

**Inject**: `docker compose kill -s SIGKILL lumen_gateway_1` (one of 2-3 gateways).
**Duration**: until next docker-compose restart (typically <5s).

**Expected behavior**:
- Connections on that gateway lose connection → client reconnect logic kicks in
- Reconnect lands on a different gateway → `ROOM_JOIN` with `lastSeq` → catchup
- All clients receive missed events
- No bids lost (Stream is canonical, Pub/Sub is hint)

**Assertions**:
- During drill: existing connections show `close` event
- After reconnect: each client receives `CATCHUP_EVENTS` with seqs > lastSeq
- Catchup duration < 1s per client
- `replay-verifier --mode in-flight` returns `consistent` (or `lagging` only on MySQL side)

### Phase 4: Timer Worker kill

**Inject**: `docker compose kill -s SIGKILL lumen_timer_1`.
**Duration**: 10 seconds before compose restarts it.

**Expected behavior**:
- During the gap: no hammer happens — auctions whose endAtMs passes stay in LIVE
- After restart: Timer acquires lease, picks up backlog, fires close_auction for each overdue
- Detection lag spikes for backlog but seq still continuous

**Assertions**:
- During drill: any auction with endAtMs in the window stays LIVE (no premature SOLD)
- After restart: SOLD events fire for backlog with seq continuous
- `lumen_timer_detection_lag_ms` spikes during recovery but returns to normal
- No bids accepted at `now >= endAtMs` during the window (the `place_bid.lua` `ERR_AFTER_END` check still works because endAtMs is checked against Redis TIME, not Timer state)

### Phase 5: AI sidecar 503

**Inject**: `docker compose kill -s SIGTERM ai_sidecar` (clean shutdown).
**Duration**: 15 seconds.

**Expected behavior**:
- `/healthz` returns non-2xx
- Admin UI badge shows "AI offline"
- Auctioneer triggers fail silently — no bubbles for the trigger
- Bidding completely unaffected
- After sidecar restart: badge flips green; next trigger fires normally

**Assertions**:
- During drill: `ai_circuit_state` gauge moves to open (2)
- During drill: zero `AUCTION_AI_BUBBLE` events delivered (verified by client subscriber)
- During drill: `lumen_bidengine_return_code_total{code="OK_ACCEPTED"}` continues
- After drill: circuit returns to closed within 30s; new auctioneer trigger succeeds

## Chaos Runner — the assertion harness

```go
// internal/orchestrator.go
type Runner struct {
    auctionID string
    phase     string
    duration  time.Duration
    toxi      *toxiproxy.Client
    flags     *chaos.Flags
    artifact  *artifact.Recorder
}

func (r *Runner) Run(ctx context.Context) error {
    r.artifact.Start(r.phase, r.auctionID)
    defer r.artifact.Finish()

    // 1. Capture baseline metrics
    pre := r.artifact.SnapshotMetrics()

    // 2. Inject the fault
    if err := r.inject(); err != nil { return err }

    // 3. Spawn a load generator that keeps bidding throughout the drill
    bidGen := bidgen.NewSteady(r.auctionID, 5 /* bids/sec */)
    bidGen.Start(ctx)

    // 4. Wait for duration
    time.Sleep(r.duration)

    // 5. Undo the fault
    r.uninject()

    // 6. Give system 30s to recover
    time.Sleep(30 * time.Second)
    bidGen.Stop()

    // 7. Capture post-state metrics
    post := r.artifact.SnapshotMetrics()
    r.artifact.RecordMetricsDiff(pre, post)

    // 8. Run invariant checks
    invs := r.invariantsFor(r.phase)
    for _, inv := range invs {
        ok, msg := inv.Check(ctx, r.auctionID)
        r.artifact.RecordInvariant(inv.Name(), ok, msg)
        if !ok {
            slog.Error("invariant failed", "phase", r.phase, "inv", inv.Name(), "msg", msg)
        }
    }

    // 9. Final verifier run
    verifierResult := runVerifier(ctx, r.auctionID, "settled")
    r.artifact.RecordVerifier(verifierResult)

    return nil
}
```

### Invariants

Each invariant is a small function returning `(passed bool, message string)`. They're chosen based on phase but include common ones (seq gap, post-verifier).

```go
type Invariant interface {
    Name() string
    Check(ctx context.Context, auctionID string) (bool, string)
}

// invariants/seq_no_gap.go
type SeqNoGap struct{ redis *redis.Client }

func (s *SeqNoGap) Name() string { return "seq_no_gap" }
func (s *SeqNoGap) Check(ctx context.Context, auctionID string) (bool, string) {
    entries, err := s.redis.XRange(ctx, fmt.Sprintf("stream:{%s}", auctionID), "-", "+").Result()
    if err != nil { return false, err.Error() }
    var prevSeq int64
    for _, e := range entries {
        seq := parseSeq(e.ID)
        if prevSeq > 0 && seq != prevSeq+1 && seq != prevSeq /* allow synthetic <seq>-1 */ {
            return false, fmt.Sprintf("gap at seq=%d (prev=%d)", seq, prevSeq)
        }
        prevSeq = seq
    }
    return true, "ok"
}
```

### Artifact format

```json
{
  "phase": "redis",
  "auction_id": "demo-1",
  "started_at": "2026-06-05T10:30:00Z",
  "duration_ms": 5000,
  "metrics_before": { "ack_p95": 0.045, "seq_max": 423 },
  "metrics_after": { "ack_p95": 0.048, "seq_max": 489 },
  "events_during_drill": [
    {"t": "10:30:01.123Z", "type": "BID_REJECTED", "code": "ERR_AUCTION_PAUSED"},
    {"t": "10:30:01.456Z", "type": "BID_REJECTED", "code": "ERR_AUCTION_PAUSED"}
  ],
  "invariants": [
    {"name": "seq_no_gap", "passed": true, "message": "ok"},
    {"name": "recovery_within_5s", "passed": true, "message": "first OK_ACCEPTED at +2.1s"},
    {"name": "degrade_observed", "passed": true, "message": "12 ERR_AUCTION_PAUSED during drill"}
  ],
  "verifier_post": { "verdict": "consistent", "events": 489 }
}
```

This JSON goes in `docs/demo/chaos-recordings/redis-2026-06-05.json` next to the video clip.

## Demo integration

For T10 demo, each phase has:
- 30s screen recording showing UI behavior during drill
- The runner's JSON artifact
- A 1-paragraph summary in `docs/demo-script.md` explaining what to look for

Operator runs `make chaos PHASE=redis` during the demo or pre-records. P0: pre-record + show during demo. P1: live demo.

## Test surface (Go)

| Test | Verifies |
|---|---|
| `TestInvariantSeqNoGap_NoGap` | sequential seqs → passes |
| `TestInvariantSeqNoGap_GapDetected` | inject seq skip → fails with message |
| `TestInvariantRecovery_OkAfterDrill` | mock metric showing OK_ACCEPTED after drill end → passes |
| `TestPhaseRedis_FlagToggleVsToxiproxy` | both paths set chaos state correctly |
| `TestRunner_ArtifactSchema` | run a mock drill → emitted JSON matches schema |
| `TestRunner_VerifierIntegration` | post-drill verifier called with `--mode settled` |
| `TestToxiproxyClient_PauseRedis` | call admin API → proxy disabled |

Coverage target: **≥75%**.

## NEEDS HUMAN REVIEW

1. **Order matters during demo**: do all 5 sequentially or run a single auction through all 5? P0 demo: pre-recorded individually for clarity. P1: chained.
2. **Auction quietness during drill**: the steady-bid generator (5 bids/sec) keeps activity visible. Could go higher but at 50+/sec drill effects are harder to read on video.
3. **Toxiproxy compose-only**: produces a different REDIS_URL in chaos mode. Need flag in compose to switch. Easier: compose profile `chaos` with overrides.
4. **`AUCTION_AI_BUBBLE` event**: I referenced this. Check if it's named consistently in `proto/ai-events.md`. Could be `AI_AUCTIONEER` per the [09-ai-sidecar](09-ai-sidecar.md) doc. Align before code.
5. **Demo recording tool**: OBS or asciinema for terminal; built-in macOS for screen. Document in runbook.
