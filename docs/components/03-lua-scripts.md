# Component 03 — Lua Scripts

> **Path**: `apps/lumen/lua/`
> **Owner discipline**: leader writes; **all-member approve** for any return-code change (V9 §6 boundary).
> **Gates trunk**: T1 (place_bid stub) → T2 (full atomic) → T3 (close_auction + cancel_auction + anti-snipe inside place_bid).
> **Cross-references**: `proto/redis-keys.md`, `proto/error-codes.md`, `proto/ws-envelope.md`, `docs/state-machine.md`.

## Purpose

Redis Lua is the **only** writer to hot keys (`state:{aid}`, `lb:{aid}`, `ev:{aid}`, `dedupe:{aid}:*`). All adjudication (accept/reject bid, hammer, cancel) runs inside a single Lua call so the side effects are atomic relative to other Redis ops. Bid Engine, Timer Worker, and Auction Service are dispatchers — they load the script SHA at startup and call `EVALSHA` per command.

## Files and roles

| File | Purpose | Caller |
|---|---|---|
| `place_bid.lua` | accept/reject a bid; anti-snipe extension if applicable; emit Stream event | Bid Engine |
| `close_auction.lua` | terminal transition (`SOLD` or `NO_BID`) at `now >= endAtMs`; idempotent; emits terminal Stream event | Timer Worker |
| `cancel_auction.lua` | abnormal cancel from `DRAFT` / `SCHEDULED` / `LIVE` → `CANCELLED`; emits Stream event | Auction Service (REST) |
| `start_auction.lua` | `SCHEDULED → LIVE` transition; sets `endAtMs = now + duration_ms` | Auction Service (REST) on `/auctions/{id}/start` |
| `freeze_rules.lua` | `DRAFT → SCHEDULED`; copies rule fields into `state:{aid}` Hash; marks immutable | Auction Service (REST) on `/auctions/{id}/freeze` |

All scripts are loaded once at engine startup via `SCRIPT LOAD`; SHA1 cached on the dispatcher struct.

## Key invariants enforced inside Lua

1. **Single seq**: `INCR state:{aid}:seq` is the only seq source. Used both as `seq` field and as Stream ID prefix (`<seq>-0`).
2. **State machine canonical names**: `DRAFT`, `SCHEDULED`, `LIVE`, `SOLD`, `NO_BID`, `CANCELLED`. No `BIDDING`, `HAMMERED`, `PASSED`, `RESERVE_NOT_MET` anywhere in Lua.
3. **Time source**: `redis.call('TIME')` only. Never `now` from KEYS or ARGV (engines can clock-drift).
4. **Boundary**: `>=` for `now >= endAtMs`. Documented in `state-machine.md`.
5. **Dedupe**: `dedupe:{aid}:{userId}:{clientBidId}` Hash with cached ack JSON. Retry → return cached ack (NOT an error).
6. **Hash tag discipline**: every key starts with `{<aid>}` so all keys hash to the same Redis slot. Enforced by KEYS layout (callers must pass keys in this order — see proto/redis-keys.md).

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

```lua
-- KEYS[1] = state:{aid}           Hash: status, currentPriceCents, topUserId, minIncrementCents, capPriceCents, endAtMs, antiSnipeMs, extendCount, seq, paused
-- KEYS[2] = lb:{aid}              Sorted Set: userId -> amountCents
-- KEYS[3] = stream:{aid}          Stream: event log
-- KEYS[4] = dedupe:{aid}:{uid}:{cbid}   Hash: ack (cached return payload as JSON)
-- ARGV[1] = userId
-- ARGV[2] = clientBidId
-- ARGV[3] = amountCents     (string, parsed inside)
-- ARGV[4] = displayName     (for stream payload)

local state_key   = KEYS[1]
local lb_key      = KEYS[2]
local stream_key  = KEYS[3]
local dedupe_key  = KEYS[4]

-- 1. Dedupe — cached ack short-circuit (returns OK as DUPLICATE marker)
local cached = redis.call('HGET', dedupe_key, 'ack')
if cached then
  return {'DUPLICATE', cached}
end

-- 2. Load state
local s = redis.call('HMGET', state_key,
  'status', 'currentPriceCents', 'minIncrementCents', 'capPriceCents',
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
if paused == 'true' then
  return {'ERR_AUCTION_PAUSED'}
end
if status ~= 'LIVE' then
  return {'ERR_NOT_LIVE', status or 'UNKNOWN'}
end

-- 4. Time check (Redis TIME = {seconds, microseconds})
local t = redis.call('TIME')
local now_ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

if now_ms >= end_at_ms then
  return {'ERR_AFTER_END', end_at_ms, now_ms}
end

-- 5. Amount validation
local amount = tonumber(ARGV[3])
if not amount or amount < (current + increment) or amount > cap then
  return {'ERR_TOO_LOW', current, increment, cap}
end

-- 6. Allocate seq (INCR is atomic in single-threaded Redis)
local seq = redis.call('HINCRBY', state_key, 'seq', 1)

-- 7. Anti-snipe: if within last antiSnipeMs of endAtMs, extend
local extended = false
local new_end_at_ms = end_at_ms
if (end_at_ms - now_ms) <= snipe_ms then
  new_end_at_ms = now_ms + snipe_ms
  extend_cnt = extend_cnt + 1
  redis.call('HMSET', state_key,
    'endAtMs', new_end_at_ms,
    'extendCount', extend_cnt)
  extended = true
end

-- 8. Cap hit → terminal SOLD inside the same script (atomic with the winning bid)
local cap_hit = (amount == cap)
local final_status
if cap_hit then
  redis.call('HMSET', state_key,
    'status', 'SOLD',
    'currentPriceCents', amount,
    'topUserId', ARGV[1])
  final_status = 'SOLD'
else
  redis.call('HMSET', state_key,
    'currentPriceCents', amount,
    'topUserId', ARGV[1])
  final_status = 'LIVE'
end

-- 9. Leaderboard update
redis.call('ZADD', lb_key, amount, ARGV[1])

-- 10. Build payload (encoded as JSON via cjson)
local payload = cjson.encode({
  seq = seq,
  userId = ARGV[1],
  displayName = ARGV[4],
  amountCents = ARGV[3],
  serverTimeMs = now_ms,
  endAtMs = new_end_at_ms,
  extendCount = extend_cnt,
  extended = extended,
  status = final_status,
})

-- 11. Stream emit. Stream ID = "<seq>-0" so Stream order matches seq order.
local stream_id = seq .. '-0'
if cap_hit then
  redis.call('XADD', stream_key, stream_id,
    'type', 'AUCTION_SOLD',
    'seq',  seq,
    'payload', payload)
elseif extended then
  -- two events under one seq: BID_ACCEPTED then AUCTION_EXTENDED
  -- but Stream IDs must be unique → use the seq as monotonic group; emit AUCTION_EXTENDED inline in payload + as separate XADD with synthetic suffix "<seq>-1"
  redis.call('XADD', stream_key, stream_id,
    'type', 'BID_ACCEPTED',
    'seq',  seq,
    'payload', payload)
  redis.call('XADD', stream_key, seq .. '-1',
    'type', 'AUCTION_EXTENDED',
    'seq',  seq,
    'payload', cjson.encode({
      newEndAtMs = new_end_at_ms,
      extendCount = extend_cnt,
      triggeredBySeq = seq,
    }))
else
  redis.call('XADD', stream_key, stream_id,
    'type', 'BID_ACCEPTED',
    'seq',  seq,
    'payload', payload)
end

-- 12. Cache ack into dedupe Hash (TTL = max auction duration + buffer, set by engine)
local ack_code = cap_hit and 'OK_SOLD' or (extended and 'OK_EXTENDED' or 'OK_ACCEPTED')
local ack_payload = cjson.encode({code = ack_code, payload = payload})
redis.call('HSET', dedupe_key, 'ack', ack_payload)
-- TTL set by engine on first creation; HSET preserves it on later writes

-- 13. Pub/Sub fanout hint (not authoritative; Stream is canonical)
redis.call('PUBLISH', 'room:' .. KEYS[1]:gsub('state:', ''), payload)

-- 14. Return
return {ack_code, payload}
```

**Notes / design calls inside the script:**

- **Anti-snipe stream-id collision**: when an accepted bid also extends, we emit *two* events sharing the same `seq` but Stream IDs `<seq>-0` and `<seq>-1`. Client seq-guard treats these as two events at the same seq — must dedupe by `(seq, type)`, not by `seq` alone.
- **Cap-hit terminal inside place_bid**: the bid that hits cap *is* the closing bid. We change `status → SOLD` in the same script so no race window between accept and hammer. Order Service is triggered by the `AUCTION_SOLD` stream event regardless of who emitted it (place_bid or close_auction).
- **HMAC / hash chain NOT computed here.** Per #14 challenge 3: the `event_hash` is computed by Persistence Worker on Stream→MySQL projection. Lua only writes the event payload to Stream.

## `close_auction.lua` — full pseudocode

```lua
-- KEYS[1] = state:{aid}
-- KEYS[2] = lb:{aid}
-- KEYS[3] = stream:{aid}
-- ARGV    = (none — uses Redis TIME)

local state_key  = KEYS[1]
local lb_key     = KEYS[2]
local stream_key = KEYS[3]

local s = redis.call('HMGET', state_key,
  'status', 'currentPriceCents', 'topUserId', 'endAtMs')
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

redis.call('PUBLISH', 'room:' .. (KEYS[1]:gsub('state:', '')), payload)

return {has_bid and 'OK_SOLD' or 'OK_NO_BID', payload}
```

## `cancel_auction.lua` — pseudocode

```lua
-- KEYS[1] = state:{aid}
-- KEYS[2] = stream:{aid}
-- ARGV[1] = actorUserId (for audit; ownership pre-checked in Go layer)
-- ARGV[2] = reason       (string)

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
  reason = ARGV[2],
  actorUserId = ARGV[1],
  serverTimeMs = now_ms,
  fromStatus = status,
})

redis.call('XADD', stream_key, seq .. '-0',
  'type', 'AUCTION_CANCELLED',
  'seq', seq,
  'payload', payload)

redis.call('PUBLISH', 'room:' .. (KEYS[1]:gsub('state:', '')), payload)

return {'OK_CANCELLED', payload}
```

## `start_auction.lua` and `freeze_rules.lua` — short specs

**`freeze_rules.lua`** (DRAFT → SCHEDULED):
- KEYS: `state:{aid}`, `stream:{aid}`
- ARGV: `startCents`, `incrementCents`, `capCents`, `durationMs`, `antiSnipeMs`
- Guard: status must be `DRAFT`. Else `ERR_BAD_STATE`.
- HMSET all rule fields + `status = SCHEDULED`, `currentPriceCents = startCents`, `seq = 0`.
- XADD `AUCTION_FROZEN` with rule snapshot.
- Return `{'OK_FROZEN', payload}`.

**`start_auction.lua`** (SCHEDULED → LIVE):
- KEYS: `state:{aid}`, `stream:{aid}`
- ARGV: (none — uses Redis TIME)
- Guard: status must be `SCHEDULED`. Else `ERR_BAD_STATE`.
- Read `durationMs` from state. `now = TIME; endAtMs = now + durationMs`.
- HMSET `status = LIVE, endAtMs = endAtMs`.
- INCR seq; XADD `AUCTION_STARTED` with `{endAtMs, serverTimeMs}`.
- Return `{'OK_LIVE', payload}`.

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
| `TestPlaceBid_AntiSnipe_Extend` | `OK_EXTENDED`; endAtMs increased; 2 stream entries (`<seq>-0` BID_ACCEPTED + `<seq>-1` AUCTION_EXTENDED); extendCount += 1 |
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

1. **Anti-snipe stream-id `<seq>-1` collision**: if a future feature ever needs to emit 3+ events per seq, the synthetic suffix scheme breaks. Acceptable for P0 but document the constraint in `redis-keys.md`. Alternative: use seq+offset for unique IDs from the start (`<seq>-<offset>`).
2. **Cap-hit terminal in `place_bid.lua`**: alternative is to let `close_auction.lua` handle all terminals (cap-hit just sets a "pending close" flag, Timer Worker picks it up on next scan). Trade-off: simpler invariants vs. extra latency on cap-hit announcement. Current choice (terminal in place_bid) prioritizes user-perceived speed. Flag for Eliaaazzz.
3. **`PUBLISH` channel naming**: I used `room:<aid>`. `redis-keys.md` may have a different convention — align before merge.
4. **`maxmemory-policy`**: must be `noeviction` per script assumptions. Add to `infra/redis/redis.conf` review.
