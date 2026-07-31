# Multi-gateway room routing demo runbook (multigw)

> Goal: prove "room-level WebSocket routing isolation" to the judges — gateways are stateless, room events ride the
> Redis backbone, and seq is identical across gateway instances. A bid adjudicated through gateway A is broadcast with
> **the same seq** to a client connected to gateway B; a retry with a duplicate clientBidId only replays the original
> ack and produces no second broadcast.
>
> How it works: in `apps/lumen/internal/server/server.go`, both `--mode=all|gateway` start
> `hub.subscribe` (`apps/lumen/internal/server/ws.go`), so every gateway instance subscribes to the same
> Redis Pub/Sub wake-up channel plus the Redis Stream as authoritative event source, then fans out to the local
> connections in that process's `hub.rooms[auctionId]`. Bid adjudication is always the same Redis Lua script
> (`apps/lumen/internal/lua/place_bid.lua`), regardless of which gateway the client came in through.

## 1. Local version (docker compose, 5 minutes)

Topology:

```
                         ┌─────────────────┐
  phone A / WS A ──────► │ lumen    (:8080)│ --mode=all      ┐
                         └─────────────────┘                 │  same Redis
                         ┌─────────────────┐                 ├─ backbone
  phone B / WS B ──────► │ lumen-gw2(:8081)│ --mode=gateway  ┘  (redis:6379)
                         └─────────────────┘
  browser (optional) ──► gateway-lb(:8088) nginx least_conn → the two above
```

### 1. Start

```bash
# repository root
docker compose -f infra/docker-compose.yml --profile multigw up -d --build
# wait for the lumen / lumen-gw2 healthchecks to go green (each wgets /healthz)
docker compose -f infra/docker-compose.yml --profile multigw ps
```

### 2. Automated smoke test (run this first in front of the judges)

```bash
cd apps/web && npm run smoke:multigw
```

What the script (`apps/web/scripts/smoke-multigw.mjs`) does:

1. Through GW1 (:8080) over REST: seller dev-login → create product → create auction draft → freeze → start;
2. Buyer A connects to GW1's `/ws` and buyer B connects to GW2's (:8081) `/ws`, both `ROOM_JOIN(lastSeq=0)` into the same room;
3. A places one bid through GW1 → asserts **both A and B receive BID_ACCEPTED within 3 seconds with identical seq and amountCents**;
4. A re-sends **the same clientBidId** → asserts an idempotent ack replaying the original seq, and that B receives **no** second broadcast (only one seq was ever minted).

On success it prints `✓ PASS — ... seq=N`; on failure it exits non-zero and lists the assertions.
The `GW1` / `GW2` environment variables can retarget it (defaults are `http://localhost:8080` / `http://localhost:8081`).

> ✅ **Verified end to end (2026-06-07, Docker 29.1.3)**: all 6 containers healthy,
> run once against the two gateways directly and once entirely through the LB (:8088), both `✓ PASS`. Actual output:
>
> ```
> [A@gw1] ← BID_ACCEPTED seq=1 amount=15000   ← direct ack + room broadcast (same seq)
> [B@gw2] ← BID_ACCEPTED seq=1 amount=15000   ← cross-gateway fanout, seq matches
> [dup] A re-sends SAME clientBidId
> [A@gw1] ← BID_ACCEPTED seq=1 amount=15000   ← idempotent replay of the original ack
> ✓ PASS — one bid via GW1 fanned out on both gateways at seq=1;
>          duplicate retry replayed the original ack and minted no new seq
> ```

### 3. Two-phone interactive version (the most intuitive one)

1. Find your machine's LAN IP (on Windows, `ipconfig` and read the IPv4 address); call it `<host>`;
2. Open `http://<host>:8080` in phone A's browser and `http://<host>:8081` in phone B's
   (the two ports are **two different gateway processes**, serving the same SPA baked into the same image);
3. Have both phones join **the same** auction room and bid against each other: when either one bids, the other
   immediately sees the price jump, the leaderboard update, and the countdown stay in sync — that is cross-gateway room fanout;
4. You can also point both phones at `http://<host>:8088` (the nginx LB with `least_conn`) so the long-lived connections
   are spread across the two gateways with identical behaviour — proof that the client never needs to care which gateway it lands on.

## 2. Tier-1 cloud version (private LB + two gateway workers)

> The existing environment and the preflight/monitoring tools are documented in `docs/runbooks/beijing-tier1-10k-demo.md`
> (delivered with PR #232 / branch `feat/beijing-tier1-10k-preflight`: wsload preflight +
> wsdash capacity panel + Tier-1 runbook). Tier-1 = workers inside the VPC behind a private LB,
> which avoids the public self-dial NAT hairpin from issue #231.

1. Run one gateway on each of two ECS workers: `lumen serve --mode=gateway`, with environment variables pointing at the
   same Redis/MySQL (`REDIS_ADDR`/`MYSQL_DSN`); `JWT_SECRET` must be identical
   (a token is valid on any gateway, which is exactly the premise of statelessness). A third host runs `--mode=timer` +
   `--mode=pg-writer` (or a single `--mode=all`) to handle hammering and persistence;
2. The private LB (a layer-7 LB must pass the WebSocket upgrade through; layer-4 TCP passthrough is the most reliable) forwards
   port 80 to `:8080` on both gateways; this repo's `infra/nginx/gateway-lb.conf` can be used directly
   as a self-hosted nginx LB config (`least_conn` + Upgrade headers + 300s read timeout);
3. Verify: `GW1=http://<worker1>:8080 GW2=http://<worker2>:8080 npm run smoke:multigw`
   — hitting both gateways directly, bypassing the LB, to assert cross-instance seq consistency; then point both variables
   at the LB (`GW1=http://<lb> GW2=http://<lb> npm run smoke:multigw`) and run it again: the two WS connections get spread
   across different gateways by `least_conn`, which verifies both upgrade-header passthrough and seq consistency again;
4. Load-test criteria follow §4.2: ack p95 < 80ms, broadcast p95 < 150ms, seqGap = 0, with
   `tools/loadtest/wsdash.py` watching `/metrics`.

## 3. Talking points (30-second version for judges)

> "These two ports are **two independent gateway processes** — one is `--mode=all`, the other is pure `--mode=gateway`.
> The gateway is completely stateless: room membership is just a `hub.rooms[auctionId]` registry in that process's memory,
> bid adjudication happens atomically in Redis Lua, and the event is written to the Redis Stream and then fanned out to **every**
> subscribing gateway. Look at these two phones: this one is on 8080, that one on 8081, I bid here — and the price jumps there
> in the same frame, with **the same seq** on both sides. In other words, adding a gateway means adding a machine, not changing a line of code;
> we have measured a single gateway holding 10,000 concurrent connections all green, with a ceiling around 15,000 connections,
> and beyond that it is horizontal gateway scale-out — the architecture is ready for it (see the Tier-2 load-test report under docs/reports/)."

Landing points (mapped to the judges' criteria):

| What the judge looks for | Demo action | What to watch |
|---|---|---|
| Room-level routing isolation | Two phones on different ports in the same room bidding against each other | Both sides jump in sync |
| Cross-gateway consistency | `npm run smoke:multigw` | The `same seq` PASS line |
| Bid idempotency | The dup stage of the same script | `replayed original ack, no new seq` |
| Horizontal scalability | Point at the compose file | Adding a service block is adding a gateway |

## 4. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Port `8081`/`8088` already in use, compose will not start | Another process holds the port | `netstat -ano \| findstr :8081` to find the PID and stop it; or change the host-side port mapping in compose (leave the container side alone) |
| `lumen-gw2` stays unhealthy | A dependency is not ready (it depends_on lumen being healthy) or the image was not built | `docker compose ... logs lumen-gw2`; make sure `--build` was passed; run `wget /healthz` inside the container to self-check |
| Smoke test reports `dev-login 403` | `ENABLE_DEV_LOGIN` is not in effect (non-dev environment) | Confirm `APP_ENV: dev` + `ENABLE_DEV_LOGIN: "true"` in compose (on both gateways) |
| B receives no broadcast while A is fine | The two gateways are not on the same Redis | Check that both have `REDIS_ADDR` = `redis:6379`; `docker compose ... exec redis redis-cli client list` should show two subscribers |
| WS handshake 400 / instant disconnect through the LB (:8088) | Upgrade headers are not passed through | You need `proxy_http_version 1.1` + `Upgrade $http_upgrade` + `Connection "upgrade"` (see `infra/nginx/gateway-lb.conf`); a cloud layer-7 LB needs WebSocket explicitly enabled |
| Disconnects after a few idle minutes through the LB | Proxy read timeout is too short | The server PING period is 54s (`pingPeriod`, `apps/lumen/internal/server/ws.go`), so the LB read timeout must be ≥ 60s; this config already sets 300s |
| A token 401s on the other gateway | The two `JWT_SECRET` values differ | Both gateways must share the same `JWT_SECRET` (locally both are `change-me-local-only`) |
| A phone cannot open the page | The firewall blocks inbound 8080/8081/8088 | Allow them through the Windows firewall, or confirm the phone and PC are on the same LAN segment |
