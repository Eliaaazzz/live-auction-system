# Architecture scaling proposal — 10k+ concurrent, ultra-low-latency

> **Status**: DRAFT proposal for ratify. Not a frozen design.
> **Goal**: 10,000+ concurrent WS sessions, broadcast p99 < 10ms, ack p99 < 50ms server-side. Beyond V9 §4.2 stretch (1k/100); positioned as post-hackathon ambition + pre-D-day risk insurance.
> **Authoring**: Eliaaazzz after running real 5k k6 measurement (issue #94 / PR #95) + external research (sources at §10).
> **Decision needed by**: 2026-06-08 freeze (which tier to commit to for D-day).

---

## §0 TL;DR — what we'd actually change

**Don't** rewrite to microservices or change languages. Don't add Kafka. Don't shard auctions (we have ONE room at demo time).

**Do** four tiered upgrades, each independently shippable + reversible:

| Tier | Change | Cost | Yield | Hackathon ETA |
|---|---|---|---:|---|
| **T-A** (cheap) | OS + Go tuning + L4 TCP balancer | ~4 h | unblocks 30k+ FD ceiling | this week |
| **T-B** (additive) | Pre-marshal broadcast in subscribe loop | ~2 h | -40% CPU at 10k fanout | this week |
| **T-C** (smart) | Pre-aggregation reject filter (gateway-side current-price cache) | ~6 h | 90% bid rejects skip the Lua round-trip | next week |
| **T-D** (structural, OPTIONAL) | Multi-process deploy via existing `--mode=gateway` split + NGINX `stream` L4 | ~8 h | linear gateway scaling past 1 host CPU | post-T10 |

Pre-aggregation is the architectural innovation; the others are tuning. Combined, the four tiers should comfortably hit 10k concurrent + sustain ~500 bid/s aggregate with **0 contract change**, **0 Lua change**, **0 state-machine change**.

What we **explicitly reject**: NATS migration (Redis Pub/Sub holds at our scale), per-auction sharding (single room demo doesn't benefit), service mesh (Istio overhead > latency budget), Cloudflare Workers / Durable Objects (vendor lock + auth re-plumbing).

---

## §1 Baseline — what we measured (PR #95 5k k6 run)

Single Go process, single Redis (hot path), single MySQL (durable), AI sidecar separated. Box: local Docker Desktop (Windows 11; 8 cores; 16 GB RAM available to Docker; vmnet bridge).

| Metric | Value | What it tells us |
|---|---:|---|
| ws_sessions cruise | **9,994** | gateway accepted 5k VUs over the run window without backoff |
| ws_connect_fails | **0** | handshake queue + accept loop survived 5k connect-storm in 15 s ramp |
| ack p99 (server) | **1.52 ms** | Lua + Go push entirely fine; **not the bottleneck at 5k** |
| broadcast p99 | **7.21 ms** | fanout to 5000 receivers (per-event JSON marshal + write per receiver) |
| script (Lua) p99 | **1.45 ms** | hot path; ~690 bid/s ceiling for a SINGLE auction |
| seqGapCount | **0** | correctness invariant held under 5k load |
| Verifier post-load | **consistent** stream=3223 mysql=3223 | persistence + projection caught up |
| ws_msgs_received | **17,489 / s** aggregate | broadcast fanout rate |
| outbound bandwidth | **33 MB/s** sustained from gateway | NIC nowhere near saturated (10 GbE = 1.25 GB/s) |

**Honest non-data we don't have yet** (issue #94 §5 Phase 2 sweep is still open):
- Where does Lua p99 start to degrade (probably 800+ bid/s on single CPU)?
- At what connect count does `backpressureForceClose` start firing under steady ~500 bid/s broadcast load? (1k/100 test showed 100 trims at 500 bid/s × 1000 conn)
- What's the FD limit on a deploy box (default 1024 on Linux containers; needs `ulimit -n 65536`)?

These get measured in Phase 2/3 of issue #94, not blockers for this proposal.

---

## §2 Bottleneck analysis — what actually limits us at 10k+

At 10k concurrent connections, each receiving every BID_ACCEPTED broadcast:

1. **JSON re-marshal per recipient**: `Hub.subscribe.fanout` does `json.Marshal(env)` ONCE then `h.broadcast(aid, b)` which iterates connections and calls `c.trySend(b)`. **The marshal IS reused** (good!). But each `c.write(msg)` calls `WriteMessage(TextMessage, b)` which copies the byte slice into the WS frame buffer. At 10k recipients × ~500 byte event × 500 bid/s = ~2.5 GB/s memory bandwidth in copy + frame-encode steps. Reducing this is **T-B**.

2. **`runtime.netpoll` overhead with 10k goroutines**: each Conn has `writePump` running. 10k writepumps + 10k read loops = 20k goroutines. Go scheduler handles this (we know 100k is documented[¹] [²]), but per-goroutine stack = 8 KiB minimum × 20k = 160 MB resident. Acceptable.

3. **Redis Lua single-thread**: place_bid.lua p99 1.45ms = max ~690 bid/s for one room. If demo wants 100+ active bidders all racing in a single room, the gateway needs to **stop sending obviously-too-low bids to Lua**. This is **T-C** (pre-aggregation filter — see [§6]).

4. **Single FD limit + accept queue**: defaults are 1024 file descriptors + `net.core.somaxconn=128`. 10k connections hits both ceilings before Go does anything wrong. This is **T-A** (sysctl + ulimit).

5. **NIC + kernel buffer pressure**: 10k connections × 500 bid/s × ~600 B per envelope = 3 GB/s peak outbound from gateway. A single 10 GbE NIC can carry it; but `net.core.wmem_default` (default 200 KB) per socket × 10k = 2 GB kernel memory potentially in tx buffers under congestion. **T-A** tunes this.

6. **Pub/Sub single-channel fanout to multiple gateway processes** (when we split): not an issue at one gateway. At 4+ gateway processes subscribing to one Redis channel, Redis Pub/Sub itself becomes the broadcast point, not the auction Lua. Redis handles this fine (it's literally what Pub/Sub is built for).

**Verdict**: at 10k the bottleneck order is `(T-A: FD/buffer) → (T-B: marshal copy) → (T-C: too-low filter)`. None of them require an architecture rewrite.

---

## §3 Tier A — OS + Go tuning (≈ 4 h, no code change beyond Dockerfile + sysctl)

The cheapest tier; unlocks every other tier.

```dockerfile
# apps/lumen/Dockerfile additions
RUN echo "fs.file-max = 200000" >> /etc/sysctl.conf
ENV GOGC=200            # gc less frequently under sustained allocation
ENV GOMEMLIMIT=2GiB     # soft cap so go runtime doesn't fight with kernel
```

```yaml
# infra/docker-compose.yml lumen service additions
lumen:
  ulimits:
    nofile: { soft: 65536, hard: 65536 }
  sysctls:
    net.core.somaxconn: 4096           # default 128 — accept queue depth
    net.ipv4.tcp_max_syn_backlog: 8192 # SYN queue under connect storm
    net.core.wmem_default: 4194304     # 4 MiB default write buffer
    net.core.rmem_default: 4194304
    net.ipv4.ip_local_port_range: "10000 65535"  # ephemeral port range for outbound (Redis pool)
```

Application-layer changes (one file, ~5 lines):

- `apps/lumen/internal/server/ws.go` — bump `sendBufFrames` from 256 → 1024 (under 10k connected + 500 bid/s, frames arrive at ~500/s per conn so a 256-frame buffer overflows in 0.5 s if `writePump` stalls; 1024 gives 2 s headroom)
- `gorilla/websocket` `Upgrader` already does `WriteBufferSize: 4096`; bump to 32 KiB for batching small frames

**Yield**: removes the FD ceiling + the accept-queue ceiling. Doesn't change ack/broadcast latency materially but unblocks scaling past 5k.

**Risk**: zero. Pure deploy config. Reversible by removing the `ulimits`/`sysctls` block.

---

## §4 Tier B — Pre-marshal broadcast (≈ 2 h, single function change)

Current `Hub.subscribe.fanout` already marshals envelope once. The cost at 10k is not the marshal — it's that **every `Conn.trySend` enqueues the SAME `[]byte`** but every `writePump` then individually calls `gorilla.WriteMessage(TextMessage, b)` which:
1. Allocates a new frame header
2. Copies the payload into a frame buffer
3. Writes to the socket

For 10k recipients of the same byte slice, that's 10k frame-headers allocated + 10k copies of the same bytes — at the gateway, not the kernel.

**Fix**: pre-build the WS text frame ONCE per broadcast event, write the prepared frame via `gorilla.PreparedMessage`:

```go
// in Hub.subscribe.fanout, after json.Marshal:
prepared, err := websocket.NewPreparedMessage(websocket.TextMessage, b)
if err != nil { log.Printf(...); continue }
h.broadcastPrepared(aid, prepared)

// trySend / writePump take a *websocket.PreparedMessage instead of []byte
// for the broadcast lane (direct ack still uses raw []byte since it's one-off)
```

Per gorilla docs[³]: `PreparedMessage` allocates the frame headers once + lets all recipients share the prepared frame. At 10k recipients this is documented to be 30-40% CPU reduction on the gateway.

**Yield**: at 10k recipients × 500 bid/s, gateway CPU drops from ~80% to ~50% (estimated from gorilla's published benchmarks).

**Risk**: low. PreparedMessage is a stable gorilla API since v1.4. Test coverage needed: extend `apps/lumen/internal/server/ws_t5_test.go` to verify prepared-message path round-trips identically to current broadcast.

**Migration**: gradual — broadcast path uses prepared, direct ack stays on raw bytes (one-off, no benefit). The two-lane (CRITICAL/lossy) separation already exists for this kind of routing.

---

## §5 Tier C — Pre-aggregation reject filter (≈ 6 h, the architectural innovation)

**The core insight** (from research source [⁵]): "only the winning bid needs to be processed sequentially while losing bids do not." In a real auction, when 100 bidders race for `current + 1`, only ONE bid per round becomes the new `current`. The other 99 will hit ERR_TOO_LOW. If we let them all reach Lua, we burn 99× our Lua throughput on doomed bids.

**Our 5k k6 measured this**: 24,000 acks in 60 s → 376 accepted, 23,500+ rejected (mostly ERR_TOO_LOW). 98% of Lua calls were wasted on bids the gateway could have known would fail.

**The filter**: gateway maintains an **eventually-consistent local copy of `currentPriceCents` per auction**, updated from the BID_ACCEPTED broadcasts it already fans out. Before forwarding a BID_PLACE to Lua, compare the bid amount vs the gateway's `currentPriceCents`. If `amount < currentPriceCents + 1`, reject immediately at the gateway with `ERR_TOO_LOW`:

```go
// in dispatchWS BID_PLACE, BEFORE the s.st.PlaceBid call:
roomState := s.hub.roomStateSnap(c.aid) // O(1) read; gateway-local
if amount <= roomState.currentPriceCents {
    c.metrics.BidsRejectedFastPath.Inc()  // new counter so we can measure
    c.push(rejected(c.aid, model.CodeErrTooLow))
    return
}
// otherwise fall through to PlaceBid as today
```

**The eventually-consistent part**: the gateway's `currentPriceCents` lags Lua-actual by one broadcast RTT (~5 ms). That window is **safe by design**:
- If gateway has stale `current = 100`, real `current = 110` (a recent bid we haven't yet fanned out):
  - Bid amount 105: gateway accepts → forwards to Lua → Lua rejects ERR_TOO_LOW. Same as today, no regression.
  - Bid amount 95: gateway rejects ERR_TOO_LOW fast → Lua untouched. SAME REJECTION just faster.
- The filter only fast-rejects bids GATEWAY KNOWS are too low; bids in the racy window still go to Lua for authoritative adjudication.

**Correctness guarantee**: Lua remains the sole truth for accepts. The filter only PREEMPTIVELY rejects bids that would 100% be rejected by Lua anyway. **No bid that would have been accepted can be wrongly rejected** — the eventual-consistency window can only delay an accept (the bid reaches Lua eventually if amount > gateway's current price).

**Yield**: in our 5k measurement, 98% of bids would be filtered. Lua effective throughput goes from 600 bid/s → 30,000 bid/s (only the 2% that COULD win reach it).

**Cost**: ~30 lines in `Hub` (room state cache + update on BID_ACCEPTED broadcast), ~5 lines in `dispatchWS` (the check), ~3 lines in `metrics.go` (new counter `bidsRejectedFastPath`). Plus tests (~50 lines).

**Risk**: needs careful reasoning that the cache update IS monotonic (we only ever bump `currentPriceCents` upward, never lower it on stale broadcast order). The proof is `place_bid.lua` guarantees `currentPriceCents` is monotonic globally, so any BID_ACCEPTED broadcast carries a value >= our cache; updating with `max(cache, broadcast.amount)` is safe.

---

## §6 Tier D — Multi-process deploy (≈ 8 h, OPTIONAL, post-T10)

`apps/lumen/cmd/lumen/main.go` already supports `--mode=gateway` / `--mode=bid-engine` / `--mode=pg-writer` / `--mode=timer` (server.go switch statement at line 38). Today's `--mode=all` runs all of them in one process; **the code is already factored for split**.

**The split**:
- `gateway` (1..N processes, each handling 5-10k WS) — only the WS upgrade + Pub/Sub fanout
- `bid-engine` (singleton) — REST API + Lua dispatch; no WS
- `timer` (singleton) — close_auction.lua scheduler
- `pg-writer` (singleton) — MySQL projection

**The fronting load balancer**: NGINX `stream` module (L4 TCP) with consistent-hash by source IP for WS sticky session. NOT HAProxy (L7) — L7 unwraps WS frames, adds 1-2 ms per message, undoes our latency wins.

```nginx
# nginx.conf
stream {
  upstream lumen_gateways {
    hash $remote_addr consistent;
    server lumen-gw-1:8080 max_fails=2 fail_timeout=5s;
    server lumen-gw-2:8080;
    server lumen-gw-3:8080;
    server lumen-gw-4:8080;
  }
  server {
    listen 8080;
    proxy_pass lumen_gateways;
    proxy_timeout 1d;          # WS sessions long-lived
    proxy_connect_timeout 5s;
  }
}
```

**Why L4 not L7**: WebSocket over L4 just forwards bytes; gateway terminates the WS protocol. L7 (like nginx `proxy_pass` http_upgrade) adds framing overhead. L4 is what Discord / Pusher / production WS use.

**Why consistent hash by IP not random**: WS reconnect should land on the same gateway so the local broadcast cache (Tier C) doesn't have to re-warm. Cookie-based or source-IP-hash both work; source-IP is simpler.

**Why NOT a service mesh** (Istio / Linkerd): mesh sidecar adds 0.5-2 ms per hop. For our latency budgets that's significant. The mesh's value is mTLS + per-call observability; we don't need either for a 4-process intra-VPC deploy.

**Yield**: gateway scaling linear with process count (each gateway = ~10k WS). Bid engine stays singleton (Lua is the bottleneck for ONE auction — sharding is meaningful only across multiple auctions, not in scope).

**Risk**: deploy complexity 1 → N processes; needs orchestration (docker-compose with replicas, or Kubernetes). The hackathon demo doesn't need this. Keep `--mode=all` for single-box demo runs; split is for "post-T10 we sustained 10 k via N-process deploy" claim.

---

## §7 What we explicitly REJECT (and why)

| Option | Why not |
|---|---|
| **NATS JetStream replacing Redis Pub/Sub** | Redis Pub/Sub holds at our scale (Pub/Sub itself is sub-ms; not our bottleneck). Migration cost = high; benefit = backpressure semantics we don't currently exercise. Revisit if we add second region. |
| **Per-auction Redis sharding (Cluster mode)** | We use hash tag `{aid}` so the code already supports it. But single-room demo doesn't benefit. Useful when we run MANY auctions simultaneously — out of hackathon. |
| **Cloudflare Workers / Durable Objects edge gateway** | Vendor lock + needs auth re-plumbing + JWT verification at edge. Saves ~50 ms cross-region but our demo is co-located. |
| **Service mesh (Istio / Linkerd)** | Sidecar overhead > our broadcast latency budget. mTLS not needed intra-VPC. |
| **Move from Go to Rust / C++** | We measured Go handles 5k effortless. Source [²] documents 10 M concurrent Go WS on one server. Bottleneck is NOT the language. |
| **Switch from gorilla/websocket to gnet / nbhttp** | epoll-based libs help at 100k+ on one box. At 10k they're not faster than gorilla. Migration cost vs zero yield. |
| **Pre-compute leaderboard outside Lua** | Lua's `ZADD GT` is already O(log N); leaderboard isn't on the hot path of an accept. |
| **WebTransport (QUIC) replacing WebSocket** | Browser support still spotty as of 2026-05; demo audience won't have it. |

---

## §8 Sequencing + decision matrix

For the hackathon (D-day 2026-06-10, freeze 06-08):

- **Mandatory before freeze** (if we claim "10k connected"): Tier A + B (~6 h work, low risk, no contract change)
- **High ROI if time allows**: Tier C (~6 h work, +30 lines of net Go, the actual architectural insight)
- **Skip for hackathon**: Tier D (multi-process deploy is great post-D-day evidence; demo runs on one box)

**Decision needed (this PR's open questions)**:
- OD-1: Do we commit to "10 k connected" as the demo claim, or stick with "5 k cruise + Tier-D-ready" framing?
- OD-2: Does Tier C land before freeze? It's the most interesting story but it's also new code on the hot path.
- OD-3: Tier-A sysctls — applied at the container or the host? Container is portable; host needs deploy-box privileged config.

---

## §9 Test plan additions

Each tier needs its own measurement on the 5k+ stretch:

- **Tier A**: rerun PR #95 k6 with `LOAD_OBSERVERS=10000`. Expect: 0 connect_fails. Currently impossible due to FD ceiling.
- **Tier B**: benchmark `BenchmarkBroadcastFanout` (new) with N=10 / 100 / 1000 / 10000 receivers — compare raw `[]byte` vs `PreparedMessage`. Numbers go into `docs/perf-report.md` §4.
- **Tier C**: rerun PR #95 k6 with `N_BIDDERS=500`. Expect: Lua p99 stays < 5 ms even at 500 racing bidders (filter rejects 98% before Lua). New counter `bidsRejectedFastPath` in `/metrics`.
- **Tier D**: load test against `docker-compose --scale lumen-gw=4` deploy + NGINX `stream` front. Out of hackathon scope.

---

## §10 Sources

Real benchmarks + production patterns informing this proposal:

- [¹ Managing 10K+ Concurrent Connections in Go — goperf.dev](https://goperf.dev/02-networking/10k-connections/) — 30k connections stable, buffered writes give 10× throughput
- [² How We Handle 10M WebSocket Connections on a Single Server — Medium](https://medium.com/beyond-localhost/how-we-handle-10m-websocket-connections-on-a-single-server-8917c3952f59) — single-Go-process scaling envelope
- [³ gorilla/websocket PreparedMessage docs](https://pkg.go.dev/github.com/gorilla/websocket#PreparedMessage) — the API behind Tier B
- [⁴ High concurrency live Auction platform — Medium 2026-02](https://medium.com/@mayureshshitole/high-concurrency-live-auction-platform-system-architecture-1d5ea573a674) — current production patterns for live auctions
- [⁵ Real-time Auction Architecture on AWS — DEV Community](https://dev.to/services_hls_c165b1106947/real-time-auction-architecture-on-aws-redis-socketio-blueprint-with-costs-and-benchmarks-4nmi) — Redis + Socket.IO blueprint; documents "winning bid sequential, losing bids parallel" — origin of the §5 Tier C insight
- [⁶ How to Build a Real-Time Bidding System with Redis — OneUptime](https://oneuptime.com/blog/post/2026-01-21-redis-real-time-bidding/view) — Redis atomic primitives + Lua + Pub/Sub at sub-ms
- [⁷ smallnest/1m-go-tcp-server (GitHub)](https://github.com/smallnest/1m-go-tcp-server) — benchmarks for 1M TCP on Go (envelope for our LF estimate)

---

## §11 Conclusion

We don't need a microservice rewrite. We need (1) OS tuning + (2) gorilla PreparedMessage + (3) gateway-side fast-reject filter. That gets us to 10k+ concurrent with broadcast p99 still in single-digit ms, **without breaking a single V9 contract**.

The pre-aggregation filter (§5) is the architectural innovation: it changes the bidding system from "every bid round-trips through Lua" to "Lua only sees plausible bids". Sources [⁵] and [⁶] confirm this is how real production auction systems handle 100k+ bid/s.

Awaiting team ratify on §8 OD-1/2/3 before opening implementation PRs.

cc @fariZzzz @PDGGK — open questions in §8 are blocking; the rest of the tier sequencing is recommendation only.
