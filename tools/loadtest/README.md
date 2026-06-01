# `tools/loadtest/` — high-concurrency WS stress harnesses

> Drives **真·万人 (10,000) concurrent WebSocket sessions** against the lumen
> stack. Beyond V9 §4.2 stretch lane (1k connected / 100 active). Used to
> validate the "万人并发" claim with real numbers, not promises.
>
> **Three external harnesses, by job:**
> - **`wsload/`** (Go) — the one that actually reaches **10k** on a single box
>   (one goroutine + 1 KB buffer per conn). **Start here for 万人.** ✅
> - **`k6-ws.js`** (k6) — 5k mixed observer/bidder, rich JS metrics; per-VU JS
>   VM caps it on RAM well before 10k.
> - **`locustfile.py`** (Locust) — behavioural mixed load; Python/gevent tops
>   out ~1.5–2k WS/process (see issue #118 report).
>
> All three report the server's `/metrics` as ground truth — the harness tells
> you what the *client* saw; `/metrics` tells you what `lumen` actually did.

The Go-internal `lumen load` harness (T8, `apps/lumen/internal/server/load.go`)
covers the §4.2 P0 gate (500/50) and stretch (1k/100). This k6 harness pushes
beyond — same stack, external client, browser-like WS handshake. Different
class of test:

| | `lumen load` (T8) | `tools/loadtest/k6-ws.js` |
|---|---|---|
| Goal | P0 gate (500/50 ≤ 80ms ack p95) | "thousands-concurrent" stretch (5k+) |
| Run inside | Same Go process | External process (k6 v1.4+) |
| CI gate | Required on every push (`make load-smoke`) | Operator-run + nightly schedule |
| Bid coordination | Shared `atomic.Int64` counter | Each bidder watches BID_ACCEPTED + bids `current+1` |
| Ack matching | direct ack on the originating socket | matches by `(amountCents, userId)` from broadcast |

---

## `wsload/` — Go 万人 (10k) harness ✅

`wsload/` is a purpose-built Go WS load generator. It exists because the other
two harnesses hit **client**-side ceilings far below 10k (Locust ~2k/process;
k6 ≈ tens of GB RAM at 10k VUs). `wsload` opens **one goroutine + a 1 KB buffer
per connection**, so a single box drives **10,000 live WS sessions in ~200 MB**.

```bash
cd tools/loadtest/wsload && go build -o wsload .
# stack up + a LIVE auction seeded (k6-setup.sh writes .k6-aid + .k6-tokens)
./wsload -host ws://localhost:8080 -aid "$(cat ../../../.k6-aid)" \
  -tokens ../.k6-tokens -conns 9900 -bidders 100 -ramp 45s -hold 60s
```

### ⚠️ Measure over the real network, NOT the Windows dev loopback

On **Windows Docker Desktop**, host `localhost:8080 → container` traverses a
userspace port-forward proxy that **RSTs new connections past ~1,972**
(`An existing connection was forcibly closed by the remote host`). That is a
**dev-proxy artifact, not a server limit** — the gateway is Tier-A tuned
(`nofile 65536`, `somaxconn 4096`; see `infra/docker-compose.yml`). To measure
the real ceiling, drive load from a container **on the stack's network** (and in
prod, from a separate box against `wss://`):

```bash
CGO_ENABLED=0 GOOS=linux go build -o wsload-linux .
docker run --rm --network infra_default --ulimit nofile=1048576:1048576 \
  -v "$PWD/..:/lt" alpine:3.20 /lt/wsload/wsload-linux \
  -host ws://lumen:8080 -aid <AID> -tokens /lt/.k6-tokens \
  -conns 9900 -bidders 100 -ramp 45s -hold 60s
```

### Distributed token shards for 100k rehearsals

For multi-worker runs, do not point every worker at the same `.k6-tokens` file:
that reuses bidder identities across workers and makes reject-code evidence hard
to interpret. Generate disjoint worker token shards first:

```bash
N_USERS=100000 ./tools/loadtest/k6-setup.sh
WORKERS=10 TOTAL_CONNS=99000 TOTAL_BIDDERS=1000 \
  tools/loadtest/wsload/split-tokens.sh
```

The helper writes a no-secret `/tmp/lumen-wsload-shards-*` artifact directory
with `tokens-worker-NN.txt`, `workers.tsv`, and `summary.env`. `workers.tsv`
contains one `./wsload ... -tokens <shard>` command hint per load worker. By
default it fails if the token file has fewer lines than `TOTAL_CONNS +
TOTAL_BIDDERS`; set `ALLOW_TOKEN_WRAP=1` only for socket-count stress where
identity reuse is acceptable.

### Result — 10,000 concurrent, server-side SLO crushed (2026-05-31)

9,900 observers + 100 bidders, driven over the Docker network; server truth from
`/metrics` (scraped in-container) at the 10k steady-state hold:

| metric | value | SLO gate | margin |
|---|---|---|---|
| **peak concurrent** | **10,000** (0 connect-fail, 0 force-close) | — | — |
| server **ack** p95 / p99 | **7.1 / 13.4 ms** | p95 < 80 ms | ~11× |
| server **broadcast** p95 / p99 | **19.3 / 24.4 ms** | p95 < 150 ms | ~8× |
| Lua `EVALSHA` p99 | ~12 ms | — | — |
| `seqGapCount` | **0** | == 0 | ✅ |
| `backpressureForceClose` | **0** | == 0 | ✅ |
| frames delivered | **56.1 M** over 105 s | — | — |
| lumen CPU / RAM @ 10k | ~10 cores / **~825 MiB** | — | — |

Apples-to-apples: the **same binary** caps at 1,972 over Windows loopback (proxy
RST) but reaches **10,000 cleanly** over the network — proving the **gateway**,
not the fan-out design (#118), was never the limit. The production 火山云
re-measure (Part A8 of #121) repeats this from a separate region.

---

## v100k target — enterprise capacity path, not a marketing claim yet

The current verified ceiling is **10,000 concurrent WS sessions in one room**.
Do **not** claim "100,000 concurrent" until the run below has passed and the
raw artifacts are linked from `docs/perf-report.md`.

At 100k, there are three different claims. Keep them separate:

| Claim | Meaning | Expected bottleneck | Evidence required |
|---|---|---|---|
| **100k idle watchers** | 100k connected observers, minimal bid traffic | gateway FDs, memory, heartbeat, load balancer | activeConns=100k, 0 connect-fail after ramp, stable 10 min |
| **100k single-room fanout** | every accepted bid broadcasts to 100k sockets | network egress + per-gateway fanout CPU | broadcast p95 < 150 ms, 0 backpressure, 0 seq gap |
| **100k aggregate users** | many rooms sum to 100k users | routing, Redis/MySQL aggregate, ops topology | per-room SLO plus aggregate host metrics |

The hardest product claim is **100k single-room fanout**. One 200-byte
`BID_ACCEPTED` at 500 accepted bid/s to 100k viewers is roughly **10 GB/s** of
raw outbound payload before TCP/TLS/WebSocket overhead. That is not a single
Mac/Docker proof; it needs cloud NIC sizing, multiple gateway replicas, and a
fanout-aware load balancer.

### Required topology for a real 100k proof

- **Server**: production-like Linux hosts, not Docker Desktop loopback.
- **Gateway tier**: at least 4 gateway replicas behind L4/L7 WebSocket-capable
  load balancing; `ulimit -n >= 1048576` per host.
- **Redis/MySQL**: managed instances or isolated Linux containers on the same
  VPC; Redis latency and CPU scraped during the run.
- **Load generators**: 5-10 separate Linux workers, each running `wsload` with
  10k-20k connections. Do not run the generators on the gateway hosts.
- **Metrics source of truth**: server `/metrics` plus host metrics
  (`ss -s`, `pidstat`, `sar -n DEV`, container CPU/RAM, Redis INFO).

### Distributed `wsload` shape

Each worker gets a shard id and a target connection count. Example 10 x 10k:

```bash
# on each load worker i=0..9, with the same .k6-aid and token file copied over
./wsload -host wss://<gateway-domain> \
  -aid "$(cat .k6-aid)" \
  -tokens .k6-tokens \
  -conns 9900 \
  -bidders 10 \
  -ramp 120s \
  -hold 600s
```

This totals **99k observers + 100 bidders**. Use longer ramp than the 10k local
run; a connection storm is a different test from steady-state capacity.

### Pass/fail bar for "100k ready"

- `activeConns >= 100000` for at least 10 minutes after ramp.
- `wsload` aggregate connect failures < 0.1%; closed-early = 0 after ramp.
- server `ackLatencyMs.p95 < 80 ms`.
- server `broadcastLatencyMs.p95 < 150 ms`.
- `seqGapCount == 0`.
- `backpressureForceClose == 0` during steady-state.
- Redis CPU < 70%, p99 command latency < 5 ms, no reconnect storms.
- Gateway CPU < 75%, memory steady (no monotonic leak), GC p99 < 10 ms.
- Evidence verifier on the post-load auction returns `consistent`.

If any line fails, the correct output is **"10k verified; 100k not yet
verified"** with the failing bottleneck named. That is the enterprise bar.

---

## Quick start

```bash
# 1. stack up
make up

# 2. install k6 (one-time)
#   - macOS: brew install k6
#   - Windows: winget install k6 (or download binary from k6.io)
#   - Linux: curl + tar (see k6 docs)

# 3. drive 5k concurrent (default: 4950 obs + 50 bidders, 60s window)
make k6
```

Output ends with the server-side `/metrics` delta — that's the ground truth.
`k6`'s client-side metrics tell you what the load generator observed; the
server's `/metrics` tells you what `lumen` actually saw.

---

## Tunables (`make k6` env)

| env | default | meaning |
|---|---:|---|
| `N_USERS` | 5000 | tokens to pre-stage in setup |
| `N_OBSERVERS` | 4950 | observer VUs |
| `N_BIDDERS` | 50 | bidder VUs (each bids ~5/s) |
| `DURATION` | 60s | hold window after ramp |
| `RAMP` | 15s | observer + bidder ramp time |
| `HOST_WS` | `ws://localhost:8080` | target gateway |
| `TARGET` | `http://localhost:8080` | target REST (setup only) |
| `LOAD_AUCTION_DUR_SEC` | 3600 | auction lifetime (long, no hammer in window) |
| `PARALLEL` | 50 | concurrent dev-login workers in setup |

## Examples

```bash
# Push to 10k connected (need to bump tokens too)
N_USERS=2000 N_OBSERVERS=9950 N_BIDDERS=50 make k6

# Bidder-heavy: 1k observers + 500 active bidders
N_OBSERVERS=1000 N_BIDDERS=500 make k6

# Short smoke (CI-cheap variant; not yet wired to GA)
N_USERS=100 N_OBSERVERS=80 N_BIDDERS=20 DURATION=10s RAMP=3s make k6

# #112 local WAN preview: same k6 auction, but WS goes through Toxiproxy
# on localhost:18080 with 50ms +/- 10ms injected each way.
WAN_LATENCY_MS=50 WAN_JITTER_MS=10 N_USERS=1000 N_OBSERVERS=900 N_BIDDERS=100 make k6-wan
```

---

## Local WAN preview (`make k6-wan`)

`make k6-wan` is the no-cloud rehearsal for #112 real-latency re-measurement:

1. starts the normal stack plus the profile-gated `toxiproxy` service,
2. pre-stages the normal k6 auction and token files against `http://localhost:8080`,
3. injects upstream and downstream latency on the `lumen-ws` proxy,
4. runs k6 with `HOST_WS=ws://localhost:18080`.

The setup REST traffic is intentionally not proxied. The measured buyer path is the WebSocket path,
which is where the client-side `ack_latency_ms` delta shows up.

| env | default | meaning |
|---|---:|---|
| `WAN_LATENCY_MS` | 50 | added one-way latency in each direction |
| `WAN_JITTER_MS` | 10 | jitter applied around `WAN_LATENCY_MS` |
| `TOXI_URL` | `http://localhost:8474` | Toxiproxy admin API |

Use `make toxiproxy-reset` before switching latency values after a failed/interrupted run.

---

## Pre-stage script behavior (`k6-setup.sh`)

- Creates one tuned auction: `incrementCents=1`, `capPriceCents=0`,
  `extendWindowSec=0`, so every strictly-increasing bid is acceptable.
- Pre-stages `N_USERS` dev-login tokens via PARALLEL parallel curl calls,
  each writing to its own temp file (`/.k6-tokens.tmp/<j>.tok`) — avoids
  the POSIX-`>>`-not-atomic-past-PIPE_BUF race that previously corrupted
  ~80% of tokens at 50 parallelism.
- Final tokens are filtered to canonical shape `user_<slug>.<hex64>` to
  drop pathological empty / malformed lines.
- Output:
  - `.k6-aid` — the auction id
  - `.k6-tokens` — one JWT per line (~80B each)

If fewer tokens land than `N_USERS` (network blips), k6 wraps via modulo
so 5000 VUs across 1000 tokens means each token is shared by 5 VUs. That's
fine for socket-concurrency stress — same user can have multiple WS
connections by design.

---

## What the run measures

### k6-side (client perspective)
- `ws_sessions` — number of opened sockets (≥ VUs; bidders may reconnect)
- `ws_connect_fails` — handshake failures (network jitter / OS port limit)
- `ws_msgs_received` — total broadcast frames the harness observed
- `ws_connecting` — handshake-latency trend
- `bid_accept_rate` — fraction of attempted bids that came back BID_ACCEPTED
  (one VU's view; with 50 racing bidders, steady-state ≈ 1/50 = 2%)
- `ack_latency_ms` — bidder-side wall-clock from `send` to its own
  BID_ACCEPTED, matched by `(amountCents, userId)`

### Server-side (`curl /metrics`)
Authoritative for "did the system actually handle it?":
- `ackLatencyMs` p50/p95/p99 — Lua dispatch + ack push, all bidders
- `broadcastLatencyMs` p50/p95/p99 — Lua TIME → gateway broadcast wire-write
- `placeBidScriptTimeMs` p50/p95/p99 — pure Lua EVALSHA timing
- `catchupLatencyMs` — observer ROOM_JOIN replay cost
- `bidsAccepted` / `bidsRejected` — aggregate counters (atomic.Int64)
- `seqGapCount` — **0 is the invariant; non-zero is a correctness break**
- `backpressureForceClose` — count of T5 critical-lane overflow trims

---

## Known limitations (filed as follow-ups in issue #94)

- **Setup script is sequential per batch**, so 5k logins take ~30s on
  localhost. Could be reduced to ~5s by switching to `xargs -P 200`, but
  adds dependency complexity for a one-time pre-stage cost.
- **Bidders race on a single `currentCents`** even after the §3.2 fix —
  only one bidder per round can win the `current+1` slot. Steady-state
  accept rate is ≈ 1/N_BIDDERS. To stress Lua hot path harder, increase
  N_BIDDERS or simulate per-auction sharding (out of scope for hackathon).
- **No native cumulative-delta** in `/metrics` — counters accumulate since
  lumen container start. The driver snapshots pre + post; for nightly CI
  we'd want a `/metrics?reset=true` query param or a `restart lumen` step.

---

## Why k6 (not Locust / Artillery / Gatling)

| tool | pro | con for our case |
|---|---|---|
| **k6 (Grafana)** ✅ | native `k6/ws` module; scales 10k+ VUs single-box; JS scripts; single binary; opensource | one new docker image (or local binary) |
| Artillery | Node, WS plugin, easy YAML | slower past ~5k VUs |
| Locust | Python, distributed | needs distributed harness setup for our scale; harder ramp |
| Gatling | JVM, very fast | Scala scripts, JVM startup overhead, heavier dev loop |

The choice for k6 is documented in [issue #94 §4.G3](../../issues/94).

---

## Future work (issue #94 §5 phases)

- **Phase 2** — sweep N_BIDDERS 50→500 to find Lua throughput ceiling
- ~~**Phase 3** — bump to 10k VUs (handshake queue + FD ceiling test)~~ ✅
  **done** via `wsload/` (10,000 concurrent over the Docker network, 2026-05-31;
  see the `wsload/` result table above)
- **Phase 3b** — distributed `wsload` v100k proof (5-10 load workers, 100k
  aggregate WS, 10-minute hold, artifacts linked in `docs/perf-report.md`)
- **Phase 4** — nightly GitHub Actions schedule (free-tier 21 min/wk)
