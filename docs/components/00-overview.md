# Component Breakdown Overview — Lumen Auction

> Companion to [#14](../issues/14) Structure RFC. While #14 lays out the **directory tree + per-folder ownership**, this overview + the per-component docs in this folder lay out **how each module is built** — types, key functions, error handling, test surface, Lua pseudocode, frontend component trees.
>
> Reads alongside: [#1](../issues/1) Plan V9 (scope + trunk roadmap T0-T10), [#15](../issues/15) Workflow v2 (collaboration), PR [#13](../pull/13) (canonical docs SoT), [#14 challenge comment](../issues/14#issuecomment-4523316287) (the 13 challenges and votes this breakdown assumes resolved).

## Principles this breakdown bakes in

1. **One Go binary, multiple subcommands** (per #14 challenge 5) — `./lumen serve --mode=api|gateway|bid-engine|timer|pg-writer`. Compose runs 5 containers using the same image; trunk leader iterates without cross-binary contracts.
2. **Go everywhere on backend** (per #14 challenge 6) — AI sidecar is also Go. Single toolchain, single Dockerfile base, single CI build matrix.
3. **Canonical 7-state machine** (per #14 challenge 1, matches PR #13 `docs/state-machine.md` + PR #19 `apps/lumen/internal/model/model.go`) — `DRAFT → SCHEDULED → LIVE → {SOLD | NO_BID | CANCELLED} → ORDER_CREATED`. No `BIDDING`, `HAMMERED`, `PASSED`, `RESERVE_NOT_MET`.
4. **Hash chain computed in Persistence Worker** (per #14 challenge 3) — Stream events do NOT carry `event_hash`. MySQL `auction_events.event_hash / prev_hash` is the integrity layer on the *projection*. "Integrity check", not "tamper-evident".
5. **Single error code for amount-invalid** (per #14 challenge 2) — `ERR_TOO_LOW` covers both increment-fail and cap-overshoot. Cap-hit is `OK_SOLD` (success in `place_bid.lua`), not an error.
6. **MP4 only for T1-T10** (per #14 challenge 7) — webcam dropped to P2 stretch; no `getUserMedia` in the demo path.
7. **No A/B/C silos** (per #15 Workflow v2) — leader implements, reviewer challenges, evidence-steward gates merge via CI.

## Top-level directory tree (v2)

```
live-auction-system/
├── README.md  Makefile  .env.example  .editorconfig  .gitignore
├── .github/workflows/   ← backend-ci, web-ci, e2e-dummy-bid, secret-scan, codegen-fresh
│
├── proto/                          T0a deliverable, canonical contracts
│   ├── ws-envelope.md              (← docs/ws-protocol.md after pointer-flip)
│   ├── openapi.yaml
│   ├── ai-events.md
│   ├── redis-keys.md
│   ├── db-schema.md
│   ├── error-codes.md
│   ├── evidence-card.md
│   └── security-baseline.md        (← new per #14 challenge 8)
│
├── docs/
│   ├── components/                 ← THIS FOLDER — function-level breakdowns
│   ├── architecture/               existing SVGs
│   ├── spec/                       existing PDF
│   ├── dev-log/                    per #15 — `_template.md` + dated entries
│   ├── dev-rules.md                per #15 — living rule set
│   ├── runbook.md                  on-call / demo-day ops
│   ├── demo-script.md              T10 script
│   ├── decisions.md                ADR log (canonical per V9)
│   ├── ai-usage.md                 prompt log for rubric 15%
│   └── state-machine.md            canonical (existed in PR #13; pointer to proto after T0a)
│
├── apps/
│   ├── lumen/                      ⭐ single Go binary, subcommand-dispatched
│   │   ├── cmd/lumen/main.go       parses --mode, dispatches
│   │   ├── internal/
│   │   │   ├── api/                REST handlers (mode=api)
│   │   │   ├── gateway/            WS termination (mode=gateway)
│   │   │   ├── bidengine/          Lua dispatcher (mode=bid-engine)
│   │   │   ├── timer/              expiry scanner (mode=timer)
│   │   │   ├── persistence/        Stream → MySQL projector (mode=pg-writer)
│   │   │   ├── order/              idempotent order creation
│   │   │   ├── statemachine/       pure functions, no I/O
│   │   │   ├── repo/               MySQL + Redis adapters
│   │   │   ├── envelope/           WS envelope codec + protocol enums
│   │   │   ├── catchup/            XRANGE + snapshot fallback
│   │   │   ├── seq/                seq guard
│   │   │   ├── chaos/              feature flags for fault drills
│   │   │   ├── metrics/            Prometheus collectors
│   │   │   ├── auth/               dev-login + Origin/Token middleware
│   │   │   └── config/             env loading + startup-fail validation
│   │   ├── lua/                    Lua scripts (loaded at startup, SHA1 cached)
│   │   │   ├── place_bid.lua
│   │   │   ├── close_auction.lua
│   │   │   ├── cancel_auction.lua
│   │   │   ├── start_auction.lua
│   │   │   └── freeze_rules.lua
│   │   ├── migrations/             MySQL DDL (golang-migrate)
│   │   ├── go.mod  Dockerfile
│   │
│   ├── ai-sidecar/                 separate process (different lifecycle, killable for chaos)
│   │   ├── cmd/sidecar/main.go     Go + chi router
│   │   ├── internal/
│   │   │   ├── doubao/             Volcengine Ark client
│   │   │   ├── facts/              VLM facts draft + disclaimer
│   │   │   ├── auctioneer/         4 trigger points + streaming
│   │   │   ├── guardrail/          prompt template guard + ban-word regex
│   │   │   ├── cost/               token metering
│   │   │   └── ssrf/               image-fetch whitelist + private-IP block
│   │   ├── prompts/                .tmpl files (text + version comment)
│   │   ├── go.mod  Dockerfile
│   │
│   └── web/
│       ├── admin/                  React + TS + Vite + AntD (desktop)
│       └── mobile/                 React + TS + Vite + AntD Mobile (H5)
│
├── packages/shared/                TS shared types + WS client
│   └── src/
│       ├── envelope.ts             generated from proto/ws-envelope.md
│       ├── api-types.ts            generated from proto/openapi.yaml
│       ├── error-codes.ts          generated from proto/error-codes.md
│       ├── ws-client.ts            reconnect, heartbeat, catchup
│       ├── seq-guard.ts            client-side dedupe + out-of-order drop
│       └── time-sync.ts            serverClockOffsetMs helper
│
├── tools/
│   ├── replay-verifier/            Stream → Redis → MySQL 3-way check, two modes
│   ├── ws-bot/                     Go load gen (k scenarios from RFC v2 §15.3)
│   ├── k6/                         JS k6 scripts
│   ├── chaos-runner/               Go orchestrator + assertion harness
│   ├── codegen/                    oapi-codegen + sqlc + envelope-gen + error-codes-gen wrappers
│   └── seed/                       idempotent dev seed
│
├── infra/
│   ├── docker-compose.yml          base: mysql, redis, lumen × N (5 modes), ai-sidecar, nginx, prom, grafana
│   ├── docker-compose.dev.yml      hot-reload overlay
│   ├── docker-compose.load.yml     adds ws-bot + k6 + cadvisor
│   ├── docker-compose.chaos.yml    adds toxiproxy + chaos-runner
│   ├── nginx/                      WS sticky routing
│   ├── redis/redis.conf            AOF everysec
│   ├── mysql/init/                 schema bootstrap
│   ├── toxiproxy/                  network fault config
│   ├── prometheus/                 prometheus.yml + alerts.yml
│   └── grafana/                    dashboards/ + datasources/
│
└── scripts/
    ├── dev/                        bootstrap.sh, db-reset.sh, demo-seed.sh, fetch-demo-video.sh
    ├── load/                       run-p0.sh (500/50), run-stretch.sh (1k/100)
    └── chaos/                      per-phase triggers (calls into tools/chaos-runner)
```

## Component → trunk-step gating

| Component doc | Gates which T | Why |
|---|---|---|
| [03-lua-scripts](03-lua-scripts.md) | T1, T2, T3 | T1 needs `place_bid.lua` stub; T2 needs full atomic logic; T3 needs `close_auction.lua` + `cancel_auction.lua` + anti-snipe |
| [02-bid-engine](02-bid-engine.md) | T1, T2 | T1 = wire any bid through; T2 = full atomic + dedupe + ack pipeline |
| [01-ws-gateway](01-ws-gateway.md) | T1, T5 | T1 = handle BID_PLACE; T5 = horizontal scale + catchup |
| [04-timer-worker](04-timer-worker.md) | T3 | hammer-by-time without depending on next bid |
| [05-persistence-worker](05-persistence-worker.md) | T4 | Stream → MySQL idempotent + hash chain compute |
| [07-order-service](07-order-service.md) | T4 | idempotent order on `SOLD` |
| [08-replay-verifier](08-replay-verifier.md) | T6 | P0 deliverable per V9 |
| [06-auction-api](06-auction-api.md) | T1 | seller publish + rule freeze REST |
| [09-ai-sidecar](09-ai-sidecar.md) | T1 (stub), T7 (full) | facts draft mock for T1; live LLM by T7 |
| [10-web-mobile](10-web-mobile.md) | T1, T2 | room shell + bid UI |
| [11-web-admin](11-web-admin.md) | T1 | publish flow |
| [12-shared-package](12-shared-package.md) | T0b, T1 | TS contracts shared FE-BE |
| [13-observability](13-observability.md) | T2 (smoke), T8 (full) | early perf smoke needs the dashboard |
| [14-chaos](14-chaos.md) | T9 | 5 fault drills |
| [15-security](15-security.md) | T1 (baseline live) | auth, Origin, SSRF, secrets |
| [16-dev-workflow](16-dev-workflow.md) | T0a | dev-log, dev-rules, CI gates, branch convention |

## Contracts surface (V9 §6 "all-member approve" boundary)

Every component below has a `Cross-references` section pointing at the specific `proto/*.md` that bounds its public API. Changes inside a component's `internal/` are leader-only; changes crossing into `proto/` are all-member approve.

| Contract | What's on it |
|---|---|
| `proto/ws-envelope.md` | message types (`SCREAMING_SNAKE`), 4 channels (bid/presence/chat/ai), envelope fields, money-as-string, `endAtMs`/`serverTimeMs` |
| `proto/openapi.yaml` | REST surface; auctions, rules DSL, products, orders, evidence card retrieval, dev-login |
| `proto/redis-keys.md` | hash tag `{<aid>}` discipline, key inventory, Stream ID = `<seq>-0`, dedupe Hash format |
| `proto/db-schema.md` | MySQL DDL including `auction_events.event_hash / prev_hash` |
| `proto/error-codes.md` | wire-level codes + Lua-internal codes + mapping |
| `proto/evidence-card.md` | canonical serialization + HMAC algorithm + chain head publication |
| `proto/ai-events.md` | VLM input/output, LLM triggers, ban-word policy, SSRF whitelist scope |
| `proto/security-baseline.md` | auth flags, Origin allowlist, upload rules, secret handling — new per #14 challenge 8 |

## Test ownership across all components

Per V9 §5: **leader writes implementation + first-cut tests; @fariZzzz independently runs the §4.1 correctness suite + load + chaos; CI-green is the merge gate.**

Each component doc's "Test surface" section names concrete test functions. The independent re-run by C is **black-box** — operating only against `proto/*.md` and exposed endpoints/metrics, never against internal implementation. This is what makes "diverse review" actually diverse: if C's tests pass against the leader's code, the contract holds; if not, contract was misunderstood by one of them.

## Reading order

1. This file (you're here)
2. [16-dev-workflow](16-dev-workflow.md) — how to actually contribute
3. [15-security](15-security.md) — baseline that gates everything from T1
4. [03-lua-scripts](03-lua-scripts.md) + [02-bid-engine](02-bid-engine.md) — the core
5. [01-ws-gateway](01-ws-gateway.md) + [04-timer-worker](04-timer-worker.md) + [05-persistence-worker](05-persistence-worker.md) — the rest of the engine
6. [08-replay-verifier](08-replay-verifier.md) — P0 correctness tool
7. Everything else as you touch it
