# Lumen Auction · System Design and Documentation Map

> This is the **entry point and technical overview** for the `docs/` directory. For the project-level introduction (rubric alignment, roadmap, quick start) see the repository root [`README.md`](../README.md); this document focuses on the **implementation-level system design** — bid adjudication, the realtime gateway, the consistency model, the evidence chain, error handling — and indexes every detail document under `docs/` and `proto/`.
>
> In one line: **make "realtime correctness" a provable, hard-won property, and make AI a sidecar you can switch off.**
> The backend state machine adjudicates everything (bids / winner / price / terminal state); AI only produces copy off to the side and never participates in adjudication.

---

## Table of contents

1. [Documentation map: how to read `docs/`](#1-documentation-map-how-to-read-docs)
2. [Overall architecture (Edge / Core / Data)](#2-overall-architecture-edge--core--data)
3. [Bid adjudication core: single-threaded Redis + one Lua script](#3-bid-adjudication-core-single-threaded-redis--one-lua-script)
4. [Realtime gateway: WebSocket at ten-thousand concurrency](#4-realtime-gateway-websocket-at-ten-thousand-concurrency)
5. [Consistency model: strongly consistent adjudication + eventually consistent display](#5-consistency-model-strongly-consistent-adjudication--eventually-consistent-display)
6. [State machine: 7 canonical states + 8 engineering invariants](#6-state-machine-7-canonical-states--8-engineering-invariants)
7. [Persistence and evidence: Stream-to-MySQL projection + three-way replay + an HMAC hash chain](#7-persistence-and-evidence-stream-to-mysql-projection--three-way-replay--an-hmac-hash-chain)
8. [Scheduled hammer (Timer Worker)](#8-scheduled-hammer-timer-worker)
9. [The AI sidecar (non-adjudicating)](#9-the-ai-sidecar-non-adjudicating)
10. [Error handling and failure recovery](#10-error-handling-and-failure-recovery)
11. [Performance (SLOs and measurements)](#11-performance-slos-and-measurements)
12. [Deployment topology](#12-deployment-topology)
13. [Quick start (make targets)](#13-quick-start-make-targets)
14. [Data contract cheat sheet](#14-data-contract-cheat-sheet)
15. [Full documentation index](#15-full-documentation-index)

---

## 1. Documentation map: how to read `docs/`

Pick a starting point by role:

| If you are… | Read first |
|---|---|
| Meeting the system for the first time | root [`README.md`](../README.md) → §2 architecture below → §3 the bid core |
| Changing the backend / bid logic | [`proto/redis-keys.md`](../proto/redis-keys.md), [`proto/error-codes.md`](../proto/error-codes.md), `apps/lumen/internal/lua/` |
| Changing the protocol / wiring the frontend | [`ws-protocol.md`](ws-protocol.md), [`proto/ws-envelope.md`](../proto/ws-envelope.md) |
| Interested in consistency / evidence | §5 and §7 below → [`proto/evidence-card.md`](../proto/evidence-card.md) |
| Interested in scale / performance | [`architecture-scaling-v10k.md`](architecture-scaling-v10k.md), [`perf-report.md`](perf-report.md), [`reports/`](reports/) |
| Deploying / demoing | [`cloud-deploy-volcengine.md`](cloud-deploy-volcengine.md), [`runbooks/`](runbooks/), [`demo-runbook.md`](demo-runbook.md) |
| Wondering "why was it designed this way" | [`decisions.md`](decisions.md) (frozen decisions), [`architecture.md`](architecture.md) |

**Source-of-truth priority**: the challenge PDF (`docs/spec/`) > GitHub Issue #1 Plan (delivery scope and numeric thresholds) > Issue #2 Architecture RFC > Issues #3–#9 sub-contracts > the public docs under `docs/`. README-style summaries are leads only — **the source code and the `proto/` contracts win**.

---

## 2. Overall architecture (Edge / Core / Data)

Three layers, with authority converging bottom-up onto Redis:

```
              Browser / phone (React + TS)
                    │ WebSocket (bids / room) + HTTP (fallback bid / REST)
                    ▼
┌──────────────────────────────────────────────────┐
│  Edge: the Go gateway (apps/lumen, --mode=gateway)│
│   · WS long connections, room fan-out,            │
│     three-lane backpressure, reconnect catchup    │
│   · fast-reject pre-filter (drops doomed lowballs) │
└───────────────┬──────────────────────────────────┘
                │ EVALSHA into Lua (the only write entry point)
                ▼
┌──────────────────────────────────────────────────┐
│  Core / Data: Redis (single-threaded + atomic Lua) │  ← the realtime authority
│   · state Hash (price / winner / seq / status)    │
│   · leaderboard ZSET                              │
│   · events Stream (authoritative log, ID=<seq>-0) │
│   · Timer Worker (the scheduled hammer)           │
└───────────────┬──────────────────────────────────┘
                │ the Persistence Worker projects asynchronously
                ▼
        MySQL 8 (facts / audit / replay)  ← eventually consistent, reads split from writes
                ▲
        The AI sidecar (a separate process on :8090, non-adjudicating, droppable at any time)
```

- **Process modes**: one binary, `lumen serve --mode=all|api|gateway|bid-engine|timer|pg-writer` (defaulting to `all` for the single-machine demo; the modes are already in the code so the deployment can be split horizontally).
- **The authority boundary**: Redis is the only adjudication authority; MySQL is the facts/audit store off the hot path; the video stream (`Rules.LivePlayUrl`) and AI are **both non-authoritative** and can die without touching adjudication.
- See [`architecture.md`](architecture.md) and [`architecture/v4/`](architecture/v4/) for detail.

---

## 3. Bid adjudication core: single-threaded Redis + one Lua script

> Source: `apps/lumen/internal/lua/place_bid.lua`, `apps/lumen/internal/store/`; contract: [`proto/redis-keys.md`](../proto/redis-keys.md).

### 3.1 Why serialize at a single point (atomic, lock-free, rollback-free)

Redis is single-threaded and runs **a whole script to completion without interleaving**. Pack "read the current price → validate → increment the sequence → write the price and winner → append the event → publish" into one `place_bid.lua` invoked through `EVALSHA`, and you get **an indivisible critical section that needs no distributed lock at all**. Without it you get the classic TOCTOU: two people both read 100, both pass validation, both win — two winners, or one price overwriting the other.

Lua has **no rollback**, so the script is **validate-then-write**: every check that can fail is moved ahead of every write, so the write section cannot fail. The script either runs to completion or returns cleanly at the first step; it **never leaves a half-write**.

### 3.2 The execution order of `place_bid.lua` (validate, then write)

1. **Type guards** on 4 keys (any wrong type → `ERR_INTERNAL(key_type)`);
2. **Dedupe / replay protection**: a hit on `HGET dedupe[clientBidId]` replays the original ack directly (`DUPLICATE` is not an error);
3. **State preconditions**: one `HMGET` pulls 12 fields, and `paused` / `status≠LIVE` / **the seller bidding on their own lot (shill protection)** each get their own rejection;
4. **The time boundary**: `now ≥ endAtMs` (Redis `TIME` is authoritative) → `ERR_AFTER_END` (the boundary is `≥` deliberately, so a tie loses to the hammer);
5. **Amount / increment / cap validation** → the single `ERR_TOO_LOW` namespace;
6. **seq / stream precheck**: compare the last `XREVRANGE` id with `state.seq`; on a mismatch → `ERR_INTERNAL(seq_stream_mismatch)`;
7. **Accept (the atomic write)**: `HINCRBY seq`, write the price and winner (**the amount as a decimal string**, avoiding float64 precision loss), update the leaderboard ZSET, and extend for anti-snipe if needed;
8. **Append the `BID_ACCEPTED` event + write dedupe + PUBLISH**;
9. If it extended or hit the cap, **consume one more `seq2`** to append `AUCTION_EXTENDED` / `AUCTION_SOLD` (every Stream entry has a unique `<seq>-0`, so the client's seq-guard sees a monotonic log with no holes).

**Anti-snipe**: a bid landing within `extendWindowSec` of `endAtMs`, below the `maxExtensions` ceiling, and not capping out → `endAtMs += extendSec` plus an independent `AUCTION_EXTENDED`. Past the ceiling the bid is still accepted but no longer extends (giving the auction an upper time bound).

### 3.3 Redis keys and data structures

| Key | Type | Purpose |
|---|---|---|
| `auction:{aid}:state` | Hash | The authoritative state: `status / currentPriceCents / winnerId / endAtMs / seq / bidCount / rules…` (amounts are decimal strings, ≤ 2⁵³−1) |
| `auction:{aid}:leaderboard` | ZSET | member=userId, score=the highest accepted bid |
| `auction:{aid}:events` | Stream | The authoritative event log, ID = `<seq>-0` |
| `auction:{aid}:dedupe:<uid>` | Hash | field=clientBidId → the original ack, TTL 24h (idempotency) |
| `auction:{aid}:pub` | Pub/Sub | A **non-authoritative** wake-up hint |
| `auction:active` | ZSET (global) | member=auctionId, score=endAtMs; the Timer index — Lua never touches it, Go maintains it |

`{aid}` is a cluster hash tag, so a multi-key Lua script always lands in one slot.

### 3.4 Error codes and fail-closed behaviour

Errors are **return values, not exceptions**: Lua returns a structured code (for example `{'ERR_TOO_LOW', bid, required}`) and Go translates it into the client-facing code. See [`proto/error-codes.md`](../proto/error-codes.md).

| Code | Trigger |
|---|---|
| `ERR_BAD_INPUT` | The gateway precheck: a malformed amount or id (never reaches Redis) |
| `ERR_AUCTION_PAUSED` | The auction is paused, **or** a Redis transport error (Redis is down) → fail-closed |
| `ERR_NOT_LIVE` | The status is not LIVE (not started yet, or terminal) |
| `ERR_NOT_ALLOWED` | The seller bidding on their own lot |
| `ERR_AFTER_END` | `now ≥ endAtMs` |
| `ERR_TOO_LOW` | The amount is ≤0 / below required / above the cap |
| `ERR_INTERNAL` | A wrong key type / a seq-stream mismatch / NOSCRIPT |
| `DUPLICATE` | A repeated bid → the original ack is replayed (**not an error**) |

### 3.5 Single-room throughput and fast-reject

Redis is single-threaded and scripts serialize, so a measured `place_bid.lua` p99 of **1.45ms** puts the single-room adjudication ceiling at roughly 1/1.45ms ≈ **690 bids/s** (a conservative derived ceiling; the real degradation point is estimated at 800+ — see [`architecture-scaling-v10k.md`](architecture-scaling-v10k.md)).

In a ten-thousand-person scramble roughly **98% of bids are doomed lowballs** (the scramble's timing gap: legal when sent, stale on arrival). **fast-reject** (the gateway-side pre-filter): the gateway maintains an **eventually consistent, monotonically increasing** room-price cache from the `BID_ACCEPTED` events it is already broadcasting. If a new bid cannot even reach the cached price, one cheap pipelined precheck (`HMGET status,paused,sellerId` + `HEXISTS dedupe`) confirms live / not paused / not the seller / not a duplicate, and the bid is rejected locally with `ERR_TOO_LOW` — **it never enters Lua at all**.

- **The effect**: effective throughput rises from ~600 to **~30,000 bids/s** (only the ~2% that could win reach Lua).
- **Zero correctness impact**: the cache is monotonic and ≤ the true price, so only certain losers are rejected; it can only reject and **never accepts** (accepting is always Lua's job); anything uncertain (the price might be enough, the end is near, it is paused, it is a duplicate) falls back to authoritative Lua. Counted as `bidsRejectedFastPath`.

---

## 4. Realtime gateway: WebSocket at ten-thousand concurrency

> Source: `apps/lumen/internal/server/ws.go`; protocol: [`ws-protocol.md`](ws-protocol.md), [`proto/ws-envelope.md`](../proto/ws-envelope.md).

### 4.1 Connections and broadcast

- **2 goroutines per connection** (a writePump for writes and the HTTP handler's read loop); about 72KiB per connection (two lanes × 512 frames) plus an 8KiB coalescing write buffer.
- Broadcast is **marshal-once**: the JSON is encoded once per event and the WS frame once per room via gorilla's `PreparedMessage` (saving 30–40% of gateway CPU at N>1000); fan-out is **lock-free** (an RLock snapshots the recipients into a pooled slice, then the lock is released before sending).
- **Coalesced broadcast in big rooms**: at ≥200 people per room, each `BID_ACCEPTED` folds into a 50ms-tick `ROOM_STATE_PATCH` (≤20 patches/s); syscalls coalesce too (an 8KiB `bufio` per connection, so a batch of frames costs one TCP write).

### 4.2 Three-lane backpressure

| Lane | Buffer | Contents | What happens when it fills |
|---|---|---|---|
| **crit** | 512 | Bid acks, `AUCTION_*` terminals, `ROOM_SNAPSHOT`, catchup | **Force-close the connection** (close 4000, then backoff reconnect + snapshot rebuild) |
| **broadcast** | 512 | Room fan-out | Force-close |
| **lossy** | 16 | PONG heartbeats | **Drop just that frame; the connection survives** |

writePump is always **critical-first**, so critical frames preempt broadcast frames: slow clients get isolated fast, critical frames are **never silently dropped, and the whole room is never dragged down**.

### 4.3 Reconnect catchup

The client reconnects with `ROOM_JOIN{lastSeq}`: if `snap.Seq − lastSeq ≤ 200` it replays incrementally from the authoritative Stream via `XRANGE` and then tops up with a snapshot; a gap above 200 falls back to a full snapshot. The hard invariant is **`sendBufFrames(512) > catchupMaxGap(200)`** (a full replay must not force-close the person who just reconnected). Measured: **200 events caught up in < 1s, zero loss, seqGap=0**.

### 4.4 Admission control (PR #235)

`MAX_WS_CONNS` (12000 in prod) plus a **CAS reservation** (so a reconnect storm cannot slip past the cap through check-then-add); over the limit it returns **503 + Retry-After**, turning "climb until OOM and crash" into "bounded rejection at the waterline". Only WS is shed selectively — REST, `/healthz`, and `/metrics` are unaffected. pprof (on loopback) plus gctrace provide the forensics.

### 4.5 Pub/Sub wake-ups, Stream authority

Pub/Sub is only a **wake-up hint**: on receipt the gateway goes and **reads the authoritative Stream** to broadcast, and never broadcasts the Pub/Sub payload itself — so a forged event that is not in the Stream **cannot be broadcast**. A 2s sweep ticker backs it up, so a dropped wake-up never leaves a room stuck forever.

---

## 5. Consistency model: strongly consistent adjudication + eventually consistent display

The split is deliberate. The principle in one line: **the single source of truth (Redis `state`) is strongly consistent; everything downstream of it is eventually consistent and allowed to lag, because none of it flows back into adjudication.**

- **Strongly consistent (must never be wrong) = serialized at a single point**: who is highest, who wins, the final price, `seq`, the terminal state — all adjudicated by Lua on Redis's single thread without interleaving. `HINCRBY seq` threads them onto one line, the price is globally monotonic, the winner is taken atomically from the ZSET, and the hammer emits exactly one `AUCTION_SOLD` with one winnerId → **there is always exactly 1 authoritative winner**. A bidder's own ack is strongly consistent and immediate (the crit lane carries Lua's return value directly).
- **Eventually consistent (a few seconds late is fine) = everything downstream**: (1) broadcast (Pub/Sub wake-ups, Stream authority, the 50ms coalescing in big rooms); (2) the **MySQL projection / audit** is asynchronous and legitimately behind during LIVE, which is why replay verification runs **after settlement**; (3) the viewer count and likes (a single-process in-memory approximation); (4) the fast-reject room-price cache (anything uncertain falls back to Lua).
- **CAP**: under a network partition (Redis unreachable) the bid path **chooses CP** — `ERR_AUCTION_PAUSED` pauses fail-closed and never accepts a possibly-wrong bid for the sake of availability; the display and stats layers lean AP (they may be stale). **On the money path, unavailable beats wrong.**

---

## 6. State machine: 7 canonical states + 8 engineering invariants

> Source: `apps/lumen/internal/model/model.go`; document: [`state-machine.md`](state-machine.md).

**The 7 canonical states**: `DRAFT → SCHEDULED → LIVE → {SOLD | NO_BID | CANCELLED} → ORDER_CREATED`. The 4 terminal states reject new bids (`ERR_NOT_LIVE`). There is **no** `BIDDING / HAMMERED / EXTENDED` state — an anti-snipe extension is **an event inside LIVE**, not a state (so there is never more than one state that can accept bids).

**The 8 engineering invariants (P1–P8)**: (1) money crosses boundaries as a decimal string, never a float; (2) the 7 states map 1:1 onto the UI; (3) **AI never participates in adjudication** (enforced by the AI-offline e2e CI gate); (4) the countdown uses the server clock; (5) the extension count is visible in the UI; (6) the evidence chain's HMAC-SHA-256 is complete (asserted by the verifier's exit code); (7) reconnects backfill frames by lastSeq; (8) WS handling never blocks broadcast (watched by perf-smoke).

---

## 7. Persistence and evidence: Stream-to-MySQL projection + three-way replay + an HMAC hash chain

> Source: `apps/lumen/internal/server/{persistence,verify}.go`, `apps/lumen/internal/store/storedb.go`; contracts: [`proto/evidence-card.md`](../proto/evidence-card.md), [`mysql-schema.md`](mysql-schema.md).

- **The idempotent projection worker**: the Stream is authoritative; an initial scan of every stream rebuilds the cursor, then a 2s periodic sweep plus an immediate Pub/Sub wake-up drives it. Writes use `INSERT IGNORE` with `UNIQUE(auction_id, seq)`, so a repeated projection is a no-op and neither two workers nor a restart can produce duplicate rows.
- **Three-way replay verification** (`make verify`): seq by seq it compares (1) the Redis Stream, (2) the MySQL `auction_events` projection, and (3) the `seq` in the Redis snapshot, emitting `consistent` / `mismatch_at_seq` / `hash_break_at_seq` with exit code 0/1. It runs **after settlement** (the projection is legitimately behind during LIVE).
- **The HMAC SHA-256 hash chain** (`make verify-evidence`): `event_hash = HMAC-SHA256(KEY, prev_hash ‖ seq ‖ type ‖ payload_json)`, filled in chain order inside `SELECT … FOR UPDATE`, detecting any tampering with the payload, the hash, or seq continuity. **The honest boundary**: the KEY lives in the same process as the events, so this is **an internal tamper-evidence self-check, not an external non-repudiation proof** (real non-repudiation needs a KMS and an independent signer). Starting prod with the default key fails outright.
- **Reads split from writes**: only the projection worker and the REST handlers write MySQL; a bid never writes MySQL directly (the `bids` unique constraint exists only for projection idempotency).

---

## 8. Scheduled hammer (Timer Worker)

> Source: `apps/lumen/internal/server/timer.go`, `apps/lumen/internal/lua/close_auction.lua`.

A 100ms tick runs `ZRANGEBYSCORE auction:active -inf now` (scored by endAtMs) to collect what is due, then runs `close_auction.lua`. **Exactly-once** comes from a **state guard** inside the script: only `status==LIVE` can hammer, otherwise `ERR_ALREADY_TERMINAL` — so a second worker, a restart's rescan, and an already-capped sale are all no-ops. A Redis `TIME` recheck adds `now<endAtMs → ERR_NOT_DUE` (a bid that just extended for anti-snipe simply retries; it never hammers early). The active ZSET is only a Go-maintained "when to hammer" cache; the truth is the status in the state Hash.

---

## 9. The AI sidecar (non-adjudicating)

> Source: `apps/ai-sidecar/`; contract: [`proto/ai-events.md`](../proto/ai-events.md).

- **A separate process** (on `:8090`) that the gateway calls **one-way and asynchronously** — every trigger is a `go fire(...)` that returns immediately, so **the bid path never awaits AI**; it has its own 5s timeout and a panic firewall, and any error broadcasts fallback copy rather than returning an error. AI copy carries `seq:0` and **never enters the Stream or the evidence chain**.
- **Capabilities**: VLM vision extracting facts (the seller must confirm each one before going live; `authenticity` is always `highRisk=true,confidence=0`, "the platform does not guarantee authenticity"), streaming auctioneer patter, and a copy/valuation advisor (a transparent heuristic that never invents a reserve price).
- **Two guardrail layers**: the sidecar validates at the source, and the backend re-validates AI output as **untrusted bytes** (banning URLs, phone numbers, invented amounts, authenticity claims and other prohibited wording).
- **The model**: Doubao **Doubao-Seed-1.6-flash** (one multimodal model) over the OpenAI-compatible API (Volcengine Ark, and equally able to point at Ollama/vLLM + Qwen on the open-source path); it defaults to **mock**, and filling in `LLM_API_KEY` / `VLM_API_KEY` flips it over.
- **A hard CI gate** (`make e2e-ai-offline` / `make chaos-ai`): killing the sidecar and rerunning the bid e2e must still pass; the UI shows "the auctioneer has stepped away" while bidding, the countdown, and the ranking are unaffected.

---

## 10. Error handling and failure recovery

The design philosophy: **fail closed (reject on failure, never wrongly accept) + idempotent retries + recovery from a single authority**.

| Failure | Handling | Correctness |
|---|---|---|
| A Lua script failing partway | Validate then write — all of it or a clean error | No half-written dirty data |
| A client dropping | `ROOM_JOIN(lastSeq)` incremental replay, a snapshot above a gap of 200 | Zero loss, no holes in seq |
| The network dying just as a bid is sent | `clientBidId` idempotency replays the original ack | No duplicate bid |
| Redis going down | `ERR_AUCTION_PAUSED`, fail-closed, no MySQL fallback | No split brain; worst case ~1s lost (AOF everysec) |
| The gateway process crashing | An automatic restart plus a rebuild from Redis (`reconcileActive` / the initial cursor scan / seq resumption) plus admission control | Nothing breaks; it self-recovers |
| A slow client | A full crit lane force-closes; the lossy lane drops frames | The room is not dragged down |
| The AI sidecar dying | Asynchronous fallback; the core never waits | Adjudication is unaffected |
| A background goroutine panicking | The `recoverGoroutine` firewall plus a `goSupervised` 500ms restart | The whole gateway does not go down |
| The projection worker dying | A stateless rebuild, idempotent through `INSERT IGNORE` | No duplicate rows |

For the chaos drills see [`t9-chaos.md`](t9-chaos.md) and `make chaos`.

---

## 11. Performance (SLOs and measurements)

**The frozen budget (the P0 gate, with zero tolerance — `seqGap=0`)**:

| Metric | Budget |
|---|---|
| Bid ack p95 | < 80 ms |
| Broadcast p95 | < 150 ms |
| Hammer p95 | < 500 ms |
| Reconnect catchup, 200 events | < 1 s |
| `place_bid.lua` script p99 | < 5 ms |
| P0 scale | 500 connected + 50 active, stable for 60s+ |
| Stretch (not a gate) | 1k connected + 100 active |

**Measured on the real public internet** (see [`reports/2026-06-07-tier2-public-loadtest-10k-20k.md`](reports/2026-06-07-tier2-public-loadtest-10k-20k.md)):

- **The 10k baseline**: ack p95 **0.46ms**, p99 ~5.3ms, patch p95 73ms, **seqGap=0**, a normal SOLD.
- **10k at high activity, 4:6 (~20k bids/s)**: fast-reject absorbs ~99.97% of the doomed bids, ack p95 is **3.5ms**, the SLOs and correctness hold, and ~1.3% exit early (recorded honestly).
- **The 20k storm (~50k bids/s)**: a single gateway climbed to ~15,777 connections and then crashed and auto-restarted on **GC/memory** (not bandwidth, not the worker); **correctness never broke** (seqGap=0 before the crash, still LIVE after the restart, seq continuous) — which is what drove the #235 admission control.

---

## 12. Deployment topology

> See [`cloud-deploy-volcengine.md`](cloud-deploy-volcengine.md), [`deploy-and-latency.md`](deploy-and-latency.md), and [`runbooks/`](runbooks/).

- A single `c4i.xlarge` (4 vCPU / 8 GiB) running the bare binary `lumen serve --mode=all`; Redis 7 (**AOF everysec**), MySQL 8, the AI sidecar on `:8090`, and Caddy (TLS + WS upgrade).
- Prod tuning (#235): `mem_limit=5g`, `GOMEMLIMIT=3750MiB`, `GOGC=200`, `MAX_WS_CONNS=12000`, `gctrace=1`, `PPROF_ADDR=127.0.0.1:6060`.
- **Tier-1** (a worker inside the VPC → a private LB → the gateway) sidesteps the public-internet NAT hairpin when dialling yourself; **Tier-2** (an off-site worker over the public internet → a public EIP) is the genuine public-internet evidence. The multi-gateway fan-out path is ready in code (`TestT5MultiGatewayFanout`).

---

## 13. Quick start (make targets)

```bash
make up            # bring up the full stack: redis + mysql + lumen + ai-sidecar
make seed          # an idempotent dev seed (a user + a product + one LIVE auction)
make e2e-dummy-bid # T1 acceptance: a full bid round trip; exit 0 means it passed
make perf-smoke    # T2 the performance floor: ack/broadcast p95 against the budget
make load          # T8 the P0 gate: 500 connected + 50 active, checking the §4.2 budget + replay consistency
make verify        # T6 replay verification: the three-way diff + the hash chain
make e2e-ai-offline# T7 chaos: kill AI and assert the bid path is still green (invariant P3)
make chaos         # T9 five-stage chaos (AI/Redis/MySQL/WS/Timer)
make demo          # T10 the full demo path (one assertable run)
make k6            # a 5k-concurrency full-path WS load test
```

For the full target list see the root `Makefile` (including `load-100k` and the `demo-sealed/vickrey/allpay` auction modes).

---

## 14. Data contract cheat sheet

- **Redis keys / Lua returns / invariants**: [`proto/redis-keys.md`](../proto/redis-keys.md)
- **Error codes**: [`proto/error-codes.md`](../proto/error-codes.md)
- **The WS envelope / schemaVersion=2**: [`proto/ws-envelope.md`](../proto/ws-envelope.md), [`ws-protocol.md`](ws-protocol.md)
- **The MySQL schema**: [`proto/db-schema.md`](../proto/db-schema.md), [`mysql-schema.md`](mysql-schema.md) (`users / products / auctions / auction_rules / bids / orders / coin_ledger / auction_events / evidence_chain_cache / ai_usage_logs`)
- **AI events / guardrails**: [`proto/ai-events.md`](../proto/ai-events.md)
- **The evidence card**: [`proto/evidence-card.md`](../proto/evidence-card.md)

---

## 15. Full documentation index

**Architecture and decisions**
- [`architecture.md`](architecture.md) — the Edge/Core/Data architecture
- [`architecture-scaling-v10k.md`](architecture-scaling-v10k.md) — the 10k+ scale bottleneck analysis (Lua at 690/s, fast-reject)
- [`architecture/v4/`](architecture/v4/) — the v4 architecture diagrams and their review
- [`decisions.md`](decisions.md) — the frozen engineering decisions
- [`state-machine.md`](state-machine.md) — the state machine
- [`charter.md`](charter.md) — the project charter
- [`roadmap.md`](roadmap.md) — the roadmap

**Protocol and data**
- [`ws-protocol.md`](ws-protocol.md) — the WebSocket protocol
- [`redis-keys.md`](redis-keys.md) / [`mysql-schema.md`](mysql-schema.md) — the data contracts

**Performance and load testing**
- [`perf-report.md`](perf-report.md) — the T8 performance report template
- [`reports/`](reports/) — the raw public-internet 10k/20k load-test reports
- [`deploy-and-latency.md`](deploy-and-latency.md) — deployment and latency

**Deployment and demo**
- [`cloud-deploy-volcengine.md`](cloud-deploy-volcengine.md), [`live-video-volcengine.md`](live-video-volcengine.md), [`srs-live-video-runbook.md`](srs-live-video-runbook.md)
- [`runbooks/`](runbooks/), [`demo-runbook.md`](demo-runbook.md), [`demo/`](demo/), [`demo-narration-script.md`](demo-narration-script.md)

**Testing and chaos**
- [`t9-chaos.md`](t9-chaos.md), [`test-cases/`](test-cases/), [`review.md`](review.md)

**Deep dives**
- [`runner-up-pays-mode.md`](runner-up-pays-mode.md) — ALL_PAY and the other auction modes (issue #114)
- [`recommender-convergence.md`](recommender-convergence.md) — recommender convergence
- [`secrets-workflow.md`](secrets-workflow.md) — the secrets workflow
- [`ai-usage/`](ai-usage/) — AI usage
- [`final-submission/`](final-submission/) — the submission report and deck
- [`dev-log/`](dev-log/) — the per-milestone development log (T3–T10)

---

> The docs evolve with the source. For any "why", [`decisions.md`](decisions.md) and the `proto/` contracts win; for any number, the measurements under [`reports/`](reports/) win.
