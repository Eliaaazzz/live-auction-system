-- place_bid.lua (T2 = atomic bid core: state/seller/amount/cap/dedupe/seq/anti-snipe/Stream/publish)
-- KEYS[1]=state  KEYS[2]=leaderboard  KEYS[3]=events(stream)  KEYS[4]=dedupe:{userId}
-- ARGV[1]=userId ARGV[2]=clientBidId ARGV[3]=amountCents(canonical string) ARGV[4]=displayName ARGV[5]=pubChannel
--
-- Returns (proto/redis-keys.md · proto/error-codes.md):
--   {'OK_ACCEPTED', seq, bidJson}
--   {'OK_EXTENDED', seq, bidJson, seq2, extJson}   -- anti-snipe: bid + endAtMs bump
--   {'OK_SOLD',     seq, bidJson, seq2, soldJson}  -- cap-hit (buy-now): bid + terminal SOLD
--   {'DUPLICATE',   bidJson}                       -- retry replays original ack (NOT an error)
--   {'ERR_NOT_LIVE', status} {'ERR_AFTER_END', endAtMs, now} {'ERR_TOO_LOW', amount, required}
--   {'ERR_NOT_ALLOWED', 'seller_self_bid'} {'ERR_AUCTION_PAUSED'}
--   {'ERR_INTERNAL', 'key_type' | 'seq_stream_mismatch'}
local state_key, lb_key, stream_key, dedupe_key = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local userId, clientBidId, displayName, pub = ARGV[1], ARGV[2], ARGV[4], ARGV[5]
local amountStr = ARGV[3]
local amount = tonumber(amountStr)
-- 2^53-1: above this a float64 (Lua number / Redis ZSET score) loses integer
-- precision. Money is stored/compared as a string-exact int below this ceiling.
local MAX_MONEY = 9007199254740991

-- 0. type-guard every key BEFORE any write (Lua has no rollback; RFC v2 boundary 2).
-- A wrong-typed key must fail the script before it mutates seq/price/leaderboard.
local function bad_type(key, want)
  local t = redis.call('TYPE', key).ok
  return t ~= 'none' and t ~= want
end
if bad_type(state_key, 'hash') or bad_type(lb_key, 'zset')
   or bad_type(stream_key, 'stream') or bad_type(dedupe_key, 'hash') then
  return {'ERR_INTERNAL', 'key_type'}
end

-- 1. dedupe: retry returns the original ack (NOT an error). Idempotency is keyed
-- server-side on (auction, userId, clientBidId); the gateway never caches acks.
-- The key is the idempotency token: a retry replays the original ack regardless
-- of the amount sent (proto §4.1 "retry returns original ack, not an error").
local function ensure_dedupe_ttl()
  if redis.call('TTL', dedupe_key) < 0 then
    redis.call('EXPIRE', dedupe_key, 86400)
  end
end
local cached = redis.call('HGET', dedupe_key, clientBidId)
if cached then
  ensure_dedupe_ttl()
  return {'DUPLICATE', cached}
end

-- 2. state guards. Read every field needed for adjudication in one round trip.
local s = redis.call('HMGET', state_key,
  'status', 'endAtMs', 'paused', 'currentPriceCents', 'incrementCents',
  'capPriceCents', 'extendWindowSec', 'extendSec', 'extendCount', 'maxExtensions',
  'sellerId', 'seq')
local status            = s[1]
local endAtMs           = tonumber(s[2]) or 0
local paused            = s[3]
local currentPriceCents = tonumber(s[4]) or 0
local incrementCents    = tonumber(s[5]) or 0
local capPriceCents     = tonumber(s[6]) or 0
local extendWindowSec   = tonumber(s[7]) or 0
local extendSec         = tonumber(s[8]) or 0
local curExtendCount    = tonumber(s[9]) or 0
local maxExtensions     = tonumber(s[10]) or 0
local sellerId          = s[11]
local stateSeq          = tonumber(s[12]) or 0
if paused == 'true' then return {'ERR_AUCTION_PAUSED'} end
if status ~= 'LIVE' then return {'ERR_NOT_LIVE', status or 'UNKNOWN'} end
-- seller may not bid on their own auction (anti shill-bidding; §8 authz).
if sellerId and sellerId ~= '' and userId == sellerId then
  return {'ERR_NOT_ALLOWED', 'seller_self_bid'}
end

-- 3. time: Redis TIME authoritative, boundary >= (lost the race to close_auction).
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if now >= endAtMs then return {'ERR_AFTER_END', endAtMs, now} end

-- 4. amount / increment / cap validation (single ERR_TOO_LOW namespace per
-- error-codes.md: below-required AND over-cap are both "amount invalid"). The
-- gateway already rejects non-numeric/out-of-range with ERR_BAD_INPUT; this is
-- the defensive boundary (Lua is also a security boundary, never trust input).
if not amount or amount <= 0 or amount > MAX_MONEY then return {'ERR_TOO_LOW', amount or 0, 0} end
-- cap-aware required price: a buy-now bid that reaches the cap must be acceptable
-- even when current+increment would overshoot the cap.
local required = currentPriceCents + incrementCents
if capPriceCents > 0 and required > capPriceCents then required = capPriceCents end
if amount < required then return {'ERR_TOO_LOW', amount, required} end
if capPriceCents > 0 and amount > capPriceCents then return {'ERR_TOO_LOW', amount, required} end

-- 5. preflight: stream and state seq must be in lockstep before any mutation
-- (validate-before-write; no rollback). A desynced stream (e.g. an out-of-band
-- XADD leaving last id ahead of state.seq) would make the explicit <seq>-0 XADD
-- error AFTER seq/price/leaderboard were already mutated — a dirty write.
local lastEntry = redis.call('XREVRANGE', stream_key, '+', '-', 'COUNT', 1)
local lastStreamSeq = 0
if lastEntry[1] then
  lastStreamSeq = tonumber(string.match(lastEntry[1][1], '^(%d+)')) or 0
end
if lastStreamSeq ~= stateSeq then return {'ERR_INTERNAL', 'seq_stream_mismatch'} end

-- 6. ACCEPT. Single seq (HINCRBY), update price/winner, leaderboard (ZADD GT keeps
-- each member's accepted max). Money is written as the canonical STRING so values
-- up to MAX_MONEY stay exact (a Lua number arg would format via %.14g and lose
-- precision past 14 digits). cap==0 means "no buy-now ceiling".
local capHit = capPriceCents > 0 and amount >= capPriceCents
-- anti-snipe fires only inside the window AND while under the extension cap
-- (maxExtensions == 0 means unlimited). Past the cap the bid is accepted as a
-- normal bid: no endAtMs bump, no AUCTION_EXTENDED — bounds the auction lifetime.
local extend = (not capHit) and extendWindowSec > 0 and extendSec > 0
  and (endAtMs - now) <= extendWindowSec * 1000
  and (maxExtensions <= 0 or curExtendCount < maxExtensions)

local seq = redis.call('HINCRBY', state_key, 'seq', 1)
redis.call('HMSET', state_key, 'currentPriceCents', amountStr, 'winnerId', userId)
redis.call('ZADD', lb_key, 'GT', amountStr, userId)

local newEndAtMs = endAtMs
local extendCount = 0
if extend then
  newEndAtMs = endAtMs + extendSec * 1000
  extendCount = redis.call('HINCRBY', state_key, 'extendCount', 1)
  redis.call('HSET', state_key, 'endAtMs', newEndAtMs)
end
if capHit then
  redis.call('HSET', state_key, 'status', 'SOLD')
end

-- 7. BID_ACCEPTED event: Stream append (ID=<seq>-0), dedupe cache, pub fanout hint.
-- status reflects the post-transition room state (SOLD on cap-hit, else LIVE).
local bid = {
  seq = seq, userId = userId, displayName = displayName, amountCents = amountStr,
  endAtMs = newEndAtMs, status = (capHit and 'SOLD' or 'LIVE'), serverTimeMs = now,
}
local bidJson = cjson.encode(bid)
redis.call('XADD', stream_key, seq .. '-0', 'type', 'BID_ACCEPTED', 'seq', seq, 'payload', bidJson)
redis.call('HSET', dedupe_key, clientBidId, bidJson)
redis.call('EXPIRE', dedupe_key, 86400) -- 24h TTL (proto/redis-keys.md)
redis.call('PUBLISH', pub, cjson.encode({type = 'BID_ACCEPTED', seq = seq, data = bid}))

-- 8. Secondary terminal/extension event (same atomic script — no separate
-- extend.lua). It consumes its own seq so every Stream entry has a unique
-- <seq>-0 id and the client seq-guard sees a gap-free monotonic log.
if extend then
  local seq2 = redis.call('HINCRBY', state_key, 'seq', 1)
  local ext = {seq = seq2, endAtMs = newEndAtMs, extendCount = extendCount, serverTimeMs = now}
  local extJson = cjson.encode(ext)
  redis.call('XADD', stream_key, seq2 .. '-0', 'type', 'AUCTION_EXTENDED', 'seq', seq2, 'payload', extJson)
  redis.call('PUBLISH', pub, cjson.encode({type = 'AUCTION_EXTENDED', seq = seq2, data = ext}))
  return {'OK_EXTENDED', seq, bidJson, seq2, extJson}
end
if capHit then
  local seq2 = redis.call('HINCRBY', state_key, 'seq', 1)
  local sold = {seq = seq2, winnerId = userId, amountCents = amountStr, status = 'SOLD', serverTimeMs = now}
  local soldJson = cjson.encode(sold)
  redis.call('XADD', stream_key, seq2 .. '-0', 'type', 'AUCTION_SOLD', 'seq', seq2, 'payload', soldJson)
  redis.call('PUBLISH', pub, cjson.encode({type = 'AUCTION_SOLD', seq = seq2, data = sold}))
  return {'OK_SOLD', seq, bidJson, seq2, soldJson}
end
return {'OK_ACCEPTED', seq, bidJson}
