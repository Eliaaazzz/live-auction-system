# `tools/loadtest/` — k6 high-concurrency stress harness

> Drives **5,000+ concurrent WebSocket sessions** against the lumen stack.
> Beyond V9 §4.2 stretch lane (1k connected / 100 active). Used to validate
> "thousands-concurrent" demo claim with real numbers, not promises.

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
```

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
- **Phase 3** — bump to 10k VUs (handshake queue + FD ceiling test)
- **Phase 4** — nightly GitHub Actions schedule (free-tier 21 min/wk)
