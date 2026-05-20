# Redis Keys & Stream Schema — v1 (DRAFT)

Owner: @A (Realtime Engineer) · Status: DRAFT — freeze by **Day 2 (2026-05-20)**
Cross-ref: [ws-envelope.md](./ws-envelope.md), `bid.lua` in `apps/realtime/internal/bid/bid.lua`

---

## Conventions

- All keys prefixed with `auction:{aid}` where `aid` is a **ULID** string (lex-sortable, time-ordered).
- All amounts use `BIGINT cents`. Lua: `tonumber()`, never floats. UI: `intl.NumberFormat`.
- All timestamps in UTC `ms` (epoch). Lua reads `redis.call('TIME')` or `ARGV.now_ms` from client.
- Strings only — no Hash field type juggling. Lua does `tonumber` per call.

## Key inventory

| Key                                | Type   | TTL                      | Purpose                                                  |
|------------------------------------|--------|--------------------------|----------------------------------------------------------|
| `auction:{aid}:state`              | Hash   | until Settled + 7d       | Current auction snapshot (see below)                     |
| `auction:{aid}:ranking`            | ZSet   | until Settled + 7d       | `score=max_user_amount_cents`, `member=user_id`          |
| `auction:{aid}:events`             | Stream | retain ≥ 10k entries OR 24h, whichever larger | Durable event log (single source for catchup + PG) |
| `auction:{aid}:dedupe:{uid}`       | Set    | 24h                      | `client_bid_id` UUIDs for idempotency per user           |
| `auction:{aid}:pub`                | Pub/Sub| n/a                      | Fire-and-forget realtime fan-out to WS Gateways          |
| `auction:active`                   | Set    | manual                   | `aid` members — timer worker scan target                 |
| `room:{aid}:presence`              | Set    | per-member 30s (heartbeat refresh) | online users for `presence.snapshot`           |
| `bid_engine:lease:{aid}`           | String | 10s (refreshed)          | Optional P1 owner lease (P0 single instance, no lease)   |

## `auction:{aid}:state` Hash fields

| field                   | type | example       | notes                                            |
|-------------------------|------|---------------|--------------------------------------------------|
| `state`                 | str  | `Bidding`     | enum, see state machine in RFC v1 §7             |
| `seq`                   | int  | `42`          | monotonic, last-assigned                         |
| `max_amount_cents`      | int  | `123000`      | current leading bid                              |
| `max_user_id`           | str  | `u_01H...`    | current leader                                   |
| `step_cents`            | int  | `5000`        | frozen at open                                   |
| `ends_at_ms`            | int  | `1747...`     | dynamic: extended by anti-snipe                  |
| `anti_snipe_ms`         | int  | `30000`       | frozen at open                                   |
| `reserve_cents`         | int? | `100000`      | nullable                                         |
| `rules_frozen_at_seq`   | int  | `0`           | seq at which rules were frozen (0 = on open)     |
| `opened_at_ms`          | int  | `...`         |                                                  |
| `hammered_at_ms`        | int? |               | nullable, set on Hammered                        |

## Stream schema: `auction:{aid}:events`

`XADD <stream> * seq <n> type <t> payload <msgpack>`

Required fields per entry:
- `seq` — same value as state.seq for that event (monotonic)
- `type` — one of: `bid.accepted` | `state.changed` | `rule.changed` | `hammered` | `passed` | `reserve_not_met` | `cancelled`
- `payload` — msgpack-encoded event body (matches Envelope.body)

Trim policy: `XADD ... MAXLEN ~ 10000` on every append (approximate, performant).

### Consumer groups

| group       | consumer(s)                 | purpose                                         |
|-------------|-----------------------------|-------------------------------------------------|
| `pg_writer` | `apps/realtime/cmd/pg-writer` | Idempotent write to Postgres `bid_events` / `auction_events`. Uses `UNIQUE(auction_id, seq)` for idempotency. |
| `audit`     | (P2) external compliance    | reserved                                        |

PG writer offset is per-stream, persisted via consumer group. Recovery: replay from last ack.

## Lua scripts

| Script        | Path                                              | KEYS                                                       | Atomicity                       |
|---------------|---------------------------------------------------|------------------------------------------------------------|---------------------------------|
| `bid.lua`     | `apps/realtime/internal/bid/bid.lua`              | state, ranking, events, dedupe                             | Place bid + ZADD + XADD + PUBLISH |
| `hammer.lua`  | `apps/realtime/internal/bid/hammer.lua`           | state, events                                              | Conditional state→Hammered + XADD + PUBLISH |
| `freeze_rules.lua` | `apps/realtime/internal/bid/freeze_rules.lua` | state, events                                              | HSET rules + state→Bidding + XADD `rule.changed` |

All scripts loaded with `SCRIPT LOAD`, called with `EVALSHA`. Fallback `EVAL` on NOSCRIPT.

## Catchup semantics

- Client `last_seen_seq = N`.
- Server `XRANGE auction:{aid}:events - +` → filter `seq > N`.
- If oldest available `seq > N + 1` → return `snapshot.required` (client refetches via REST).

## Failure modes

| Failure                | Behavior                                                          |
|------------------------|-------------------------------------------------------------------|
| Lua XADD fails (OOM)   | Bid Engine returns `stream_append_failed`. Client may retry — `client_bid_id` dedupe ensures no double-accept. |
| Pub/Sub message drop   | Acceptable. Clients catchup via Stream on next reconnect/poll.    |
| PG writer crash        | Consumer group offset persists; replay on restart; PG `UNIQUE` makes it idempotent. |
| Redis main failover    | Bid Engine pauses (returns `auction_paused`). Resume after failover. |

## Open questions

- [ ] Stream retention: 10k events vs 24h — which dominates? Suggest both with `MAXLEN ~10000 MINID <now-24h>` if supported.
- [ ] Should `auction:active` use ZSet with score=`ends_at_ms` for cheaper timer scan?
- [ ] Per-user dedupe TTL — 24h enough? Some hackers can probe across days.
