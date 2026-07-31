# Technical differentiation one-pager — judging criteria → code evidence

> Every claim carries a file path or a measured threshold; the reproducible demo entry points are in the action list at the end.
> Companion demo: `docs/demo/multi-gateway-demo.md` (the multigw compose profile).

## 1. Room-level WebSocket routing isolation (the main thread of this demo)

| Claim | Evidence |
|---|---|
| Each room has its own registry and is reclaimed when the last client leaves | `hub.rooms map[auctionId]map[*Conn]` plus a `len==0` room delete on leave (`apps/lumen/internal/server/ws.go:139,187-196`) |
| Gateways are stateless; adding one needs no code change | Both `--mode=all\|gateway` start `hub.subscribe` (`apps/lumen/internal/server/server.go:63-66`); the design comment says "adding gateways needs no re-plumbing" (`ws.go:126-128`) |
| Room events ride the Redis backbone, with the Stream as source of truth (Pub/Sub only wakes) | `subscribe` fans out from the canonical Redis Stream, with a 2s sweep as a safety net for lost Pub/Sub messages (`ws.go:412-424,58-60`) |
| Cross-gateway seq consistency (this demo) | compose `multigw` profile: `lumen` (:8080, all) + `lumen-gw2` (:8081, gateway) + nginx LB (:8088); `apps/web/scripts/smoke-multigw.mjs` asserts a bid placed through GW1 reaches a GW2 client with the **same seq and same amount** within 3s |
| Write coalescing: a fanout burst becomes one syscall | 8 KiB flush-on-demand write buffer (`ws_coalesce.go:12-23`) |
| Fanout collapse for 10k-scale rooms | `ROOM_STATE_PATCH(bidCountDelta)` coalesces bid broadcasts on a 50ms tick once a room has ≥1000 viewers (`ws_state_patch.go:14-15,118-124`) |
| Bounded backpressure: a slow client cannot drag the room down | Protocol budget bufferedAmount 1MB/4MB (frozen, `docs/ws-protocol.md:58-65`); the Go implementation uses a 1024-frame critical lane plus a code 4000 force-close → reconnect-and-catch-up (`ws.go:46,104`) |
| Measured capacity | Real public-internet 10k concurrency all green: ack p95 **0.46ms**, seqGap **0** (`docs/reports/2026-06-07-tier2-public-loadtest-10k-20k.md`, scenario A); single-gateway ceiling measured at **~15,777 connections / ~50k bids/s**, bottlenecked on gateway CPU/memory, with an automatic restart and **correctness never broken** (same report, scenario B); the public-readiness check is in `docs/reports/2026-06-06-public-locust-10k-beijing-readiness.md` |

## 2. Bid idempotency

| Claim | Evidence |
|---|---|
| A retry replays the original ack instead of erroring | `place_bid.lua:32-44`: dedupe is keyed on **(auction, userId, clientBidId)** and a hit returns `{'DUPLICATE', original ack}` (TTL 86400s) |
| Adjudication is atomic at a single point | One Redis Lua script does state/seller/amount/cap/dedupe/seq/anti-snipe/Stream/publish (`place_bid.lua:1`); Lua has no rollback, so every key is type-guarded before any write (`:21-30`) |
| Client-side idempotency token | `crypto.randomUUID()` mints the clientBidId (`apps/web/src/routes/LiveRoomRoute.jsx:363-367`) |
| Safe HTTP→WS channel switching | The frontend prefers the HTTP command channel with WS `BID_PLACE` as fallback (`LiveRoomRoute.jsx:118-134 submitBidCommand`); retrying on the other channel cannot double-charge, because idempotency lives in the server-side dedupe and is independent of the entry point |
| Gateway fast-reject does not break idempotency | Tier-C fast reject pre-checks dedupe with a pipelined HEXISTS, so a duplicate retry always falls through to the Lua replay (`ws.go:1383-1386,1442-1443`); measured, fast reject absorbs 99.97% of doomed bids at ack p95 3.5ms @ 20k bids/s (Tier-2 report, scenario C) |
| Hidden adversarial tests pin the boundary | `server/ws_t2_pdggk_hidden_input_test.go`, `store/lua_t2_hidden_unwinnable_first_bid_test.go`, `store/lua_t2_pdggk_hidden_money_precision_test.go` |

## 3. Cross-client state synchronization

| Claim | Evidence |
|---|---|
| Monotonic seq, acceptance is seq gap = 0 (frozen) | Lua mints seq at a single point; the load-test net asserts seqGap==0 (`infra/docker-compose.yml:128-137`); both public reports show seqGap=0 throughout |
| Reconnect catchup: ROOM_JOIN(lastSeq) replays from the Stream | Acceptance is **200 events < 1s**; `catchupMaxGap=200` (`ws.go:31-33`); smoke test `apps/web/scripts/smoke-catchup.mjs` |
| Too large a gap → snapshot rescue | Beyond 200 the server sends ROOM_SNAPSHOT instead of a massive replay (`ws.go:31-33`); the REST snapshot path has its own `smoke-snapshot-fallback.mjs` |
| Server clock correction | The heartbeat carries serverTs to compute the offset and every countdown uses `serverNow()` (`apps/web/src/lib/clock.js`); the room UI shows a visible **Δms** drift chip (`components/primitives.jsx:662`) |
| Gesture-level self-recovery | Pull-to-resync (`apps/web/src/components/PullToResync.jsx`) |
| Latency budget (frozen) | ack p95 < **80ms** · broadcast p95 < **150ms** · hammer p95 < **500ms**; P0 scale is 500 connections + 50 active (stretch 1k+100) |

## 4. Forward-looking bonus items

| Claim | Evidence |
|---|---|
| Auditable evidence chain: HMAC hash chain + replay verifier | HMAC-SHA256 over `prev_hash\nseq\nevent_type\npayload` (`apps/lumen/internal/server/verify.go:38`); `RunVerify`/`RunVerifyEvidence` do the three-way comparison plus chain check (`verify.go:42,67,104-106`); the compose `verifier` service runs it in one command |
| A broken chain is shown to judges directly in the UI | The `/preview/evidence/broken` CHAIN BROKEN preview (`apps/web/src/routes/IndexPage.jsx:61-62`) |
| AI never adjudicates a bid (frozen boundary) | AI is a sidecar (`server.go:61` AuctioneerHooks→`apps/ai-sidecar/`); if AI dies the auction carries on and the frontend degrades to "the auctioneer has stepped away" (`LiveRoomRoute.jsx:346`); `make chaos-ai` verifies the bid path is independent (`Makefile:190`) |
| Money is a string end to end: zero precision loss across JS/Go/Lua | `MAX_MONEY = 2^53-1` (`place_bid.lua:17-19`); the Go entry points guard with canonicalAmount (`ws.go:1545-1551`, `api.go:203`); the frontend compares with BigInt; precision is pinned by the hidden test `lua_t2_pdggk_hidden_money_precision_test.go` |
| Frame-budget-adaptive animation degradation | 30 consecutive frames over 22ms (~45fps) → `body.surface-calm` turns off decorative animation (`apps/web/src/lib/perf/frameBudget.js`, `main.jsx:10`, `styles.css:444+`) |
| Chaos drills are institutionalized (dev-only, fail-closed) | `LUMEN_CHAOS_DISABLE_TIMER=1` is only honoured when APP_ENV=dev, and startup is refused outside dev (`server.go:104-115`); `make chaos-timer` and the other four drills (`Makefile:187-364`, `docs/t9-chaos.md`) |

## 5. Defence demo action list (≤30s each)

| # | Action | Expected screen | Entry point |
|---|---|---|---|
| 1 | Idempotent double-send: fire the same clientBidId twice | The second call replays the original seq and the room sees no second broadcast | `npm run smoke:multigw` dup stage (scripted assertion); manually, wscat the same frame twice |
| 2 | Disconnect for 5 seconds, then reconnect | ROOM_JOIN(lastSeq) catches up and seq is continuous with no holes | `npm run smoke:catchup`; on a phone, use airplane mode for 5s + pull-to-resync |
| 3 | Two phones bidding across two gateways | Bid on :8080, the price jumps on :8081 in the same frame with the same seq | `--profile multigw up` plus two phones in the same room (`docs/demo/multi-gateway-demo.md`) |
| 4 | Broken evidence-chain preview | CHAIN BROKEN red state vs CHAIN VERIFIED | Open `/preview/evidence/broken` in the browser |
