# Lumen Auction · Real-Time Live-Streaming Auction System

> Entry for the **ByteDance · Douyin E-Commerce AI Full-Stack Challenge** — track "Real-Time Auction Master".
> A real-time live-streaming **auction kernel** for known, single, high-value items: sellers publish goods, confirm AI-drafted facts, freeze rules, run a real-time bid loop, hammer, and close with an **auditable order + evidence chain**.

<p align="left">
  <code>Go (Gin/Fiber + Gorilla WS)</code> ·
  <code>React + TypeScript</code> ·
  <code>MySQL 8 + Redis</code> ·
  <code>Redis Lua atomic adjudication</code> ·
  <code>Replay Verifier</code>
</p>

**Status**: trunk-driven `T0…T10` | current step **T10** (Demo materials + freeze; T0–T9 complete) | internal freeze **2026-06-08** | public D-day **2026-06-10**.

---

## Table of Contents

- [1. What it is](#1-what-it-is)
- [2. Scoring alignment](#2-scoring-alignment)
- [3. Design invariants](#3-design-invariants)
- [4. Architecture](#4-architecture)
- [5. Repo layout](#5-repo-layout)
- [6. Quick start](#6-quick-start)
- [7. Contracts (the seam)](#7-contracts-the-seam)
- [8. State machine](#8-state-machine)
- [9. WebSocket protocol](#9-websocket-protocol)
- [10. Redis keys, Lua & MySQL](#10-redis-keys-lua--mysql)
- [11. AI sidecar (non-adjudicating)](#11-ai-sidecar-non-adjudicating)
- [12. Evidence chain & Replay Verifier](#12-evidence-chain--replay-verifier)
- [13. Acceptance metrics (SLO)](#13-acceptance-metrics-slo)
- [14. Trunk roadmap T0–T10](#14-trunk-roadmap-t0t10)
- [15. CI gates & testing](#15-ci-gates--testing)
- [16. Security baseline](#16-security-baseline)
- [17. Compliance scope](#17-compliance-scope)
- [18. Collaboration](#18-collaboration)
- [19. Docs index](#19-docs-index)

---

## 1. What it is

**Lumen Auction** is an end-to-end **live-streaming auction system** for high-value non-standardized goods. Three things it sells on:

1. **Real-time hard skills** — WebSocket bidding, Redis Lua atomic adjudication, monotonic `seq`, reconnect catchup, leaderboard, anti-snipe, timer hammer.
2. **Adjudicable & replayable** — a single Lua script does the write + Redis Stream (ID = `<seq>-0`) + idempotent MySQL projection + a **Replay Verifier that cross-checks all three sides** (Stream ↔ Redis snapshot ↔ MySQL projection).
3. **AI as a non-authoritative sidecar** — VLM facts draft (only enters the core after the seller confirms), LLM auctioneer copy (guardrail + banned-word post-filter). **AI never touches bid acceptance, winner, price, or terminal state.**

> In one line: make real-time correctness a provable hard skill, and keep AI a sidecar you can switch off.

---

## 2. Scoring alignment

The rubric in the challenge PDF is the planning lens (`docs/spec/`):

| Weight | Dimension | How we hit it |
|---:|---|---|
| **50%** | Implementation & engineering completeness | Full auction loop + CI gates + named regression suite (§15) |
| **25%** | Technical depth & innovation | Lua atomic hot path, single `seq` with no gaps, Replay Verifier, hash chain (§12) |
| **15%** | AI usage & landed effect | VLM/LLM sidecar + traceable `docs/ai-usage/` logs (§11) |
| **10%** | Project materials | README / load-test report / demo script / 5 chaos-drill recordings (§14 T8–T10) |

This is not a pretty-room UI demo, nor an infrastructure-only demo — it has to show a **complete loop + real-time correctness + traceable AI + clear materials**.

---

## 3. Design invariants

These are the engineering boundaries frozen in RFC v2 §0. The whole repo is implemented against them and they are **not to be casually reopened**:

| # | Invariant | Why |
|---|---|---|
| ① | **Hash tag `{<aid>}` keeps one slot** | Multi-key Lua for a room lands in the same Redis slot, so no `CROSSSLOT` under cluster mode. |
| ② | **Lua validate-before-write** | Lua has no rollback → type-guard and validate first, then write; business code **must not** mutate hot keys directly. |
| ③ | **Stream ID = `<seq>-0`** | The event-log ID is bound to the monotonic `seq`, so it is replayable and alignable. |
| ④ | **Redis TIME is authoritative, boundary is `>=`** | The only source for time adjudication is Redis TIME; expiry boundary is `now >= endAtMs`. |
| ⑤ | **Dedupe = Hash, retry returns the original ack** | A retry with the same `clientBidId` returns the original ack byte-for-byte (**not** `DUPLICATE`-as-error). |
| ⑥ | **A single `seq`** | Each auction has exactly one monotonic sequence, strictly gap-free (including under concurrency). |
| ⑦ | **AOF everysec, no financial-grade promise** | If Redis is down → explicit `ERR_AUCTION_PAUSED`; **never** silently accept bids via MySQL. |
| ⑧ | **WS `bufferedAmount` 1MB / 4MB** | Backpressure thresholds for slow clients; critical messages (bid ack) are never blocked by soft traffic. |
| ⑨ | **Video is non-authoritative** | Video/AI only drive presentation and supporting copy; they are **not** a source of truth for price, winner, or time. |

Conventions: money is a **string** at every JS-visible boundary (WS / REST / evidence / AI) to avoid JS number precision loss; the wire time field is **`endAtMs`** (DB column is `end_at`); Lua scripts are named `place_bid.lua` / `close_auction.lua` / `cancel_auction.lua` / `start_auction.lua` / `freeze_rules.lua`, and `*_v2.lua` is **forbidden** (guarded by a CI grep).

---

## 4. Architecture

Four layers — Client → Edge → Core → Data. **The WS Gateway scales horizontally and never touches auction truth; the Bid Engine is single-instance plus Redis Lua atomic adjudication.** See [`docs/architecture.md`](docs/architecture.md).

```text
┌──────────────────────────────────────────────────────────────┐
│ Client Layer                                                 │
│  Admin PC              Mobile H5           Load Bot          │
│  listing/rules/orders  room/bid/board      500/50 P0·1k/100 S│
└───────────────┬────────────────────┬─────────────────────────┘
                │ REST               │ WebSocket
┌───────────────▼────────────────────▼─────────────────────────┐
│ Edge Layer                                                   │
│  API Gateway · Auth & Rate Limit · REST BFF                  │
│  WebSocket Gateway: room isolation / heartbeat /             │
│                     lastSeq recovery / broadcast             │
│  (horizontally scalable, never mutates auction truth)        │
└───────────────┬────────────────────┬─────────────────────────┘
                │ REST cmd/query     │ bid command
┌───────────────▼────────────────────▼─────────────────────────┐
│ Core Layer (single responsibility each)                      │
│  Auction Service    Bid Engine           Timer Worker        │
│  start/cancel/      place_bid.lua        close_auction.lua   │
│  freeze rules       (sole bid entry,     (sole expiry        │
│                      atomic)              adjudicator)       │
│  Order Service      Persistence Worker   Metrics API         │
│  idempotent orders  Stream → MySQL,      load-test metrics   │
│                     idempotent                               │
└───────────────┬────────────────────┬─────────────────────────┘
                │ atomic write       │ stream consume
┌───────────────▼────────────────────▼─────────────────────────┐
│ Data Layer                                                   │
│  Redis (the only real-time hot authoritative path)           │
│   auction:{id}:state / :leaderboard / :events(Stream)        │
│   :dedupe:{userId} / auction:active                          │
│  MySQL (fact & audit store)                                  │
│   users / products / auctions / auction_rules                │
│   bids / orders / auction_events / ai_usage_logs             │
└──────────────────────────────────────────────────────────────┘
```

Data rules: Redis is the real-time hot path (AOF everysec); MySQL stores facts/audit/AI logs for replay; **Pub/Sub is only a wake-up and fanout channel — catchup and durability go through Redis Stream**; the AI sidecar is decoupled and degradable.

---

## 5. Repo layout

```text
live-auction-system/
├── apps/
│   ├── lumen/                  # Go main service (monolith, --mode can select gateway)
│   │   ├── cmd/lumen/          # entrypoint; subcommands include `seed`
│   │   └── internal/
│   │       ├── server/         # ws.go / api.go / timer.go / persistence.go
│   │       │                   # perf.go / verify.go / e2e.go / seed.go
│   │       ├── lua/            # place_bid / close_auction / cancel_auction
│   │       │                   # start_auction / freeze_rules (5 scripts)
│   │       ├── seqguard/       # client-side seq guard (drops out-of-order/duplicate frames)
│   │       ├── store/          # Redis + MySQL storage + Lua integration tests
│   │       ├── model/          # pure-function state machine / rules
│   │       ├── auth/           # dev-login / ownership / Origin validation
│   │       └── config/
│   └── ai-sidecar/             # non-adjudicating AI sidecar (VLM facts / LLM auctioneer)
├── proto/                      # ★ canonical contracts (the seam, everyone approves changes)
├── docs/                       # decision source of truth + architecture / state machine / protocol / load tests / dev-log
│   └── spec/                   # challenge PDF
├── web/                        # admin.html / room.html / index.html
├── infra/                      # docker-compose.yml + redis.conf + mysql init
├── Makefile                    # the demo path is a chain of make targets
└── .github/workflows/ci.yml    # CI gates
```

---

## 6. Quick start

**Prereqs**: Docker (with Compose v2) for the full stack; Go 1.22 for pure-Go local checks.

```bash
# 1) Copy the env template (secrets never enter git; local/deploy credentials go through private channels)
cp .env.example .env        # secrets stay local — see §16

# 2) Bring up the whole stack: redis + mysql + lumen + ai-sidecar
make up                     # docker compose up -d --build --wait

# 3) Load dev seed data (user + product + one LIVE auction, idempotent)
make seed

# open:
#   Admin console : http://localhost:8080/admin.html
#   Mobile H5     : http://localhost:8080/room.html?auction=auc_demo
```

**The demo path is a set of make targets** — every demo step has a machine-verifiable command, not just a screen recording. One command runs the full §12 chain end to end; all green is the T10 acceptance evidence:

```bash
make demo        # up→seed→e2e→demo-auction→verify-evidence→verify→load→chaos; aborts on the first failing step
make demo-smoke  # CI-cheap variant (small-N load-smoke + chaos-smoke), the orchestration regression net
```

See [`docs/demo-runbook.md`](docs/demo-runbook.md) for the 3-minute script, the step↔command mapping, and the fallback ladder.

| Command | What it does | Gate |
|---|---|---|
| `make up` / `make down` | Start / stop the stack (`down` clears volumes) | `/healthz` all green |
| `make seed` | Idempotent dev seed | — |
| `make e2e-dummy-bid` | T1 end to end: publish→facts→freeze→start→bid→ack→persist | **exit 0** means pass |
| `make demo-auction` | T10 §12.4-5: anti-snipe extension (`AUCTION_EXTENDED`) → hammer (`AUCTION_SOLD`) → evidence card (`eventsHash`) | exit 0 + `extendCount` assertion |
| `make perf-smoke` | T2 performance floor check (ack/broadcast p95 vs the floor budget) | floor check |
| `make load` / `load-smoke` | T8 load test: 500 connected + 50 active, plus a post-load verify | p95 over budget / seq gap≠0 → exit≠0 |
| `make verify-evidence` | T4 evidence chain: recompute the `event_hash` chain | `hash_break` → exit≠0 |
| `make verify` | T6 Replay Verifier: stream/redis/mysql three-way consistency | mismatch/hash_break → exit≠0 |
| `make chaos` / `chaos-smoke` | T9 five chaos drills (ai/redis/mysql/ws/timer): degrade + self-heal | 5× `CHAOS_OK` / non-zero exit |
| `make e2e-ai-offline` | T7-5: the core auction keeps running with AI offline (V9 P3) | exit 0 |
| `make build / vet / test / fmt` | Pure Go: build / vet / test / format | used by CI |
| `make guard` | Forbid `*_v2.lua` and real DOUBAO endpoint ids | CI grep |

> Tests need Redis + MySQL: CI provides them as service containers, and **every integration test is a real gate with zero skips in CI** (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

---

## 7. Contracts (the seam)

Low coupling comes from **contracts as seams**: all cross-component coupling converges into `proto/`. Changing a contract means changing the seam, which requires **approval from everyone** (@Eliaaazzz + @PDGGK + @fariZzzz); changes inside a component's `internal/` can be driven by its owner. `proto/` is canonical and the same-named files under `docs/` are pointers.

| Contract | Canonical file | Key bounds |
|---|---|---|
| WS envelope | [`proto/ws-envelope.md`](proto/ws-envelope.md) | `type` in SCREAMING_SNAKE · 4 channels · heartbeat/reconnect/catchup · `amountCents` as string · `endAtMs`/`serverTimeMs` |
| Redis keys + Lua | [`proto/redis-keys.md`](proto/redis-keys.md) | hash tag `{<aid>}` keeps one slot · state Hash (single `seq`) · Stream ID `<seq>-0` · dedupe Hash |
| Error codes | [`proto/error-codes.md`](proto/error-codes.md) | mapping table from internal Lua codes to wire codes |
| DB schema | [`proto/db-schema.md`](proto/db-schema.md) | fact/event tables + unique constraints + `event_hash`/`prev_hash` |
| AI events | [`proto/ai-events.md`](proto/ai-events.md) | VLM schema (incl. `high_risk_fields_disclaimer`) + LLM guardrail + SSRF allowlist |
| State machine | [`docs/state-machine.md`](docs/state-machine.md) | canonical terminal states + `>=` boundary + Lua validation order (see §8) |

> Planned (DRAFT, per Plan V9 §6): `proto/openapi.yaml` (REST + snapshot fallback shape) and `proto/evidence-card.md` (evidence card fields + hash algorithm + canonical serialization).

---

## 8. State machine

The canonical state contract is [`docs/state-machine.md`](docs/state-machine.md). `AUCTION_EXTENDED` is an **event, not a state**, and expiry adjudication is not a separate persisted state either.

```text
DRAFT ──(confirm AI facts + freeze rules)──▶ SCHEDULED
                                                │ start_auction.lua
                                                ▼
                                              LIVE ──┐ place_bid.lua (incl. anti-snipe branch)
   ┌──────────────────────────────────────────┤
   │ cap reached / now>=endAtMs with a top bid ─▶ SOLD ──(order)──▶ ORDER_CREATED
   │ now>=endAtMs with no bid ──────────────────▶ NO_BID
   └ abnormal cancel (from DRAFT/SCHEDULED/LIVE) ▶ CANCELLED   ← cancel_auction.lua
```

- Terminal states (`SOLD` / `NO_BID` / `CANCELLED` / `ORDER_CREATED`) reject new bids with wire code `ERR_NOT_LIVE` (the user-facing `after_hammer` copy maps onto this code).
- **Hammer-boundary race (deterministic adjudication)**: a `BID_PLACE` arriving at `now >= endAtMs` races `close_auction.lua` → `place_bid.lua` returns `ERR_AFTER_END` and `close_auction.lua` returns `OK_SOLD` (hammer wins, a late bid is always rejected).
- Anti-snipe: `endAtMs`, `extendCount`, the Stream write, and the `AUCTION_EXTENDED` broadcast all happen **inside the same `place_bid.lua` script** (there is no separate `extend.lua`).
- `reserve` (reserve price) is a **P1 OPEN DECISION** and does not enter the P0 state/schema/Lua before everyone ratifies it.

---

## 9. WebSocket protocol

The full contract is [`proto/ws-envelope.md`](proto/ws-envelope.md) (canonical) / [`docs/ws-protocol.md`](docs/ws-protocol.md). JSON is camelCase; money fields are strings.

**Envelope**

```ts
type WsEnvelope<T = unknown> = {
  type: string            // SCREAMING_SNAKE
  auctionId?: string
  seq?: number
  serverTimeMs: number    // the client calibrates serverClockOffsetMs from this
  data: T
}
```

| C→S | Purpose | S→C | Purpose |
|---|---|---|---|
| `ROOM_JOIN {auctionId,lastSeq?}` | Join a room; `lastSeq` triggers catchup — the missing Stream delta is replayed through **the same set of server→client types** (there is no separate `CATCHUP_EVENTS`), and `gap>200` falls back to snapshot only | `ROOM_SNAPSHOT` | Room state on join: current price / leader / `endAtMs` / `seq` / status |
| `BID_PLACE {clientBidId,amountCents}` | Place a bid | `BID_ACCEPTED` / `BID_REJECTED` | Ack (carries `seq`/`endAtMs`/status) / rejection (carries `code`) |
| `PING` | Heartbeat | `AUCTION_EXTENDED` | Anti-snipe extension (an event, not a state) |
| | | `AUCTION_SOLD` / `AUCTION_NO_BID` / `AUCTION_CANCELLED` | Terminal events |
| | | `PONG` | Heartbeat reply |

> Leaving a room is just a WS close (there is no explicit `ROOM_LEAVE` envelope); chat is out of scope for V9. **The outbid notice** is `BID_REJECTED.code=ERR_TOO_LOW` plus a frontend inline toast (roadmap: once proxy bidding lands it wires to `USER_OUTBID`, see [RFC #58](../../issues/58)).

**Error / result codes**: `OK_ACCEPTED` `OK_SOLD` `DUPLICATE` `ERR_NOT_LIVE` `ERR_TOO_LOW` `ERR_AFTER_END` `ERR_RATE_LIMITED` `ERR_AUCTION_PAUSED` `OK_CANCELLED` `OK_NO_BID` `ERR_NOT_DUE` `ERR_ALREADY_TERMINAL` `ERR_NOT_ALLOWED`. `DUPLICATE(previousResult)` is an idempotent replay, **not** a client-side rejection.

**Backpressure (two lanes, T5)** (invariant ⑧): each connection has a **critical** lane (bid acks, `AUCTION_*` events, `ROOM_SNAPSHOT`, catchup — never silently dropped while the socket is open; when it fills, the connection is force-closed so the client reconnects and replays) and a **best-effort** lane (`PONG`, plus future presence/chat — when it fills, that frame is dropped and the connection is kept). The critical lane drains by priority, so one slow client cannot drag down room broadcast; the 1MB/4MB `bufferedAmount` thresholds were tuned under the T8 load test.

**Countdown**: `remainingMs = endAtMs - (clientNowMs + serverClockOffsetMs)`, where `serverClockOffsetMs` is calibrated from the `serverTimeMs` carried by snapshots and events.

---

## 10. Redis keys, Lua & MySQL

See [`docs/redis-keys.md`](docs/redis-keys.md) and [`docs/mysql-schema.md`](docs/mysql-schema.md).

**Redis hot keys (same hash tag `{<aid>}`)**: `:state` (Hash, single `seq`) · `:leaderboard` (ZSET) · `:dedupe:{userId}` (Hash, TTL 24h) · `:events` (Stream, ID `<seq>-0`) · `:pub` (Pub/Sub) · `auction:active` (ZSET, score=`endAtMs`) · `room:{<aid>}:online`.

**P0 Lua scripts and return codes** (Lua has no rollback → validate before write):

```text
place_bid.lua(aid,userId,clientBidId,amountCents,requestId)
  → OK_ACCEPTED(seq,amount,endAtMs,extended) | OK_SOLD | DUPLICATE(prev)
  | ERR_NOT_LIVE | ERR_TOO_LOW | ERR_AFTER_END | ERR_RATE_LIMITED | ERR_AUCTION_PAUSED
close_auction.lua(aid)      → OK_SOLD | OK_NO_BID | ERR_NOT_DUE(msRemaining) | ERR_ALREADY_TERMINAL
cancel_auction.lua(aid,sellerId,reason) → OK_CANCELLED | ERR_ALREADY_TERMINAL | ERR_NOT_ALLOWED
```

Accepted amount = `min(amountCents, capPriceCents)`; on success the single `seq` is incremented → the Stream is written → then publish.

**MySQL unique constraints (proof of no duplicates / replayability)**: `bids UNIQUE(auction_id, seq)`, `bids UNIQUE(auction_id, user_id, client_bid_id)`, `orders UNIQUE(auction_id)`, `auction_events UNIQUE(auction_id, seq)`.

---

## 11. AI sidecar (non-adjudicating)

Two demo points, neither of them authoritative:

1. **VLM facts draft** — drafts a fact card from the product photos; high-risk fields carry `high_risk_fields_disclaimer` (labelled "seller statement / not verified by AI"), and the draft can only enter the core and start an auction **after the seller confirms or edits it**.
2. **LLM auctioneer** — pure-text streaming commentary with 4 triggers: auction start / price jump / 30s of silence / hammer; guardrail plus a banned-word regex post-filter. **If AI goes offline, a badge is shown and the core auction keeps running** (`make e2e-ai-offline` asserts bids still get acked).

Safety: VLM image fetches use an origin allowlist, block private networks/IMDS, cap size and timeout, and do not follow redirects; product text is always treated as **untrusted data** (defence against prompt injection forging authenticity claims). All AI usage is logged under [`docs/ai-usage/`](docs/ai-usage/README.md); public materials use redacted summaries and never record raw prompts or keys.

---

## 12. Evidence chain & Replay Verifier

**Evidence card**: the confirmed facts snapshot + frozen rules + the full successful-bid timeline + the `seq` range + the **`events_hash` chain**.

**Replay Verifier** (P0, T6): replays the Stream and compares **Stream ↔ Redis snapshot ↔ MySQL `auction_events` for three-way consistency**, emitting `consistent` / `mismatch_at_seq=X` / `hash_break_at_seq=Y`; `make verify` **exits non-zero** on any inconsistency (a CI/demo gate, not just a screenshot).

**Hash chain threat model (precise, not overclaimed)**: `event_hash = HMAC(key, prev_hash ‖ canonical(seq, event_type, payload))`; the HMAC key is not stored in the same database as business data, and the chain head is published on the evidence card. It **does defend against** after-the-fact single-point tampering of historical payloads (a broken chain surfaces as `hash_break_at_seq`); it is **not equivalent to** external notarization or blockchain anchoring. If the key were readable from the same database as the event-writing process, the wording would be downgraded to "integrity/consistency check".

---

## 13. Acceptance metrics (SLO)

**Correctness (zero tolerance, all of them named CI tests)**: `(auction_id, seq)` is unique and strictly monotonic under concurrency, so **seq gap = 0**; a retry with the same `clientBidId` returns the original ack; terminal states reject bids with `ERR_NOT_LIVE`; the hammer race has a pinned oracle; the Replay Verifier reports `consistent` (**run on an auction that has been through the load test**).

**Performance** (P0 gates vs stretch goals):

| Metric | P0 gate | Floor | Category |
|---|---|---|---|
| `BID_ACCEPTED` ack p95 | **< 80 ms** | < 200 ms | P0 gate |
| Broadcast p95 (Bid Engine → last viewer) | **< 150 ms** | < 500 ms | P0 gate |
| Hammer broadcast p95 | **< 500 ms** | < 2 s | P0 gate |
| Reconnect catchup, 200 events | **< 1 s** | < 3 s | P0 gate |
| One room at **500 connected + 50 active** | stable for 60s+ | — | P0 gate |
| 1k connected + 100 active | ack p99 < 100ms / broadcast p99 < 300ms | — | **Stretch (not a gate)** |

> Hot-path budget: `place_bid.lua` exec **p99 < 5 ms** (Redis is single-threaded, so if it goes over we split the script or move the leaderboard ZADD off the hot path) — this is the prerequisite gate for ack p95 < 80ms. The load-test report must include machine specs, gateway topology, rejection distribution, slow-client `bufferedAmount` curves, a `place_bid.lua` latency histogram, and Stream/Persistence lag.

---

## 14. Trunk roadmap T0–T10

The unit of progress is **one trunk that is demoable every day** (this replaced the older 4-sprint plan). Each T is a runnable step on the demo path, and the system stays end-to-end runnable throughout. Source of truth: [Issue #1 Plan V9](../../issues/1).

> Main axis / demo path: `seller create → AI facts → freeze rules → live bid → hammer → order/evidence → replay/load/materials`

| T | Step | What it demos | Status |
|---|---|---|:--:|
| **T0** | Freeze contracts + boot the skeleton | Contracts are consumable; `make up` all green; CI gates live | ✅ |
| **T1** | Dummy bid roundtrip | publish→facts→freeze→start→1 bid→ack+broadcast+persist | ✅ |
| **T2** | Atomic bid core | Correct adjudication under concurrent bids + leaderboard + perf smoke | ✅ |
| **T3** | Hammer + anti-snipe + cancel + durable stream | Auto hammer on time, last-second extension, abnormal cancel, seq gap=0 | ✅ |
| **T4** | Persistence + order + evidence v0 | Hammer produces an idempotent order + evidence-card timeline + hash chain | ✅ |
| **T5** | Multi-gateway + catchup | Horizontal gateways + seamless viewing across reconnects (two-lane backpressure) | ✅ |
| **T6** | **Replay Verifier + hash verification UI** | One-click three-way consistency check + a verify button on the evidence card | ✅ |
| **T7** | Full AI sidecar (non-adjudicating) | AI commentary bubbles + can be taken offline (VLM facts + SSRF allowlist + 4 triggers) | ✅ |
| **T8** | 500/50 load test + perf tuning | Stable load run + latencies within budget + dashboard (p50/p95/p99 + seq gap=0) | ✅ |
| **T9** | 5 chaos drills | MySQL/WS/Timer/AI/Redis failures degrade and self-heal (assertable via `make chaos`) | ✅ |
| **T10** | Demo materials + freeze | Public deploy + local fallback + standby recording + 3-min demo (`make demo` + [demo-runbook](docs/demo-runbook.md)) | ⏳ in progress |

**Stretch lane (parallel, cuttable, non-blocking)**: 1k/100 load test, risk-control amber/red lights, dynamic increment suggestions, email OTP, TTS, physically splitting the socket, reserve price (ratify first).

---

## 15. CI gates & testing

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs every integration test against **Redis + MySQL service containers** — **zero skips in CI**, and any `--- SKIP` is a failure. Four required check jobs:

1. **`go`** — `go mod tidy` clean → `gofmt` → `go vet` → `go build` → **`go test -race`** (real redis + mysql integration, zero skips).
2. **`guards`** — forbid `*_v2.lua`, forbid real DOUBAO endpoint ids, require the `proto/` contract files to exist.
3. **`e2e`** — bring up the stack + `/healthz` + seed, then chain through each atomic step of the demo path: `e2e-dummy-bid` (T1) → `perf-smoke` (T2) → `verifier` (T6 three-way consistency) → `verify-evidence` (T4 hash chain) → `e2e-ai-offline` (T7-5 / V9 P3) → `chaos-smoke` (T9 AI case) → `load-smoke` (T8 + post-load verify) → frontend smoke scripts (catchup/schema/401/antisnipe/snapshot).
4. **`web`** — the frontend Vitest suite (design-token drift check + `npm run build` + `npm test`).

> The full five chaos drills (`make chaos`) and the full 500/50 load test (`make load`) need Docker and take minutes, so they are operator-run / rehearsal steps rather than CI steps; `chaos-smoke` + `load-smoke` are the in-CI regression net.

**Coverage floors by area**: state machine (pure functions) ≥ 95%; every Lua return code must be covered by a harness; envelope codec / catchup / persistence idempotency / order idempotency each have a named test; global ≥ 80%.

**§4.1 → the named regression suite** (run on every merge from T3 onwards): concurrent seq gap=0 · same `clientBidId` returns a byte-identical ack · terminal states reject bids with `ERR_NOT_LIVE` · closing an already-terminal auction → `ERR_ALREADY_TERMINAL`, closing one that is not due → `ERR_NOT_DUE` · anti-snipe raises `endAtMs` + emits a Stream event · the hammer race is pinned · cancel → `OK_CANCELLED` + `AUCTION_CANCELLED`.

---

## 16. Security baseline (in force from T1)

| Surface | Constraint |
|---|---|
| **Auth** | `ENABLE_DEV_LOGIN` defaults to false and is hard-off outside dev (the dev compose opts in explicitly with `"true"`, see `infra/docker-compose.yml`); seller actions are server-side checked so the caller **owns that auction**, and a client-supplied `sellerId` is **never** trusted; startup fails if `JWT_SECRET=change-me-local-only` outside local. |
| **WS** | The handshake validates the token and binds it to the connection; an **Origin allowlist** (`FRONTEND_ORIGIN`) blocks CSWSH; max frame size is capped; each connection has a bid rate limit (`ERR_RATE_LIMITED`). |
| **AI / SSRF** | VLM image fetches use an origin allowlist, block private networks/IMDS, cap size and timeout, and do not follow redirects; product text is treated as untrusted data to defend against prompt injection. |
| **Secrets** | Secrets **never** enter git / issues / PRs / commits / logs / screenshots; the repo only carries `.env.example`, while local and deploy credentials go through private channels / GitHub Secrets; the secret scan runs over every commit plus a full-history baseline. |
| **Upload** | Images are MIME-checked by magic bytes, size-capped, given a server-side random filename, and served with `X-Content-Type-Options: nosniff`; `image_url` goes through the SSRF allowlist. |

---

## 17. Compliance scope

A transparent, single, known-item auction. Explicitly out of scope: mystery boxes, lotteries / random card breaks, platform-backed authenticity guarantees or endorsements, real payment/logistics/after-sales commitments, and digital avatars. AI output is explicitly labelled, a human gives the final endorsement, and the LLM is schema-constrained.

---

## 18. Collaboration

Trunk-driven + dev-log + whole-system review (everyone builds and reviews from a system-wide view rather than behind departmental walls). The carriers are issues, PRs, and `docs/dev-log/`.

Invariants: humans read the dev-log to judge direction and risk, and AI reads both the log and the code; **contracts, security, secrets, and scoring-critical paths still need a human to read the diff**; a reviewer has **blocking authority**; contract changes need approval from everyone (§7). The decision source of truth is [`docs/decisions.md`](docs/decisions.md) (if it conflicts with this README, decisions.md wins).

---

## 19. Docs index

| Doc | Contents |
|---|---|
| [`docs/decisions.md`](docs/decisions.md) | **Decision source of truth (SoT)** — the record of calls made + single-source consolidation |
| [`docs/charter.md`](docs/charter.md) | Project charter + scope tiers (P0/P1/P2) |
| [`docs/architecture.md`](docs/architecture.md) | Four-layer architecture + Edge/Core/Data rules |
| [`docs/state-machine.md`](docs/state-machine.md) | The canonical state-machine contract |
| [`docs/ws-protocol.md`](docs/ws-protocol.md) · [`docs/redis-keys.md`](docs/redis-keys.md) · [`docs/mysql-schema.md`](docs/mysql-schema.md) | WS / Redis+Lua / MySQL contracts |
| [`proto/`](proto/README.md) | Canonical contracts (the seam, changes need everyone's approval) |
| [`docs/roadmap.md`](docs/roadmap.md) | Sprint baseline (superseded by T0–T10, kept as a baseline) |
| [`docs/demo-runbook.md`](docs/demo-runbook.md) | **T10 demo handbook** — 3-min script + step↔`make` mapping + fallback ladder + standby checklist |
| [`docs/t9-chaos.md`](docs/t9-chaos.md) | T9 five-chaos-drill runbook (ai/redis/mysql/ws/timer) |
| [`infra/`](infra/README.md) | Observability stack: Prometheus + Grafana dashboards + alerts; docker-compose topology |
| [`docs/ai-usage/`](docs/ai-usage/README.md) | AI usage log (traceable evidence) |
| [`docs/dev-log/`](docs/dev-log/) | Per-step development narrative |
| [`docs/diagrams/`](docs/diagrams/) | Mermaid: system / state machine / bidding / reconnect / hammer / ER / RBAC |
| [Issue #1](../../issues/1) · [Issue #2](../../issues/2) | Plan V9 (T0–T10) · Architecture RFC v2 |

---

<sub>Lumen Auction · Real-Time Live-Streaming Auction System — ByteDance Douyin E-Commerce AI Full Stack Challenge · internal freeze 2026-06-08 / public D-day 2026-06-10.</sub>
