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

### `freeze_rules.lua(KEYS=[state], ARGV=[rulesJson])`  — **NEW contract (all-member approve)**
`DRAFT → SCHEDULED`. Copies rule fields into `state` Hash; **does NOT consume the bid `seq`** (seq is the event sequence; first bid = seq 1). Type-guards `state` before write.
Returns: `OK_FROZEN` · `ERR_BAD_STATE(status | 'key_type')`.
Seller ownership is enforced in **Go** (authoritative against MySQL) in T1; lua-level seller checks land in T2.

### `start_auction.lua(KEYS=[state], ARGV=[durationMs])`  — **NEW contract (all-member approve)**
`SCHEDULED → LIVE`. Sets `endAtMs = redisNow + durationMs`, `status=LIVE`; **does NOT consume the bid `seq`**. Type-guards `state` before write.
Returns: `OK_LIVE(endAtMs)` · `ERR_BAD_STATE(status | 'key_type')`.

### `place_bid.lua` — **T2 atomic core (all-member approve: Lua return)**
`EVALSHA KEYS=[state, leaderboard, events, dedupe:{userId}] ARGV=[userId, clientBidId, amountCents, displayName, pubChannel]`

Validation order (each step before any write; Lua has no rollback): type-guard all 4 keys → dedupe short-circuit → `paused` → `status==LIVE` → `now < endAtMs` (Redis TIME, `>=` loses to close) → amount range. Then accept atomically: `HINCRBY seq` → `HMSET currentPriceCents/winnerId` → `ZADD leaderboard GT amount userId` (keeps each member's accepted max) → optional anti-snipe / cap transition → `XADD <seq>-0` → `HSET dedupe` (24h TTL) → `PUBLISH`.

**Amount range** (single `ERR_TOO_LOW` namespace, error-codes.md): reject when `amount < currentPriceCents + incrementCents` **or** (`capPriceCents > 0` and `amount > capPriceCents`). `capPriceCents == 0` means no buy-now ceiling.

**Anti-snipe** (`OK_EXTENDED`): when not a cap-hit and `extendWindowSec > 0` and `extendSec > 0` and `endAtMs - now <= extendWindowSec*1000` → `endAtMs += extendSec*1000`, `HINCRBY extendCount`, and emit a second `AUCTION_EXTENDED` event. **No separate `extend.lua`.**

**Cap-hit / buy-now** (`OK_SOLD`): when `capPriceCents > 0` and `amount >= capPriceCents` → `status=SOLD` (terminal) and emit a second `AUCTION_SOLD` event. Cap-hit takes priority over anti-snipe.

**Secondary events consume their own `seq`** (a second `HINCRBY`) so every Stream entry keeps a unique `<seq>-0` id and the client seq-guard sees a gap-free log: `OK_EXTENDED`/`OK_SOLD` write `BID_ACCEPTED` at `seq` then `AUCTION_EXTENDED`/`AUCTION_SOLD` at `seq+1`.

Returns:
| code | shape |
|---|---|
| `OK_ACCEPTED` | `{code, seq, bidJson}` |
| `OK_EXTENDED` | `{code, seq, bidJson, seq2, extJson}` |
| `OK_SOLD` | `{code, seq, bidJson, seq2, soldJson}` |
| `DUPLICATE` | `{code, bidJson}` (cached original ack; **not** an error) |
| `ERR_NOT_LIVE` | `{code, status}` |
| `ERR_AFTER_END` | `{code, endAtMs, now}` |
| `ERR_TOO_LOW` | `{code, amount, minAccept}` |
| `ERR_AUCTION_PAUSED` | `{code}` |
| `ERR_INTERNAL` | `{code, 'key_type'}` |

`bidJson` (also the dedupe-cached ack and the Stream `BID_ACCEPTED` payload) = `BidAcceptedData{seq,userId,displayName,amountCents,endAtMs,status,serverTimeMs}` where `endAtMs` is the post-extension value and `status` is `SOLD` on a cap-hit else `LIVE`. The gateway acks the originating socket with `BID_ACCEPTED(bidJson)` for all accept codes; the `AUCTION_EXTENDED`/`AUCTION_SOLD` event reaches the room via Pub/Sub.

**Pub/Sub fanout message** (`auction:{<aid>}:pub`, non-authoritative): `{type, seq, data}` (`PubMessage`) — `type` is the wire type (`BID_ACCEPTED` / `AUCTION_EXTENDED` / `AUCTION_SOLD`), `data` is that type's payload. The gateway subscriber re-emits it as a WS envelope verbatim; the durable Stream remains the source of truth.

Invariants (frozen, RFC v2): single `seq` (`HINCRBY state seq`); Stream ID `<seq>-0`; Redis TIME authoritative, boundary `>=`; dedupe Hash returns original ack on retry; AOF everysec, Redis down → `ERR_AUCTION_PAUSED`. **`event_hash` is NOT computed in Lua** — Persistence Worker computes it on the MySQL projection (T4).
