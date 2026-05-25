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

> **Updated v3 (post-T2 PR #26 implementation)** — canonical Redis key names from `proto/redis-keys.md` (materialized in PR #19); **secondary events (`AUCTION_EXTENDED` / `AUCTION_SOLD`) take their own `seq`** so every Stream entry is uniquely `<seq>-0` (no `<seq>-1` synthetic suffix, V9 §0 b3 honored); dedupe Hash keyed on `userId` with `clientBidId` as Hash field; `pubChannel` passed as ARGV[5] (matches PR #19 `apps/lumen/internal/lua/place_bid.lua`); type-guards before any write (V9 §0 boundary 2). T2 cap-aware required-price clamp + MAX_MONEY ceiling included.
>
> Design history (recorded for future readers): v1 used `<seq>-1` synthetic suffix → wrong (violated `<seq>-0` invariant); v2 used single Stream entry with `extended:true` payload flag → wrong (FE has to synthesize event; Replay Verifier needs special case); v3 = T2's double-entry-with-separate-seq → right (uniform Stream shape, FE handlers stay simple, 1:1 MySQL projection in T4).

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

-- 2. Load state (T2: extendWindowSec + extendSec are SEPARATE fields, and
--    maxExtensions bounds the anti-snipe runaway). amountStr is preserved
--    as a string so we write money exactly (Lua number→ZSET-score is a
--    double; values past 2^53 lose precision). MAX_MONEY = 2^53-1.
local MAX_MONEY  = 9007199254740991
local amount_str = ARGV[3]
local s = redis.call('HMGET', state_key,
  'status', 'currentPriceCents', 'incrementCents', 'capPriceCents',
  'endAtMs', 'extendWindowSec', 'extendSec', 'extendCount', 'maxExtensions', 'paused')
local status          = s[1]
local current         = tonumber(s[2])  or 0
local increment       = tonumber(s[3])  or 0
local cap             = tonumber(s[4])  or 0
local end_at_ms       = tonumber(s[5])  or 0
local extend_win_sec  = tonumber(s[6])  or 0
local extend_sec      = tonumber(s[7])  or 0
local extend_cnt      = tonumber(s[8])  or 0
local max_extensions  = tonumber(s[9])  or 0
local paused          = s[10]
local snipe_ms        = extend_win_sec * 1000  -- T2 "in the window" comparison

-- 3. Guards
if paused == 'true' then return {'ERR_AUCTION_PAUSED'} end
if status ~= 'LIVE' then return {'ERR_NOT_LIVE', status or 'UNKNOWN'} end

-- 4. Time check (Redis TIME = {seconds, microseconds})
local t = redis.call('TIME')
local now_ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if now_ms >= end_at_ms then return {'ERR_AFTER_END', end_at_ms, now_ms} end

-- 5. Amount validation — single ERR_TOO_LOW per #14 challenge #2 (no split into
--    ERR_INCREMENT/ERR_OVER_CAP). Cap-aware required price: a buy-now bid that
--    reaches the cap must be acceptable even when current+increment overshoots.
--    cap == 0 means no buy-now ceiling (validated at Rules.Validate).
local required = current + increment
if cap > 0 and required > cap then required = cap end
if not amount or amount <= 0 or amount > MAX_MONEY then return {'ERR_TOO_LOW', amount or 0, 0} end
if amount < required then return {'ERR_TOO_LOW', amount, required} end
if cap > 0 and amount > cap then return {'ERR_TOO_LOW', amount, required} end

-- 6. Decide branches BEFORE any mutation (validate-before-write; Lua no-rollback).
--    Anti-snipe only fires when not a cap-hit AND under the extension cap.
local cap_hit = cap > 0 and amount >= cap
local extend  = (not cap_hit) and snipe_ms > 0 and extend_sec * 1000 > 0
                and (end_at_ms - now_ms) <= snipe_ms
                and (max_extensions <= 0 or extend_cnt < max_extensions)

-- 7. Allocate the primary seq for the BID_ACCEPTED event.
local seq = redis.call('HINCRBY', state_key, 'seq', 1)
redis.call('HMSET', state_key, 'currentPriceCents', amount_str, 'winnerId', userId)
redis.call('ZADD', lb_key, 'GT', amount_str, userId)

-- 8. Apply extension or cap-hit state transitions.
local new_end_at_ms = end_at_ms
local new_extend_cnt = extend_cnt
if extend then
  new_end_at_ms = end_at_ms + extend_sec * 1000
  new_extend_cnt = redis.call('HINCRBY', state_key, 'extendCount', 1)
  redis.call('HSET', state_key, 'endAtMs', new_end_at_ms)
end
if cap_hit then
  redis.call('HSET', state_key, 'status', 'SOLD')
end

-- 9. Emit BID_ACCEPTED at <seq>-0 + cache ack + Pub/Sub fanout hint.
local bid = {
  seq = seq, userId = userId, displayName = displayName, amountCents = amount_str,
  endAtMs = new_end_at_ms, status = (cap_hit and 'SOLD' or 'LIVE'), serverTimeMs = now_ms,
}
local bidJson = cjson.encode(bid)
redis.call('XADD', stream_key, seq .. '-0',
  'type', 'BID_ACCEPTED', 'seq', seq, 'payload', bidJson)
redis.call('HSET', dedupe_key, clientBidId, bidJson)
redis.call('EXPIRE', dedupe_key, 86400)
redis.call('PUBLISH', pub, cjson.encode({type = 'BID_ACCEPTED', seq = seq, data = bid}))

-- 10. Secondary event takes ITS OWN seq → unique <seq>-0 (no <seq>-1 collision).
--     This is the v3 design (per T2 PR #26 implementation): clean Stream shape,
--     FE handlers stay simple, 1:1 Stream→MySQL projection in T4.
if extend then
  local seq2 = redis.call('HINCRBY', state_key, 'seq', 1)
  local ext = {seq = seq2, endAtMs = new_end_at_ms, extendCount = new_extend_cnt, serverTimeMs = now_ms}
  local extJson = cjson.encode(ext)
  redis.call('XADD', stream_key, seq2 .. '-0',
    'type', 'AUCTION_EXTENDED', 'seq', seq2, 'payload', extJson)
  redis.call('PUBLISH', pub, cjson.encode({type = 'AUCTION_EXTENDED', seq = seq2, data = ext}))
  return {'OK_EXTENDED', seq, bidJson, seq2, extJson}
end
if cap_hit then
  local seq2 = redis.call('HINCRBY', state_key, 'seq', 1)
  local sold = {seq = seq2, winnerId = userId, amountCents = amount_str, status = 'SOLD', serverTimeMs = now_ms}
  local soldJson = cjson.encode(sold)
  redis.call('XADD', stream_key, seq2 .. '-0',
    'type', 'AUCTION_SOLD', 'seq', seq2, 'payload', soldJson)
  redis.call('PUBLISH', pub, cjson.encode({type = 'AUCTION_SOLD', seq = seq2, data = sold}))
  return {'OK_SOLD', seq, bidJson, seq2, soldJson}
end
return {'OK_ACCEPTED', seq, bidJson}
```

**Notes / design calls inside the script:**

- **Secondary events take their own `seq`**: anti-snipe extension emits `AUCTION_EXTENDED` at `seq+1` (not `seq`); cap-hit emits `AUCTION_SOLD` at `seq+1`. Every Stream entry retains a unique `<seq>-0` ID — V9 §0 boundary 3 honored without the `<seq>-1` synthetic suffix. Replay Verifier reads each entry as a single event of one type (no special-case for "BID_ACCEPTED carrying an extension flag"); 1:1 Stream→MySQL projection in T4 stays trivial.
- **`OK_EXTENDED` is a T2 return code (not a t-later reservation)**: T2's `place_bid.lua` returns 5-element `{OK_EXTENDED, seq, bidJson, seq2, extJson}`. The dispatcher delivers `BID_ACCEPTED` directly to the originating socket; the `AUCTION_EXTENDED` event reaches the room via Pub/Sub fanout. Same pattern for `OK_SOLD` cap-hit.
- **`MaxExtensions` caps the anti-snipe runaway**: `extend` branch additionally guards on `(maxExtensions <= 0 or curExtendCount < maxExtensions)`. Past the cap, an in-window bid is `OK_ACCEPTED` (no `endAtMs` bump, no `AUCTION_EXTENDED`). Bounds auction lifetime; default `0` = unlimited for back-compat (see `proto/db-schema.md` `auction_rules.max_extensions`).
- **Cap-hit terminal inside place_bid**: the bid that hits cap *is* the closing bid. We change `status → SOLD` in the same script so no race window between accept and hammer. Order Service is triggered by the `AUCTION_SOLD` stream event regardless of who emitted it (place_bid or close_auction).
- **HMAC / hash chain NOT computed here.** Per #14 challenge 3: the `event_hash` is computed by Persistence Worker on Stream→MySQL projection. Lua only writes the event payload to Stream.

## `close_auction.lua` — full pseudocode

> **Updated v3 (post-T3 PR #29 / rollup #31)**: signature + return shape + payload field names synced to the materialized implementation in `apps/lumen/internal/lua/close_auction.lua`. v2 doc had a third KEYS slot for `leaderboard` (not read by close) and used payload fields `winnerUserId` / `finalPriceCents` (real fields are `winnerId` / `amountCents`). Per [Eliaaazzz PR #16 CR 5/25 02:25](https://github.com/Eliaaazzz/live-auction-system/pull/16#pullrequestreview-4353172832).

```lua
-- KEYS[1] = auction:{<aid>}:state
-- KEYS[2] = auction:{<aid>}:events       -- NO leaderboard key; close doesn't read it
-- ARGV[1] = pubChannel = "auction:{<aid>}:pub"
--
-- Returns (proto/error-codes.md):
--   {'OK_SOLD', seq, soldJson}            -- terminal SOLD, AUCTION_SOLD event @ <seq>-0
--   {'OK_NO_BID', seq, noBidJson}         -- terminal NO_BID, AUCTION_NO_BID event @ <seq>-0
--   {'ERR_NOT_DUE', endAtMs, now}         -- now < endAtMs (anti-snipe moved it forward; engine retries)
--   {'ERR_ALREADY_TERMINAL', status}      -- not LIVE (engine no-ops, Timer untracks)
--   {'ERR_INTERNAL', 'key_type' | 'seq_stream_mismatch'}

local state_key, stream_key = KEYS[1], KEYS[2]
local pub = ARGV[1]

-- (1) Type-guards on both keys before any write
local function bad_type(key, want)
  local t = redis.call('TYPE', key).ok
  return t ~= 'none' and t ~= want
end
if bad_type(state_key, 'hash') or bad_type(stream_key, 'stream') then
  return {'ERR_INTERNAL', 'key_type'}
end

local s = redis.call('HMGET', state_key, 'status', 'endAtMs', 'currentPriceCents', 'winnerId', 'seq')
local status    = s[1]
local endAtMs   = tonumber(s[2]) or 0
local priceStr  = s[3] or '0'
local winner    = s[4]
local stateSeq  = tonumber(s[5]) or 0

-- (2) Only a LIVE auction is hammerable. Anything else is a Timer no-op.
if status ~= 'LIVE' then return {'ERR_ALREADY_TERMINAL', status or 'UNKNOWN'} end

-- (3) Redis TIME is authoritative; boundary is `now >= endAtMs`. An anti-snipe
-- extension since the Timer scan lands here as ERR_NOT_DUE so the engine
-- refreshes the score and re-polls at the new time.
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if now < endAtMs then return {'ERR_NOT_DUE', endAtMs, now} end

-- (4) Validate-before-write seq preflight (Lua has no rollback). Stream's
-- last seq must match state.seq; otherwise the `<seq>-0` XADD would error
-- AFTER the HINCRBY, leaving status inconsistent.
local last = redis.call('XREVRANGE', stream_key, '+', '-', 'COUNT', 1)
local lastStreamSeq = 0
if last[1] then lastStreamSeq = tonumber(string.match(last[1][1], '^(%d+)')) or 0 end
if lastStreamSeq ~= stateSeq then return {'ERR_INTERNAL', 'seq_stream_mismatch'} end

-- (5) Commit terminal state + Stream entry at <seq>-0.
local seq = redis.call('HINCRBY', state_key, 'seq', 1)
if winner and winner ~= '' then
  redis.call('HSET', state_key, 'status', 'SOLD')
  local sold = {
    seq = seq, winnerId = winner, amountCents = priceStr,
    status = 'SOLD', serverTimeMs = now,
  }
  local soldJson = cjson.encode(sold)
  redis.call('XADD', stream_key, seq .. '-0', 'type', 'AUCTION_SOLD', 'seq', seq, 'payload', soldJson)
  redis.call('PUBLISH', pub, cjson.encode({type = 'AUCTION_SOLD', seq = seq, data = sold}))
  return {'OK_SOLD', seq, soldJson}
end
redis.call('HSET', state_key, 'status', 'NO_BID')
local nb = {seq = seq, status = 'NO_BID', serverTimeMs = now}
local nbJson = cjson.encode(nb)
redis.call('XADD', stream_key, seq .. '-0', 'type', 'AUCTION_NO_BID', 'seq', seq, 'payload', nbJson)
redis.call('PUBLISH', pub, cjson.encode({type = 'AUCTION_NO_BID', seq = seq, data = nb}))
return {'OK_NO_BID', seq, nbJson}
```

**Notes:**
- `winnerId` (not `winnerUserId`) and `amountCents` (not `finalPriceCents`) — proto/ws-envelope.md `AuctionSoldData` shape, reused from T2's cap-hit SOLD path so cap-hit and Timer-hammer emit identical event payloads.
- `OK_SOLD` / `OK_NO_BID` returns a 3-tuple `(code, seq, json)`. The seq is broken out so the Go dispatcher doesn't have to re-parse the JSON.
- `OK_SOLD` shape exactly matches T2's `place_bid.lua` cap-hit SOLD return so the Stream-first persistence projection is a single code path.

## `cancel_auction.lua` — pseudocode

> **Updated v3 (post-T3 PR #29 / rollup #31)**: DRAFT is handled in Go (`apps/lumen/internal/server/api.go::handleCancel` DRAFT branch does a MySQL-only status flip) NOT in Lua — DRAFT has no Redis state. The v2 doc said "DRAFT goes through Lua" which is wrong. Ownership check is **fail-CLOSED** inside Lua (v2's "ownership pre-checked in Go layer" is insufficient: a corrupt state Hash with empty/absent `sellerId` would let anyone cancel, the exact fail-open class `TestT3CancelFailClosedOnEmptySeller` covers). Per [Eliaaazzz PR #16 CR 5/25 02:25](https://github.com/Eliaaazzz/live-auction-system/pull/16#pullrequestreview-4353172832).

```lua
-- KEYS[1] = auction:{<aid>}:state
-- KEYS[2] = auction:{<aid>}:events
-- ARGV[1] = callerId    -- the user attempting the cancel; checked against state.sellerId
-- ARGV[2] = pubChannel  = "auction:{<aid>}:pub"
--
-- Returns (proto/error-codes.md):
--   {'OK_CANCELLED', seq, cancelJson}     -- terminal CANCELLED, AUCTION_CANCELLED event @ <seq>-0
--   {'ERR_NOT_ALLOWED', 'not_owner'}      -- callerId != state.sellerId, OR sellerId empty/absent (FAIL-CLOSED)
--   {'ERR_ALREADY_TERMINAL', status}      -- already terminal, or no Redis state (unfrozen DRAFT — handle in Go)
--   {'ERR_INTERNAL', 'key_type' | 'seq_stream_mismatch'}

local state_key, stream_key = KEYS[1], KEYS[2]
local callerId, pub = ARGV[1], ARGV[2]

-- (1) Type-guards
local function bad_type(key, want)
  local t = redis.call('TYPE', key).ok
  return t ~= 'none' and t ~= want
end
if bad_type(state_key, 'hash') or bad_type(stream_key, 'stream') then
  return {'ERR_INTERNAL', 'key_type'}
end

local s = redis.call('HMGET', state_key, 'status', 'sellerId', 'seq')
local status   = s[1]
local sellerId = s[2]
local stateSeq = tonumber(s[3]) or 0

-- (2) No Redis state (unfrozen DRAFT) OR already terminal → engine no-op.
-- DRAFT path is handled in Go: apps/lumen/internal/server/api.go::handleCancel
-- DRAFT branch does a MySQL-only status flip; no Lua involvement.
local function is_terminal(st)
  return st == 'SOLD' or st == 'NO_BID' or st == 'CANCELLED' or st == 'ORDER_CREATED'
end
if not status or status == false or is_terminal(status) then
  return {'ERR_ALREADY_TERMINAL', status or 'UNKNOWN'}
end

-- (3) Ownership — FAIL CLOSED. A frozen auction always has sellerId (freeze_rules
-- copies it in), so missing/empty sellerId means corrupt state → reject. Contrast
-- place_bid's seller-self-bid check which fails OPEN (there the safe default is
-- "accept the bid"; here the safe default is "deny the terminal-writing op").
if not sellerId or sellerId == '' or callerId ~= sellerId then
  return {'ERR_NOT_ALLOWED', 'not_owner'}
end

-- (4) Seq preflight (same no-dirty-write invariant as close_auction).
local last = redis.call('XREVRANGE', stream_key, '+', '-', 'COUNT', 1)
local lastStreamSeq = 0
if last[1] then lastStreamSeq = tonumber(string.match(last[1][1], '^(%d+)')) or 0 end
if lastStreamSeq ~= stateSeq then return {'ERR_INTERNAL', 'seq_stream_mismatch'} end

-- (5) Commit CANCELLED + Stream entry.
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local seq = redis.call('HINCRBY', state_key, 'seq', 1)
redis.call('HSET', state_key, 'status', 'CANCELLED')
local c = {seq = seq, status = 'CANCELLED', serverTimeMs = now}
local cJson = cjson.encode(c)
redis.call('XADD', stream_key, seq .. '-0', 'type', 'AUCTION_CANCELLED', 'seq', seq, 'payload', cJson)
redis.call('PUBLISH', pub, cjson.encode({type = 'AUCTION_CANCELLED', seq = seq, data = c}))
return {'OK_CANCELLED', seq, cJson}
```

**Notes:**
- Cancel is **NOT a hammer** — cancelling a LIVE auction that has a leading bid still emits `AUCTION_CANCELLED` (not `AUCTION_SOLD`); the leading bidder is not awarded the item. Pinned by `TestT3CancelLiveWithBidsGoesCancelledNotSold`.
- The `actorUserId` + `reason` payload fields the v2 doc described do not currently exist; if a future T needs an audit trail, they land via an explicit contract change.
- `pubChannel` is `ARGV[2]` (not `ARGV[1]`) here because the caller id comes first — it's the **input** that the Lua needs to validate, while `pubChannel` is a routing detail. Contrast `close_auction.lua` which has no caller id and puts `pubChannel` at `ARGV[1]`.

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
| `TestPlaceBid_AntiSnipe_Extend` | `OK_EXTENDED`; endAtMs increased; **two** stream entries (`<seq>-0` BID_ACCEPTED + `<seq+1>-0` AUCTION_EXTENDED, each uniquely identified); extendCount += 1 |
| `TestPlaceBid_AntiSnipeRespectsMaxExtensions` | with `MaxExtensions=N`: first N in-window bids return `OK_EXTENDED`; N+1th in-window bid returns `OK_ACCEPTED` with no endAtMs bump (auction lifetime bounded) |
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

1. ~~**Anti-snipe stream-id `<seq>-1` collision**~~ — **RESOLVED v3** (T2 PR #26 implementation): secondary events take their own seq, NOT `<seq>-1`. Single Stream entry per seq preserved. Honest design history: v1 used `<seq>-1` (wrong — boundary 3 violation); v2 (my PR #16 v2 patch) used single entry with `extended:true` flag (wrong — FE has to synthesize event, Verifier special-case); v3 (T2's chosen) = double-entry-with-separate-seq (right). My v2 patch was reversed by Eliaaazzz's T2 implementation; I conceded on PR #26 review. Docs now match T2.
2. **Cap-hit terminal in `place_bid.lua`**: alternative is to let `close_auction.lua` handle all terminals (cap-hit just sets a "pending close" flag, Timer Worker picks it up on next scan). Trade-off: simpler invariants vs. extra latency on cap-hit announcement. Current choice (terminal in place_bid) prioritizes user-perceived speed. Flag for @Eliaaazzz T2 design.
3. ~~**`PUBLISH` channel naming**~~ — **RESOLVED v2**: canonical `auction:{<aid>}:pub`, passed by dispatcher as ARGV[5] (or ARGV[1] for close/cancel which take fewer args). Matches PR #19 `place_bid.lua` ARGV[5].
4. **`maxmemory-policy`**: must be `noeviction` per script assumptions. Add to `infra/redis/redis.conf` review.
5. ~~**freeze/start consume seq**~~ — **RESOLVED v2**: do NOT touch `seq`. First bid is `seq=1`. No Stream entries from freeze/start in T1.
