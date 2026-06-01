# Deploy & Real-Latency Re-measurement

> Issue #112. How we deploy Lumen and re-measure latency under **real network conditions** —
> because today's `docs/perf-report.md` numbers are same-box compose (loopback ≈ 0 RTT), which
> is optimistic. After a real deploy the latency a buyer feels is `server-side + WAN RTT + TLS + proxy`.
>
> ⚠️ **Gated decisions — NOT decided in this doc** (need team confirm per CLAUDE.md / V9):
> deploy **target** (cloud VM vs container platform vs preview env), **cost**, and **secret
> provisioning** (`JWT_SECRET`, MySQL creds, DOUBAO key — see `docs/secrets-workflow.md`; never
> commit or echo secrets). This doc fixes the **method**; the target + secrets are a separate ratify.

## 1. Why re-measure

- `docs/perf-report.md` §1 records `Network = same-box compose; no WAN`. Loopback RTT is ~0, so
  client-perceived latency ≈ server-side latency today. That hides the real-world delta.
- A real deploy introduces: cross-host **RTT**, **TLS/`wss`** handshake, a **reverse proxy** hop,
  and **cloud-disk fsync** under `AOF everysec` (frozen V8/V9 decision — kept).
- "latency 更真实" = we want (a) the **client end-to-end** number under real RTT, and (b) confidence
  the **server-side SLO** still holds.

## 2. Measurement boundary (decision)

Two distinct latencies — do **not** conflate them:

| Metric | What it measures | Source | Role |
|---|---|---|---|
| **Server-side processing p95** | time *inside* lumen (bid→ack, engine→broadcast); excludes the network | `/metrics` histograms scraped by `lumen load` (`apps/lumen/internal/server/load.go`) | **SLO gate** — V9 §4.2: `ack<80ms · broadcast<150ms · hammer<500ms`. Insulated from WAN → stays valid post-deploy. |
| **Client end-to-end p95** | send→receive at the browser / k6 VU = `server-side + RTT + TLS + proxy` | k6 `ack_latency_ms` (`tools/loadtest/k6-ws.js`) / browser timing | **Observed UX** — record under real RTT; **not** a hard gate |

**Decision:** the §4.2 gate **stays server-side** — which is already how `make load` works (it scrapes
`/metrics` at end; per `load.go`: *"snapshot at end is the source of truth for SLO"*). Post-deploy we
**add** the client e2e number as observed UX. Rationale: a single-region RTT alone can exceed 80 ms,
so keying the gate on e2e would false-fail the SLO on physics, not on a regression. We report e2e so
the demo shows the real felt latency; we gate on server-side so the SLO measures *our* system.

## 3. Deploy (skeleton — target is a gated decision)

- [ ] Build images: `apps/lumen/Dockerfile` (web build + Go backend), `apps/ai-sidecar/Dockerfile`.
- [ ] Bring up the stack: `redis` (**AOF everysec**) + `mysql` + `ai-sidecar` + `lumen` (room-level WS routing).
- [ ] Front with TLS / `wss://` via a reverse proxy; confirm `/healthz` and `/metrics` are reachable.
- [ ] Provision secrets via `docs/secrets-workflow.md` (never commit/echo). `ENABLE_DEV_LOGIN` stays
      **off** in any public deploy unless the load harness needs it on a private box (see §4 note).
- [ ] Keep the local `make up` path working as the **demo fallback** (#9 / #87) — the deploy must not
      become a demo single-point.

## 4. Re-measure against the deployed endpoint

The harness is already **endpoint-parameterized** — no code change needed:

```bash
# (A) Server-side SLO gate — preferred. lumen load dev-logins, drives 500+50,
#     scrapes the DEPLOYED /metrics, asserts §4.2 budgets. Fill perf-report §8.
#     Run co-located with (or with network access to) the deployed box so TARGET
#     can reach /metrics + dev-login.
TARGET=https://<deployed-host> \
  LOAD_OBSERVERS=500 LOAD_BIDDERS=50 LOAD_DURATION_SEC=60 \
  <run the `load` profile against the deployed TARGET>

# (B) Client e2e under real RTT — k6 from a DIFFERENT region/box than the server.
#     ack_latency_ms here = server-side + RTT (the felt latency).
k6 run -e HOST_WS=wss://<deployed-host> -e AID=$(cat .k6-aid) \
       -e TOKENS=.k6-tokens tools/loadtest/k6-ws.js
```

Capture **both** and compare to the same-box baseline in `perf-report.md` §2.

> Note on `TARGET` vs `HOST_WS`: the Go `load` harness (`TARGET`) needs `/metrics` + dev-login
> reachable (server-side gate); the k6 harness (`HOST_WS`) only needs the public `wss` endpoint and
> pre-staged tokens (`tools/loadtest/k6-setup.sh`) → e2e number. They answer different questions (§2).

## 5. Simulate WAN latency **without** cloud (toxiproxy)

To preview realistic numbers before/independent of a real deploy, use the existing toxiproxy infra
(`infra/toxiproxy/toxiproxy.json`, driven by `tools/chaos-runner`):

- `redis` (`:16379`) and `mysql` (`:13306`) remain available for T9 chaos drills.
- `lumen-ws` (`localhost:18080` -> `lumen:8080`) fronts the client↔gateway path used by k6.
  This injects realistic RTT on the path that actually feeds the client e2e ack curve.

Run a local WAN preview:

```bash
# Starts the normal stack plus the profile-gated toxiproxy container.
make up-toxiproxy

# Pre-stage the normal k6 auction/tokens, then run k6 through ws://localhost:18080
# with 50 ms +/- 10 ms on both upstream and downstream.
WAN_LATENCY_MS=50 WAN_JITTER_MS=10 make k6-wan
```

Operator notes:
- `make k6-setup` still uses direct REST on `http://localhost:8080` because setup is not the
  measured buyer path.
- `make k6-wan-run` points only WebSocket traffic at `ws://localhost:18080`.
- Use `make toxiproxy-reset` before changing latency values or after an interrupted run.

This previews the e2e curve and the `AOF everysec` p99 interaction with disk fsync before we commit a
cloud target — cheap, no secrets, reversible.

## 6. Watch under real conditions

- **AOF everysec on cloud disk** → watch `hammer` / `broadcast` **p99** (cloud disks stall more than
  loopback). `perf-report.md` §2 already has an *"AOF fsync stalls"* row — fill it from the real box.
- **Reconnect / catchup under real jitter** → re-verify `ROOM_JOIN + lastSeq` replay and the
  *catchup 200 events < 1s* target on the deployed box (jitter changes the reconnect storm shape).
- **Room isolation** holds across the proxy/TLS hop (房间级 WS 路由 — spec §3 / §技术架构).

## 7. Acceptance (closes #112)

- [ ] Deployed endpoint live: `wss` connects, room isolation holds, `/healthz` + `/metrics` reachable.
- [ ] `perf-report.md` §8 filled: **server-side SLO** (gate) **and** **client e2e** (observed) under
      real RTT, each row labeled with its measurement boundary (§2).
- [ ] Reconnect / catchup re-verified on the deployed box.
- [ ] Local `make up` fallback still green (demo safety).

## References

- spec §8 (可用性 / 性能 / 稳定性 / 可观测性 — 50% bucket), §技术架构 (房间级 WS 路由隔离)
- Issues: #8 (load plan), #87 (demo freeze), #92 (test surface audit), #94 (k6 5k stress)
- `docs/perf-report.md`, `docs/architecture-scaling-v10k.md`, `docs/secrets-workflow.md`
- `infra/toxiproxy/toxiproxy.json`, `tools/loadtest/k6-ws.js`, `apps/lumen/internal/server/load.go`
- Frozen budgets: `AOF everysec` · `ack p95<80ms` · `broadcast p95<150ms` · `hammer p95<500ms` · `catchup 200 events<1s`
