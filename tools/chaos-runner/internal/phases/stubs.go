// stubs.go — design specs for phases that are not yet implemented.
//
// Each stub captures the *contract* a future implementation must honor:
// what's injected, what wire codes are expected during degradation, and
// what the recovery deadline is. The orchestrator never calls these (Lookup
// returns ErrNotImplemented for them) — they exist so:
//
//  1. Anyone reading the package sees the full taxonomy in one place
//  2. Per-phase invariant lists are knowable before the phase is built
//     (PR #18 chaos.json dashboard can reserve panel slots; load-test
//     runbook can reference expected wire-code distributions)
//  3. The ratify gate is per-phase, not all-or-nothing: a single
//     implemented phase can be merged + drilled while others are still
//     pending design
//
// New (diversification proposal — see README §"Phase taxonomy"):
//
//   - slowclient   — saturate a bidder's bufferedAmount past 1MB/4MB to
//     test V9 §0 boundary 8 (force-close slow client without
//     affecting fast clients)
//   - schrodinger  — toxiproxy latency injection on Redis (200ms-2s per cmd)
//     so cluster is "up but slow" rather than fully down;
//     tests the gap between RedisDown alert and ack p95 drift
//   - tamper       — flip one byte in MySQL auction_events.event_hash;
//     verifier MUST return hash_break_at_seq exit 2;
//     proves the chain isn't decorative
//
// All three live alongside the 5 standard phases in the same dashboard +
// artifact format, NOT as a separate tooling category.
package phases

// Phase specs below are intentionally NOT exported as Phase implementations —
// Lookup() returns ErrNotImplemented for them. They live here as reference
// for whoever picks up the implementation work.

type _redisSpec struct{}

func (_redisSpec) Name() string                       { return "redis" }
func (_redisSpec) Kind() string                       { return "network" }
func (_redisSpec) ExpectedDegradeWireCodes() []string { return []string{"ERR_AUCTION_PAUSED"} }
func (_redisSpec) RecoveryDeadline() string           { return "10s" }

// Inject plan for redis:
//   - Toxiproxy: POST /proxies/redis/toxics {"type":"timeout","attributes":{"timeout":0}}
//     OR DELETE /proxies/redis (disable proxy entirely; both TCP RST on existing)
//   - Inflight EVALSHA calls fail → engine maps to ERR_AUCTION_PAUSED per ws.go:219-227
//   - Persistence Worker XReadGroup errors → backs off
//   - Timer Worker scan errors → silently retries on next tick
// Uninject plan:
//   - Remove toxic / re-enable proxy
//   - Next bid succeeds with seq continuing from pre-pause (NOT reset)

type _mysqlSpec struct{}

func (_mysqlSpec) Name() string                       { return "mysql" }
func (_mysqlSpec) Kind() string                       { return "network" }
func (_mysqlSpec) ExpectedDegradeWireCodes() []string { return nil } // MySQL is off the hot path
func (_mysqlSpec) RecoveryDeadline() string           { return "30s" }

// Inject plan for mysql:
//   - Toxiproxy: disable mysql proxy
//   - Bidding continues unaffected (V9 §0: MySQL not on hot path)
//   - Persistence Worker insert fails → events stay in Stream PEL
// Uninject:
//   - After recovery, PEL drains via XAUTOCLAIM
//   - lumen_persistence_consumer_lag returns to 0 within 30s

type _wsSpec struct{}

func (_wsSpec) Name() string                       { return "ws" }
func (_wsSpec) Kind() string                       { return "process_kill" }
func (_wsSpec) ExpectedDegradeWireCodes() []string { return nil } // T1 = single gateway; existing conns drop, new conns blocked until restart
func (_wsSpec) RecoveryDeadline() string           { return "5s" }

// Inject plan for ws:
//   - T1 single-gateway: `compose kill -s SIGKILL lumen` (since gateway is in-process)
//     → wait for compose restart policy to bring it back
//   - T5+ multi-gateway: target one gateway instance, observe client reconnect
//     lands on a different instance
//   - Client reconnect sends ROOM_JOIN with lastSeq → CATCHUP_EVENTS (or
//     ROOM_SNAPSHOT for gap > 200, per docs/components/01-ws-gateway.md)
// Uninject:
//   - automatic via compose restart policy

type _timerSpec struct{}

func (_timerSpec) Name() string                       { return "timer" }
func (_timerSpec) Kind() string                       { return "process_kill" }
func (_timerSpec) ExpectedDegradeWireCodes() []string { return nil } // bidding unaffected
func (_timerSpec) RecoveryDeadline() string           { return "10s" }

// Inject plan for timer:
//   - During the gap, auctions whose endAtMs passes stay LIVE (no premature SOLD)
//   - On restart, Timer acquires lease, scans, fires close_auction for each overdue
//   - lumen_timer_detection_lag_ms spikes during recovery but returns to budget

// ─── Diversification: 3 new phases proposed in this PR ──────────────────

type _slowclientSpec struct{}

func (_slowclientSpec) Name() string                       { return "slowclient" }
func (_slowclientSpec) Kind() string                       { return "client" }
func (_slowclientSpec) ExpectedDegradeWireCodes() []string { return nil } // fast clients unaffected
func (_slowclientSpec) RecoveryDeadline() string           { return "10s" }

// Inject plan for slowclient:
//   - Spawn 1 slow consumer: connects, JOIN room, but reads slowly (sleeps
//     200ms between frame reads). bufferedAmount climbs.
//   - Concurrently 10 fast bidders bid normally.
//   - At >1MB bufferedAmount on slow client, soft channels (chat/ai) drop.
//   - At >4MB, slow client is force-closed (V9 §0 boundary 8).
//   - **Invariant**: fast clients' ack p95 stays within normal envelope —
//     slow client never starves fast clients.

type _schrodingerSpec struct{}

func (_schrodingerSpec) Name() string                       { return "schrodinger" }
func (_schrodingerSpec) Kind() string                       { return "network" }
func (_schrodingerSpec) ExpectedDegradeWireCodes() []string { return nil } // ambiguous — no ERR_AUCTION_PAUSED
func (_schrodingerSpec) RecoveryDeadline() string           { return "30s" }

// Inject plan for schrodinger (this is the *gap-zone* drill PDGGK's diagram
// #5 doesn't cover):
//   - Toxiproxy: POST /proxies/redis/toxics {"type":"latency","attributes":{"latency":500}}
//   - Redis is UP (no ERR_AUCTION_PAUSED triggered) but every command takes ~500ms
//   - ack p95 drifts well above the 200ms floor
//   - RedisDown alert does NOT fire (up{job="redis"} == 1)
//   - AckLatencyAboveFloor alert (PR #18 alerts.yml) DOES fire
//   - **Invariant**: detection happens via SLO breach, not just up==0 —
//     proves the slowness-but-not-down case is handled by the dashboard
//     alerts and not invisible to ops

type _tamperSpec struct{}

func (_tamperSpec) Name() string                       { return "tamper" }
func (_tamperSpec) Kind() string                       { return "data" }
func (_tamperSpec) ExpectedDegradeWireCodes() []string { return nil } // bidding unaffected
func (_tamperSpec) RecoveryDeadline() string           { return "0s" }

// Inject plan for tamper:
//   - SQL: UPDATE auction_events SET event_hash = REVERSE(event_hash) WHERE auction_id=? AND seq=5
//   - Re-run `make verify --auction <aid>` → expect exit 2 with `hash_break_at_seq=5`
//   - Restore: write back the original event_hash from a pre-drill snapshot
//   - **Invariant**: this is the *positive proof* that the hash chain isn't
//     decorative. Without this drill, we claim "tamper-evident" but never
//     prove a tamper attempt actually triggers the alarm.
