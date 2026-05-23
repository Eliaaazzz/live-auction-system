# Component 03 — Lua Scripts

> **Path**: `apps/lumen/lua/`
> **Owner discipline**: leader writes; **all-member approve** for any return-code change (V9 §6 boundary).
> **Gates trunk**: T1 (place_bid stub) → T2 (full atomic) → T3 (close_auction + cancel_auction + anti-snipe inside place_bid).
> **Cross-references**: `proto/redis-keys.md`, `proto/error-codes.md`, `proto/ws-envelope.md`, `docs/state-machine.md`.

## Purpose

Redis Lua is the **only** writer to hot keys (`auction:{<aid>}:state`, `auction:{<aid>}:leaderboard`, `auction:{<aid>}:events`, `auction:{<aid>}:dedupe:{uid}` — all per canonical `proto/redis-keys.md` materialized in PR #19). All adjudication (accept/reject bid, hammer, cancel) runs inside a single Lua call so the side effects are atomic relative to other Redis ops. Bid Engine, Timer Worker, and Auction Service are dispatchers — they load the script SHA at startup and call `EVALSHA` per command.

## Files and roles

| File | Purpose | Caller |
|---|---|---|
| `place_bid.lua` | accept/reject a bid; anti-snipe extension if applicable; emit Stream event | Bid Engine |
| `close_auction.lua` | terminal transition (`SOLD` or `NO_BID`) at `now >= endAtMs`; idempotent; emits terminal Stream event | Timer Worker |
| `cancel_auction.lua` | abnormal cancel from `DRAFT` / `SCHEDULED` / `LIVE` → `CANCELLED`; emits Stream event | Auction Service (REST) |
| `start_auction.lua` | `SCHEDULED → LIVE` transition; sets `endAtMs = now + duration_ms` | Auction Service (REST) on `/auctions/{id}/start` |
| `freeze_rules.lua` | `DRAFT → SCHEDULED`; copies rule fields into `auction:{<aid>}:state` Hash; marks immutable | Auction Service (REST) on `/auctions/{id}/freeze` |

All scripts are loaded once at engine startup via `SCRIPT LOAD`; SHA1 cached on the dispatcher struct.

## Key invariants enforced inside Lua

1. **Single seq**: `HINCRBY auction:{<aid>}:state seq 1` (inside `place_bid.lua` only) is the only seq source. Used both as `seq` field and as Stream ID prefix (`<seq>-0`). **`freeze_rules.lua` and `start_auction.lua` do NOT touch `seq`** — those are state transitions, not bid events. First accepted bid must be `seq=1` with no gap (verified in PR #19 `apps/lumen/internal/lua/freeze_rules.lua:12-15` + `start_auction.lua:14`).
2. **State machine canonical names**: `DRAFT`, `SCHEDULED`, `LIVE`, `SOLD`, `NO_BID`, `CANCELLED`, `ORDER_CREATED`. No `BIDDING`, `HAMMERED`, `PASSED`, `RESERVE_NOT_MET` anywhere in Lua.
3. **Time source**: `redis.call('TIME')` only. Never `now` from KEYS or ARGV (engines can clock-drift).
4. **Boundary**: `>=` for `now >= endAtMs`. Documented in `state-machine.md`.
5. **Dedupe**: `auction:{<aid>}:dedupe:{userId}` Hash; `clientBidId` is a Hash **field** (not part of the key suffix), value = cached ack JSON. Retry with same `clientBidId` → return cached ack via `DUPLICATE` code (NOT an error).
6. **Hash tag discipline**: every key uses `auction:{<aid>}:*` so the `{<aid>}` cluster hash tag puts all auction-local keys in one Redis slot. Enforced by KEYS layout (callers must pass keys in this order — see proto/redis-keys.md).

## Return-code namespace

Two namespaces (per V9 §6 reconciliation):
- **Lua-internal**: tagged `OK_*` or `ERR_*`, returned as `{code, payload_array}`. Internal-only contract between Lua and the Go dispatcher.
- **Wire** (sent to client over WS): `BID_ACCEPTED`, `BID_REJECTED`, `AUCTION_SOLD`, `AUCTION_EXTENDED`, etc. Mapped from Lua return by Bid Engine.

### Lua-internal codes (this doc is the source; mirror to `proto/error-codes.md`)

| Code | Returned by | Meaning | Wire mapping |
|---|---|---|---|
| `OK_ACCEPTED` | place_bid | bid accepted, current price updated | `BID_ACCEPTED` |
| `OK_SOLD` | place_bid (cap hit) or close_auction | terminal SOLD with winner | `AUCTION_SOLD` |
| `OK_NO_BID` | close_auction | terminal with no accepted bids | `AUCTION_NO_BID` |
| `OK_CANCELLED` | cancel_auction | terminal cancel | `AUCTION_CANCELLED` |
| `OK_EXTENDED` | place_bid (anti-snipe branch) | accepted bid extended endAtMs | `BID_ACCEPTED` + emitted `AUCTION_EXTENDED` |
| `OK_LIVE` | start_auction | SCHEDULED → LIVE | `AUCTION_STARTED` (server emit) |
| `OK_FROZEN` | freeze_rules | DRAFT → SCHEDULED | `AUCTION_FROZEN` (server emit) |
| `DUPLICATE` | place_bid | client_bid_id seen before; payload = cached ack | (replay cached ack, NOT mapped to error) |
| `ERR_NOT_LIVE` | place_bid | state ≠ `LIVE` (terminal or pre-live) | `BID_REJECTED { code: ERR_NOT_LIVE }` |
| `ERR_AFTER_END` | place_bid | `now >= endAtMs` (race lost to close) | `BID_REJECTED { code: ERR_AFTER_END }` |
| `ERR_TOO_LOW` | place_bid | `amount < currentPrice + increment` OR `amount > capPrice` | `BID_REJECTED { code: ERR_TOO_LOW }` |
| `ERR_AUCTION_PAUSED` | place_bid | paused flag set (Redis-back recovery in progress) | `BID_REJECTED { code: ERR_AUCTION_PAUSED }` |
| `ERR_NOT_DUE` | close_auction | called before `now >= endAtMs` | (engine retries, doesn't surface to client) |
| `ERR_ALREADY_TERMINAL` | close_auction, cancel_auction | already in `SOLD`/`NO_BID`/`CANCELLED`/`ORDER_CREATED` | (engine no-op, doesn't surface) |
| `ERR_NOT_ALLOWED` | cancel_auction | caller not auction owner / admin | `OPERATION_REJECTED { code: ERR_NOT_ALLOWED }` |
| `ERR_BAD_STATE` | start_auction, freeze_rules | wrong source state | `OPERATION_REJECTED { code: ERR_BAD_STATE }` |

## `place_bid.lua` — full pseudocode

> **Updated v2 per PDGGK review of PR #16**: canonical Redis key names from `proto/redis-keys.md` (materialized in PR #19); single Stream entry per `seq` (no `<seq>-1` synthetic suffix — see `extended` flag inside payload); dedupe Hash keyed on `userId` with `clientBidId` as Hash field; `pubChannel` passed as ARGV[5] (matches PR #19 `apps/lumen/internal/lua/place_bid.lua`); type-guards before any write (V9 §0 boundary 2).

```lua
-- KEYS[1] = auction:{<aid>}:state         Hash: status, currentPriceCents, winnerId, minIncrementCents, capPriceCents, endAtMs, antiSnipeMs, extendCount, seq, paused
-- KEYS[2] = auction:{<aid>}:leaderboard   Sorted Set: userId -> amountCents
-- KEYS[3] = auction:{<aid>}:events        Stream: durable event log (ID = <seq>-0)
-- KEYS[4] = auction:{<aid>}:dedupe:{uid}  Hash: clientBidId → cached ack JSON
-- ARGV[1] = userId
-- ARGV[2] = clientBidId
-- ARGV[3] = amountCents     (string, parsed inside)
-- ARGV[4] = displayName     (for stream payload)
-- ARGV[5] = pubChannel      = "auction:<aid>:pub" (gateway PSUBSCRIBE pattern)

local state_key, lb_key, stream_key, dedupe_key = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local userId, clientBidId = ARGV[1], ARGV[2]
local displayName, pub    = ARGV[4], ARGV[5]
local amount = tonumber(ARGV[3])

-- 0. TYPE guards (V9 §0 boundary 2: Lua has no rollback → fail before any write
--    if any key is wrong type — prevents seq/price/leaderboard advancement
--    without durable evidence). Matches PR #19 place_bid.lua:8-17.
local function bad_type(key, want)
  local t = redis.call('TYPE', key).ok
  return t ~= 'none' and t ~= want
end
if bad_type(state_key, 'hash') or bad_type(lb_key, 'zset')
   or bad_type(stream_key, 'stream') or bad_type(dedupe_key, 'hash') then
  return {'ERR_INTERNAL', 'key_type'}
end

-- 1. Dedupe — cached ack short-circuit (NOT an error code; replay payload)
local function ensure_dedupe_ttl()
  if redis.call('TTL', dedupe_key) < 0 then
    redis.call('EXPIRE', dedupe_key, 86400)  -- 24h per proto/redis-keys.md
  end
end
local cached = redis.call('HGET', dedupe_key, clientBidId)
if cached then
  ensure_dedupe_ttl()
  return {'DUPLICATE', cached}
end

-- 2. Load state
local s = redis.call('HMGET', state_key,
  'status', 'currentPriceCents', 'incrementCents', 'capPriceCents',
  'endAtMs', 'antiSnipeMs', 'extendCount', 'paused')
local status     = s[1]
local current    = tonumber(s[2]) or 0
local increment  = tonumber(s[3]) or 0
local cap        = tonumber(s[4]) or 0
local end_at_ms  = tonumber(s[5]) or 0
local snipe_ms   = tonumber(s[6]) or 0
local extend_cnt = tonumber(s[7]) or 0
local paused     = s[8]

-- 3. Guards
if paused == 'true' then return {'ERR_AUCTION_PAUSED'} end
if status ~= 'LIVE' then return {'ERR_NOT_LIVE', status or 'UNKNOWN'} end

-- 4. Time check (Redis TIME = {seconds, microseconds})
local t = redis.call('TIME')
local now_ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if now_ms >= end_at_ms then return {'ERR_AFTER_END', end_at_ms, now_ms} end

-- 5. Amount validation — single ERR_TOO_LOW per #14 challenge #2 (no split into
--    ERR_INCREMENT/ERR_OVER_CAP; cap-hit is OK_SOLD success, not error)
if not amount or amount < (current + increment) or amount > cap then
  return {'ERR_TOO_LOW', current, increment, cap}
end

-- 6. Allocate seq (HINCRBY is atomic in single-threaded Redis); only writer of seq
local seq = redis.call('HINCRBY', state_key, 'seq', 1)

-- 7. Anti-snipe: if within last antiSnipeMs, extend in-place — NO separate Stream
--    entry (drops the v1 <seq>-1 synthetic suffix which violated the frozen
--    Stream ID = <seq>-0 rule per PDGGK review). The extension is signaled
--    via `extended: true` + `newEndAtMs` fields in the BID_ACCEPTED payload below.
local extended = false
local new_end_at_ms = end_at_ms
if (end_at_ms - now_ms) <= snipe_ms then
  new_end_at_ms = now_ms + snipe_ms
  extend_cnt = extend_cnt + 1
  redis.call('HMSET', state_key, 'endAtMs', new_end_at_ms, 'extendCount', extend_cnt)
  extended = true
end

-- 8. Cap hit → terminal SOLD in same script (atomic with winning bid)
local cap_hit = (amount == cap)
local final_status = cap_hit and 'SOLD' or 'LIVE'
local update_fields = {'currentPriceCents', amount, 'winnerId', userId}
if cap_hit then
  table.insert(update_fields, 'status')
  table.insert(update_fields, 'SOLD')
end
redis.call('HMSET', state_key, unpack(update_fields))

-- 9. Leaderboard
redis.call('ZADD', lb_key, amount, userId)

-- 10. Single Stream entry per seq (no <seq>-1 collision). Type = AUCTION_SOLD on
--     cap-hit, else BID_ACCEPTED. The `extended` + `newEndAtMs` + `extendCount`
--     fields in the payload tell the client an anti-snipe extension occurred —
--     FE can synthesize a UI-level "AUCTION_EXTENDED" toast from these fields
--     without needing a separate Stream entry.
local payload = cjson.encode({
  seq = seq, userId = userId, displayName = displayName,
  amountCents = ARGV[3], serverTimeMs = now_ms,
  endAtMs = new_end_at_ms, extendCount = extend_cnt, extended = extended,
  status = final_status,
})
local stream_type = cap_hit and 'AUCTION_SOLD' or 'BID_ACCEPTED'
redis.call('XADD', stream_key, seq .. '-0',
  'type', stream_type, 'seq', seq, 'payload', payload)

-- 11. Cache ack into dedupe Hash + ensure TTL
redis.call('HSET', dedupe_key, clientBidId, payload)
redis.call('EXPIRE', dedupe_key, 86400)

-- 12. Pub/Sub fanout hint — canonical channel "auction:<aid>:pub" passed as ARGV[5]
redis.call('PUBLISH', pub, payload)

-- 13. Return — ack code only signals to dispatcher; payload carries all detail
local ack_code = cap_hit and 'OK_SOLD' or 'OK_ACCEPTED'
return {ack_code, seq, payload}
```

**Notes / design calls inside the script:**

- **No separate `AUCTION_EXTENDED` Stream entry**: anti-snipe extension is encoded as `extended: true` + `newEndAtMs` fields inside the `BID_ACCEPTED` payload. FE synthesizes a UI toast from the flag. This keeps the V9 §0 boundary 3 invariant "Stream ID = `<seq>-0`" intact (no `<seq>-1` collision) and means clients dedupe purely by `seq`. Replay Verifier still reproduces full state from Stream alone.
- **No `OK_EXTENDED` Lua return code in T1**: the wire/ack is always `OK_ACCEPTED` for an accepted bid; the `extended` flag is a payload field, not a separate code. `proto/error-codes.md` lists `OK_EXTENDED` as a *T2+* reservation if we ever want a distinct dispatcher branch.
- **Cap-hit terminal inside place_bid**: the bid that hits cap *is* the closing bid. We change `status → SOLD` in the same script so no race window between accept and hammer. Order Service is triggered by the `AUCTION_SOLD` stream event regardless of who emitted it (place_bid or close_auction).
- **HMAC / hash chain NOT computed here.** Per #14 challenge 3: the `event_hash` is computed by Persistence Worker on Stream→MySQL projection. Lua only writes the event payload to Stream.

## `close_auction.lua` — full pseudocode

```lua
-- KEYS[1] = auction:{<aid>}:state
-- KEYS[2] = auction:{<aid>}:leaderboard
-- KEYS[3] = auction:{<aid>}:events
-- ARGV[1] = pubChannel = "auction:<aid>:pub"

local state_key  = KEYS[1]
local lb_key     = KEYS[2]
local stream_key = KEYS[3]

local s = redis.call('HMGET', state_key,
  'status', 'currentPriceCents', 'winnerId', 'endAtMs')
local status   = s[1]
local current  = tonumber(s[2]) or 0
local top_user = s[3]
local end_at_ms = tonumber(s[4]) or 0

-- Terminal guard (idempotent: timer may fire stale)
if status == 'SOLD' or status == 'NO_BID' or status == 'CANCELLED' or status == 'ORDER_CREATED' then
  return {'ERR_ALREADY_TERMINAL', status}
end
if status ~= 'LIVE' then
  return {'ERR_NOT_LIVE', status}
end

-- Re-check time (timer scan + engine dispatch lag could mean now < endAtMs)
local t = redis.call('TIME')
local now_ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if now_ms < end_at_ms then
  return {'ERR_NOT_DUE', end_at_ms, now_ms}
end

local seq = redis.call('HINCRBY', state_key, 'seq', 1)

-- Determine SOLD vs NO_BID
local has_bid = top_user and top_user ~= ''
local final_status = has_bid and 'SOLD' or 'NO_BID'

redis.call('HSET', state_key, 'status', final_status)

local payload = cjson.encode({
  seq = seq,
  status = final_status,
  winnerUserId = top_user or '',
  finalPriceCents = tostring(current),
  serverTimeMs = now_ms,
  endAtMs = end_at_ms,
})

local stream_type = has_bid and 'AUCTION_SOLD' or 'AUCTION_NO_BID'
redis.call('XADD', stream_key, seq .. '-0',
  'type', stream_type,
  'seq', seq,
  'payload', payload)

redis.call('PUBLISH', ARGV[1], payload)  -- ARGV[1] = "auction:<aid>:pub"

return {has_bid and 'OK_SOLD' or 'OK_NO_BID', payload}
```

> KEYS updated to canonical names; `close_auction.lua` should take `pubChannel` as ARGV[1] (consistent with `place_bid.lua` ARGV[5] convention) rather than parse the key name.

## `cancel_auction.lua` — pseudocode

```lua
-- KEYS[1] = auction:{<aid>}:state
-- KEYS[2] = auction:{<aid>}:events
-- ARGV[1] = pubChannel    = "auction:<aid>:pub"
-- ARGV[2] = actorUserId   (for audit; ownership pre-checked in Go layer)
-- ARGV[3] = reason        (string)

local state_key  = KEYS[1]
local stream_key = KEYS[2]

local status = redis.call('HGET', state_key, 'status')
if status == 'SOLD' or status == 'NO_BID' or status == 'CANCELLED' or status == 'ORDER_CREATED' then
  return {'ERR_ALREADY_TERMINAL', status}
end
if status ~= 'DRAFT' and status ~= 'SCHEDULED' and status ~= 'LIVE' then
  return {'ERR_NOT_ALLOWED', status or 'UNKNOWN'}
end

local seq = redis.call('HINCRBY', state_key, 'seq', 1)
redis.call('HSET', state_key, 'status', 'CANCELLED')

local t = redis.call('TIME')
local now_ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local payload = cjson.encode({
  seq = seq,
  status = 'CANCELLED',
  reason = ARGV[3],
  actorUserId = ARGV[2],
  serverTimeMs = now_ms,
  fromStatus = status,
})

redis.call('XADD', stream_key, seq .. '-0',
  'type', 'AUCTION_CANCELLED',
  'seq', seq,
  'payload', payload)

redis.call('PUBLISH', ARGV[1], payload)

return {'OK_CANCELLED', payload}
```

## `start_auction.lua` and `freeze_rules.lua` — short specs

> **Updated v2 per PDGGK review of PR #16**: aligned with PR #19 actual behavior. **freeze/start do NOT consume `seq` and do NOT write to the Stream in T1** — these are state transitions, not bid events. The first accepted bid is `seq=1`. (Matches `apps/lumen/internal/lua/freeze_rules.lua:12-15` + `start_auction.lua:14`.)

**`freeze_rules.lua`** (DRAFT → SCHEDULED):
- KEYS: `auction:{<aid>}:state`
- ARGV: `rulesJson` (single arg: JSON-encoded `{startPriceCents, incrementCents, capPriceCents, extendWindowSec, extendSec}`)
- TYPE-guard `state` Hash before any write.
- Guard: status must be `DRAFT` (or absent → treated as DRAFT in MySQL). Else `ERR_BAD_STATE(status | 'key_type')`.
- HMSET all rule fields + `status=SCHEDULED`, `currentPriceCents=startPriceCents`, **`seq=0`** (initial — first bid will `HINCRBY` to 1), `extendCount=0`, `winnerId=''`, `paused='false'`.
- **No XADD.** State transitions aren't bid events; if a future T needs an `AUCTION_FROZEN` audit event, it lands via an explicit all-member approve contract change.
- Return: `{'OK_FROZEN'}` (T-later may add a payload).

**`start_auction.lua`** (SCHEDULED → LIVE):
- KEYS: `auction:{<aid>}:state`
- ARGV: `durationMs`
- TYPE-guard `state` Hash before any write.
- Guard: status must be `SCHEDULED`. Else `ERR_BAD_STATE(status | 'key_type')`.
- Read TIME from Redis. `endAtMs = now_ms + durationMs`.
- HMSET `status=LIVE, endAtMs=endAtMs`. **Do NOT touch `seq`.**
- **No XADD.** Same reasoning as freeze.
- Return: `{'OK_LIVE', endAtMs}`.

Ownership is enforced in Go (`s.ownsAuction` reads from MySQL — authoritative). T1 lua is state-only; lua-level ownership lands in T2 if needed.

## Error handling strategy

- Lua never throws. Every path returns `{code, ...}`. Bid Engine maps `code` to wire response; unknown codes treated as 500.
- `redis.call` failures (e.g. cjson encode of bad input) WILL surface as Lua error → Bid Engine catches, returns `BID_REJECTED { code: ERR_INTERNAL }` to client, increments `bid_engine_lua_errors_total`. This should be 0 in CI; non-zero in prod pages on-call.
- AOF stall during a Lua call doesn't matter (Redis writes are buffered to AOF after execution); but if Redis OOMs mid-call, behavior is undefined. Mitigation: keep payload size capped (Stream event payload < 4KB), `maxmemory-policy = noeviction` so a full Redis fails the script rather than evicting state.

## Test surface

| Test (Go) | Verifies |
|---|---|
| `TestPlaceBid_HappyPath` | accept; seq increments; lb updated; Stream has 1 entry with `<seq>-0` |
| `TestPlaceBid_BelowIncrement` | `ERR_TOO_LOW`; no Stream entry; no seq increment |
| `TestPlaceBid_AboveCap` | `ERR_TOO_LOW`; no entry |
| `TestPlaceBid_AtCap` | `OK_SOLD`; state = `SOLD`; Stream has `AUCTION_SOLD` |
| `TestPlaceBid_AntiSnipe_Extend` | `OK_ACCEPTED`; endAtMs increased; **single** stream entry (`<seq>-0` `BID_ACCEPTED` with `extended:true` + `newEndAtMs` fields in payload); extendCount += 1 |
| `TestPlaceBid_AfterEnd_ReturnsERR_AFTER_END` | bid at `endAtMs + 1ms`; returns `ERR_AFTER_END` |
| `TestPlaceBid_DedupeReplay` | same `(userId, clientBidId)` twice → second returns `DUPLICATE` with byte-identical cached ack |
| `TestPlaceBid_Paused` | `paused = 'true'` → `ERR_AUCTION_PAUSED` |
| `TestPlaceBid_NonLiveStates` | each of `DRAFT`/`SCHEDULED`/`SOLD`/`NO_BID`/`CANCELLED` returns `ERR_NOT_LIVE` |
| `TestCloseAuction_HappyPath_WithBids` | LIVE + topUser → `OK_SOLD` + status `SOLD` |
| `TestCloseAuction_NoBids` | LIVE + no topUser → `OK_NO_BID` + status `NO_BID` |
| `TestCloseAuction_NotDue` | now < endAtMs → `ERR_NOT_DUE` (engine retries) |
| `TestCloseAuction_AlreadyTerminal` | called twice → second returns `ERR_ALREADY_TERMINAL`, no state change |
| `TestCancelAuction_FromEachState` | `DRAFT` / `SCHEDULED` / `LIVE` all → `OK_CANCELLED` |
| `TestCancelAuction_FromTerminal` | `SOLD`/`NO_BID`/`CANCELLED`/`ORDER_CREATED` → `ERR_ALREADY_TERMINAL` |
| `TestHammerRace_PlaceBidVsClose` | concurrent at `endAtMs`: 1 winner per spec — `close_auction` returns `OK_SOLD`, late `place_bid` returns `ERR_AFTER_END`. **Pinned oracle per V9 §4.1.** |
| `TestSeqMonotonic_500Concurrent` | 500 goroutines fire bids; assert `seq` is 1..500 with no gap, no duplicate |

Coverage target: **≥95%** per V9 §9. Run via `tools/lua-harness/` (Go + miniredis or real Redis docker — real Redis for the time-source tests).

## NEEDS HUMAN REVIEW

1. ~~**Anti-snipe stream-id `<seq>-1` collision**~~ — **RESOLVED v2**: dropped the synthetic suffix. Single Stream entry per seq, `extended` is a payload field. Aligns with V9 §0 boundary 3.
2. **Cap-hit terminal in `place_bid.lua`**: alternative is to let `close_auction.lua` handle all terminals (cap-hit just sets a "pending close" flag, Timer Worker picks it up on next scan). Trade-off: simpler invariants vs. extra latency on cap-hit announcement. Current choice (terminal in place_bid) prioritizes user-perceived speed. Flag for @Eliaaazzz T2 design.
3. ~~**`PUBLISH` channel naming**~~ — **RESOLVED v2**: canonical `auction:{<aid>}:pub`, passed by dispatcher as ARGV[5] (or ARGV[1] for close/cancel which take fewer args). Matches PR #19 `place_bid.lua` ARGV[5].
4. **`maxmemory-policy`**: must be `noeviction` per script assumptions. Add to `infra/redis/redis.conf` review.
5. ~~**freeze/start consume seq**~~ — **RESOLVED v2**: do NOT touch `seq`. First bid is `seq=1`. No Stream entries from freeze/start in T1.
