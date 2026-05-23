# Redis Keys & Lua Contracts

Materialized from PR #13 `docs/redis-keys.md`. All auction-local keys share the cluster hash tag `{<aid>}` so multi-key Lua stays in one slot. Lua has no rollback → type-guard + validate before write; business code must never write hot keys directly.

## Keys

```text
auction:{<aid>}:state        Hash   status,currentPriceCents,winnerId,endAtMs,seq,
                                    startPriceCents,incrementCents,capPriceCents,
                                    extendWindowSec,extendSec,extendCount,paused
auction:{<aid>}:leaderboard  ZSET   member=userId  score=accepted max amountCents
auction:{<aid>}:dedupe:{uid} Hash   clientBidId -> result json   (TTL 24h)
auction:{<aid>}:events       Stream durable ordered log; Stream ID = <seq>-0
auction:{<aid>}:pub          Pub/Sub wakeup + room fanout only (not authoritative)
auction:active               ZSET   member=auctionId score=endAtMs (Timer Worker, T3)
```

## P0 Lua scripts

`start_auction.lua`, `freeze_rules.lua`, `place_bid.lua`, `close_auction.lua` (T3), `cancel_auction.lua` (T3). **No `*_v2.lua`.** All loaded via `SCRIPT LOAD` at startup, SHA cached, called by `EVALSHA`.

### `freeze_rules.lua(aid, sellerId, rulesJson)`  — **NEW contract (all-member approve)**
`DRAFT → SCHEDULED`. Copies rule fields into `state` Hash, marks immutable.
Returns: `OK_FROZEN(seq)` · `ERR_BAD_STATE(status)` · `ERR_NOT_ALLOWED`.

### `start_auction.lua(aid, sellerId, durationMs)`  — **NEW contract (all-member approve)**
`SCHEDULED → LIVE`. Sets `endAtMs = redisNow + durationMs`, `status=LIVE`.
Returns: `OK_LIVE(seq, endAtMs)` · `ERR_BAD_STATE(status)` · `ERR_NOT_ALLOWED`.

### `place_bid.lua(aid, userId, clientBidId, amountCents, displayName)`
T1 = **accept-any** (shape-valid only): dedupe short-circuit → guard `status==LIVE` → `now < endAtMs` → `HINCRBY seq` → update price/winner → `ZADD` → `XADD <seq>-0` → `PUBLISH` → cache ack.
Returns (T1): `OK_ACCEPTED(seq,amount,endAtMs)` · `DUPLICATE(ack)` · `ERR_NOT_LIVE(status)` · `ERR_AFTER_END(endAtMs,now)`.
T2 adds: amount/increment/cap validation (`ERR_TOO_LOW`), anti-snipe (`OK_EXTENDED`), cap-hit (`OK_SOLD`).

Invariants (frozen, RFC v2): single `seq` (`HINCRBY state seq`); Stream ID `<seq>-0`; Redis TIME authoritative, boundary `>=`; dedupe Hash returns original ack on retry; AOF everysec, Redis down → `ERR_AUCTION_PAUSED`. **`event_hash` is NOT computed in Lua** — Persistence Worker computes it on the MySQL projection (T4).
