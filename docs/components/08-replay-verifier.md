# Component 08 — Replay Verifier

> **Path**: `tools/replay-verifier/`
> **Owner discipline**: leader implements; mode semantics + exit-code mapping are **all-member approve** (P0 deliverable per V9 §6).
> **Gates trunk**: T6.
> **Cross-references**: `proto/evidence-card.md`, [05-persistence-worker](05-persistence-worker.md), [03-lua-scripts](03-lua-scripts.md).

## Purpose

Independent CLI tool that proves **three-way consistency** between the canonical event log (Redis Stream), the live state (Redis Hash/Sorted Set), and the durable projection (MySQL `auction_events`). It's the single strongest correctness evidence the demo can show: "we don't just say the system is consistent — here's a tool that verifies it."

This is also the place where **hash chain integrity** is checked: walk `auction_events` in seq order, recompute each `event_hash = HMAC(key, prev_hash ‖ canonical(seq, type, payload))`, and confirm the chain matches.

Per #14 challenge 11, the tool has **two modes** because in-flight comparison is racy:

| Mode | Semantic | Exit |
|---|---|---|
| `--in-flight` | Stream canonical. Reduce events → expected Redis state. MySQL allowed to lag (report, don't fail). | `consistent` or `redis_diverged` |
| `--settled` (default; assumes auction is terminal) | All three sources must match exactly. | `consistent` / `mismatch_at_seq=X` / `hash_break_at_seq=Y` |

CI runs `--settled` against seeded terminal auctions. Demo runs `--settled` against the auction just completed in the demo. T8 post-load runs `--settled` against the load-test auction after it has hammered.

## Directory layout

```
tools/replay-verifier/
├── cmd/verify/main.go         CLI entry: flags --auction, --mode, --json
├── internal/
│   ├── stream/                read Stream events for an auction
│   ├── redis/                 read live Redis Hash+Sorted Set
│   ├── mysql/                 read auction_events + auctions tables
│   ├── reducer/               apply events → expected state (pure function)
│   ├── hash/                  HMAC recomputation + chain walk
│   ├── diff/                  compare results, locate first divergence
│   └── report/                format human + JSON output
├── testdata/                  golden auctions + their expected verifier output
├── go.mod
├── README.md
└── Dockerfile                  containerized so `make verify` works without local Go
```

## Key types

```go
// internal/reducer/state.go
type ExpectedState struct {
    Status            string
    CurrentPriceCents int64
    TopUserID         string
    EndAtMs           int64
    ExtendCount       int32
    Seq               int64
    Leaderboard       []LeaderboardEntry
    EventCount        int
}

// internal/stream/event.go
type StreamEvent struct {
    StreamID string  // "<seq>-<offset>"
    Seq      int64
    Type     string  // BID_ACCEPTED, AUCTION_EXTENDED, AUCTION_SOLD, AUCTION_NO_BID, AUCTION_CANCELLED, AUCTION_STARTED, AUCTION_FROZEN
    Payload  json.RawMessage
}

// internal/diff/result.go
type VerifierResult struct {
    AuctionID    string
    Mode         string  // "in-flight" | "settled"
    Verdict      Verdict // "consistent" | "redis_diverged" | "mysql_diverged" | "hash_break" | "lagging"
    FirstMismatch *Mismatch
    Sources      SourceSnapshot
    Timing       Timing
}

type Verdict string
const (
    Consistent      Verdict = "consistent"
    RedisDiverged   Verdict = "redis_diverged"
    MysqlDiverged   Verdict = "mysql_diverged"
    HashBreak       Verdict = "hash_break"
    Lagging         Verdict = "lagging"
)

type Mismatch struct {
    Source string  // "redis" | "mysql"
    Seq    int64   // first seq where state diverges
    Field  string  // which field
    Expected interface{}
    Actual   interface{}
}
```

## Key functions

### `Verify` — main entry

```go
func Verify(ctx context.Context, cfg Config) (*VerifierResult, error) {
    // 1. Snapshot all three sources at approximately the same wall-clock time
    streamEvents, err := stream.ReadAll(ctx, cfg.Redis, cfg.AuctionID)
    if err != nil { return nil, fmt.Errorf("read stream: %w", err) }

    redisState, err := redisstate.Read(ctx, cfg.Redis, cfg.AuctionID)
    if err != nil { return nil, fmt.Errorf("read redis state: %w", err) }

    mysqlEvents, mysqlAuction, err := mysqlstate.Read(ctx, cfg.MySQL, cfg.AuctionID)
    if err != nil { return nil, fmt.Errorf("read mysql: %w", err) }

    // 2. Reduce Stream events → expected state (deterministic from the log alone)
    expected := reducer.Apply(streamEvents)

    // 3. Compare expected vs Redis
    redisDiff := diff.Compare(expected, redisState)

    // 4. Walk hash chain on MySQL events
    hashResult := hash.WalkChain(mysqlEvents, cfg.HMACKey)
    if !hashResult.OK {
        return &VerifierResult{
            Mode:    cfg.Mode,
            Verdict: HashBreak,
            FirstMismatch: &Mismatch{Source: "mysql", Seq: hashResult.BreakAtSeq, Field: "event_hash"},
        }, nil
    }

    // 5. Mode-specific verdict
    if cfg.Mode == "settled" {
        if redisDiff != nil {
            return &VerifierResult{Mode: cfg.Mode, Verdict: RedisDiverged, FirstMismatch: redisDiff}, nil
        }
        // settled mode also requires MySQL to match Stream
        if mysqlDiff := diff.CompareEvents(streamEvents, mysqlEvents); mysqlDiff != nil {
            return &VerifierResult{Mode: cfg.Mode, Verdict: MysqlDiverged, FirstMismatch: mysqlDiff}, nil
        }
        return &VerifierResult{Mode: cfg.Mode, Verdict: Consistent}, nil
    }
    // in-flight mode: MySQL allowed to lag; report lag, don't fail
    if redisDiff != nil {
        return &VerifierResult{Mode: cfg.Mode, Verdict: RedisDiverged, FirstMismatch: redisDiff}, nil
    }
    if mysqlLag := diff.ComputeLag(streamEvents, mysqlEvents); mysqlLag.Seqs > 0 {
        return &VerifierResult{Mode: cfg.Mode, Verdict: Lagging, /* lag fields */}, nil
    }
    return &VerifierResult{Mode: cfg.Mode, Verdict: Consistent}, nil
}
```

### `reducer.Apply` — pure function: events → expected state

```go
func Apply(events []StreamEvent) ExpectedState {
    state := ExpectedState{Status: "DRAFT", Leaderboard: []LeaderboardEntry{}}
    for _, e := range events {
        switch e.Type {
        case "AUCTION_FROZEN":
            applyFrozen(&state, e)
        case "AUCTION_STARTED":
            applyStarted(&state, e)
        case "BID_ACCEPTED":
            applyBid(&state, e)
        case "AUCTION_EXTENDED":
            applyExtended(&state, e)
        case "AUCTION_SOLD":
            applySold(&state, e)
        case "AUCTION_NO_BID":
            applyNoBid(&state, e)
        case "AUCTION_CANCELLED":
            applyCancelled(&state, e)
        }
        state.Seq = e.Seq
        state.EventCount++
    }
    return state
}
```

Pure function — no I/O — easy to test in isolation. **Mirror of the state machine in `apps/lumen/internal/statemachine/`. If reducer and statemachine ever diverge, Replay Verifier produces false mismatches.** Solution: extract the state machine into `packages/shared-go` and have both consume it. (Open question: extract now, or after first divergence bites?)

### `hash.WalkChain` — recompute event_hash chain

```go
type WalkResult struct {
    OK         bool
    BreakAtSeq int64
    Expected   string
    Actual     string
}

func WalkChain(events []MySQLEvent, key []byte) WalkResult {
    prev := []byte{}  // genesis hash = empty
    for _, e := range events {
        canonical := canonicalSerialize(e.Seq, e.Type, e.Payload)
        mac := hmac.New(sha256.New, key)
        mac.Write(prev)
        mac.Write(canonical)
        expected := hex.EncodeToString(mac.Sum(nil))
        if expected != e.EventHash {
            return WalkResult{OK: false, BreakAtSeq: e.Seq, Expected: expected, Actual: e.EventHash}
        }
        prev = mac.Sum(nil)  // raw bytes for next iteration
    }
    return WalkResult{OK: true}
}

func canonicalSerialize(seq int64, eventType string, payload json.RawMessage) []byte {
    // Critical: same algorithm as Persistence Worker.
    // Otherwise verifier computes a different hash and FALSELY reports break.
    // Canonical = sorted-keys JSON of the payload + seq + type.
    return canonicalJSON(map[string]interface{}{
        "seq":  seq,
        "type": eventType,
        "payload": payload,
    })
}
```

The `canonicalJSON` helper lives in `packages/shared-go/canonical/` and is imported by both Replay Verifier AND Persistence Worker — that's the only way to guarantee identical bytes feed into the HMAC.

### `diff.Compare` — find first mismatch

```go
func Compare(expected ExpectedState, actual RedisState) *Mismatch {
    fields := []string{"Status", "CurrentPriceCents", "TopUserID", "EndAtMs", "ExtendCount", "Seq"}
    for _, f := range fields {
        if !reflect.DeepEqual(getField(expected, f), getField(actual, f)) {
            return &Mismatch{
                Source:   "redis",
                Field:    f,
                Expected: getField(expected, f),
                Actual:   getField(actual, f),
            }
        }
    }
    // leaderboard compare: sorted slice equality
    if !leaderboardEqual(expected.Leaderboard, actual.Leaderboard) {
        return &Mismatch{Source: "redis", Field: "Leaderboard"}
    }
    return nil
}
```

### `report.Render` — human + JSON output

Two output modes:
- Default: pretty-printed human-readable summary for CLI runs and demo.
- `--json`: structured for CI consumption + dashboard ingestion.

```text
$ verify --auction A1 --mode settled

[verify] auction=A1 mode=settled
[verify] sources: stream=43 events, redis=43 events applied, mysql=43 events
[verify] hash chain: 43/43 OK
[verify] state compare: PASS
[verify] result: consistent (exit 0)
```

```text
$ verify --auction A1 --mode settled

[verify] auction=A1 mode=settled
[verify] sources: stream=43 events, redis=43 events applied, mysql=42 events (lag=1)
[verify] hash chain: 42/42 OK on MySQL
[verify] state compare: MISMATCH at seq=43, field=CurrentPriceCents
[verify]   expected (from stream): 1500000
[verify]   actual (from redis):    1450000
[verify] result: redis_diverged (exit 1)
```

## Exit codes

| Exit | Meaning | Triggers |
|---|---|---|
| 0 | Consistent | settled: all 3 match; in-flight: redis matches stream |
| 1 | Divergence | mismatch_at_seq found |
| 2 | Hash break | event_hash chain broken |
| 3 | Internal error | Redis/MySQL unreachable, malformed events, etc. |

CI's `make verify` gate fails on any non-zero. T8 load test post-run runs verifier; non-zero blocks the load report from being marked green.

## Test surface (Go)

| Test | Verifies |
|---|---|
| `TestReducer_HappyPath` | sequence of [FROZEN, STARTED, BID×5, SOLD] → expected state matches by-hand calc |
| `TestReducer_AntiSnipeExtends` | BID with extend → endAtMs increased, extendCount += 1 |
| `TestReducer_Cancel` | CANCELLED event → status terminal, bids before still in leaderboard |
| `TestHashChain_OK` | golden events from testdata/ → WalkChain returns OK |
| `TestHashChain_BreakDetected` | tamper one event_hash in testdata → WalkChain reports BreakAtSeq |
| `TestHashChain_AlgorithmMatchesPersistenceWorker` | feed same events through both Persistence Worker hash code and Verifier — bytes-identical hashes |
| `TestDiff_FirstMismatchOnly` | seq 5 and seq 10 both diverge → returns mismatch at seq=5 |
| `TestVerify_E2E_Settled_Consistent` | seed Redis + MySQL with consistent data → exit 0 |
| `TestVerify_E2E_Settled_RedisDiverged` | inject divergence → exit 1 with `redis_diverged` |
| `TestVerify_E2E_InFlight_Lagging` | MySQL writer paused → in-flight mode reports lag, exit 0 |
| `TestVerify_PostLoad` | run 500-bid auction via ws-bot, hammer, then verify → consistent |

Coverage target: **≥85%** (high because this IS the correctness oracle).

## Integration with CI and demo

- `make verify` → containerized run via Docker, hits the compose stack's Redis + MySQL on a known seeded auction. Required CI gate from T6 onward.
- `make verify-load AUCTION=<aid>` → runs against a specific auction; used by `scripts/load/run-p0.sh` post-run.
- Demo step 6 in `docs/demo-script.md`: live operator triggers `make verify AUCTION=$DEMO_AID` from terminal; output projected on second screen showing `consistent (exit 0)`.

## NEEDS HUMAN REVIEW

1. **HMAC key location**: per V9 §6, key MUST NOT be in same DB as events. Options: env var (current default), Docker secret, GitHub Actions secret in CI. Demo: `.env` (gitignored). Production-ish: GitHub Actions secret + Docker secret in deploy. Need to write in `proto/security-baseline.md`.
2. **`reducer` vs `statemachine` duplication**: I noted in `reducer.Apply` that both implement state machine logic. Extract to `packages/shared-go/statemachine/` and import in both, OR accept duplication + contract test that they agree. **My vote: extract** — divergence here = false mismatches, and the state machine is small (~200 LOC).
3. **MAXLEN trim conflict** (V9 §11 risk row): Stream MAXLEN trim may delete events the verifier needs. Mitigation: verifier run sets `redis-cli XADD ... MAXLEN ~ <new-cap>` to temporarily raise cap before reading, restore after. Alternative: pause MAXLEN trimming during verification windows. **My vote: temp raise cap, then restore — atomic and explicit.**
4. **Order of source snapshots**: I snapshot Stream first, Redis second, MySQL third. If a bid arrives between Stream-read and Redis-read in in-flight mode, Redis has it but Stream snapshot doesn't → false `redis_diverged`. Solution: in in-flight mode, re-read Stream after Redis and only fail if mismatch persists across both reads.
5. **Leaderboard equality semantics**: full leaderboard or top-N? V9 doesn't specify. Recommend top-50 (matches what UI shows) for in-flight mode, full for settled.
