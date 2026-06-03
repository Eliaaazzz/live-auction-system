-- place_bid_sealed.lua (issue #114): sealed-bid core. Shared by SEALED_FIRST and
-- VICKREY — the price rule differs only at close, so the bid path is identical.
--
-- Unlike place_bid.lua, the amount is NEVER revealed to the room during LIVE:
--  * bids are recorded in PRIVATE keys (a sorted set + a names hash), NOT in the
--    public leaderboard ZSET and NOT in the state Hash currentPriceCents — so
--    GET /leaderboard and ROOM_SNAPSHOT leak nothing.
--  * the Stream/PubSub event is SEALED_BID_RECEIVED, carrying only a running
--    COUNT + the bidder's display name + a commitment hash — no amount. This is
--    the bytes every room client sees (suspense: "N sealed bids placed"), and it
--    is what the evidence hash-chain binds.
--  * the bidder's OWN amount is returned to Go as an OK_ACCEPTED ack and pushed
--    only to their own socket (the existing direct-ack path) — never broadcast.
--
-- KEYS[1]=state KEYS[2]=sealedZ KEYS[3]=sealedNames KEYS[4]=stream KEYS[5]=dedupe:{userId}
-- ARGV[1]=userId ARGV[2]=clientBidId ARGV[3]=amountCents ARGV[4]=displayName ARGV[5]=pubChannel
--
-- Returns:
--   {'OK_ACCEPTED', seq, ackJson}   -- ackJson is the bidder's PRIVATE full ack
--   {'DUPLICATE', ackJson}          -- retry replays the original private ack
--   {'ERR_NOT_LIVE', status} {'ERR_AFTER_END', endAtMs, now} {'ERR_TOO_LOW', amount, floor}
--   {'ERR_NOT_ALLOWED','seller_self_bid'} {'ERR_AUCTION_PAUSED'}
--   {'ERR_INTERNAL', 'key_type' | 'seq_stream_mismatch'}
local state_key, sz_key, sn_key, stream_key, dedupe_key = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5]
local userId, clientBidId, displayName, pub = ARGV[1], ARGV[2], ARGV[4], ARGV[5]
local amountStr = ARGV[3]
local amount = tonumber(amountStr)
local MAX_MONEY = 9007199254740991

-- 0. type-guard every key BEFORE any write (Lua has no rollback; RFC v2 boundary 2).
local function bad_type(key, want)
  local t = redis.call('TYPE', key).ok
  return t ~= 'none' and t ~= want
end
if bad_type(state_key, 'hash') or bad_type(sz_key, 'zset') or bad_type(sn_key, 'hash')
   or bad_type(stream_key, 'stream') or bad_type(dedupe_key, 'hash') then
  return {'ERR_INTERNAL', 'key_type'}
end

-- 1. dedupe: a retry replays the bidder's original private ack (NOT an error).
local function ensure_dedupe_ttl()
  if redis.call('TTL', dedupe_key) < 0 then redis.call('EXPIRE', dedupe_key, 86400) end
end
local cached = redis.call('HGET', dedupe_key, clientBidId)
if cached then
  ensure_dedupe_ttl()
  return {'DUPLICATE', cached}
end

-- 2. state guards (sealed has no visible current price; the floor is the reserve).
local s = redis.call('HMGET', state_key,
  'status', 'paused', 'startPriceCents', 'capPriceCents', 'sellerId', 'seq', 'endAtMs')
local status          = s[1]
local paused          = s[2]
local startPriceCents = tonumber(s[3]) or 0
local capPriceCents   = tonumber(s[4]) or 0
local sellerId        = s[5]
local stateSeq        = tonumber(s[6]) or 0
local endAtMs         = tonumber(s[7]) or 0
if paused == 'true' then return {'ERR_AUCTION_PAUSED'} end
if status ~= 'LIVE' then return {'ERR_NOT_LIVE', status or 'UNKNOWN'} end
if sellerId and sellerId ~= '' and userId == sellerId then
  return {'ERR_NOT_ALLOWED', 'seller_self_bid'}
end

-- 3. time: Redis TIME authoritative, boundary >= (lost the race to close).
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if now >= endAtMs then return {'ERR_AFTER_END', endAtMs, now} end

-- 4. amount validation. No increment check (the price is hidden) — the floor is
-- the reserve (startPriceCents); the cap (if any) is still enforced defensively.
if not amount or amount <= 0 or amount > MAX_MONEY then return {'ERR_TOO_LOW', amount or 0, startPriceCents} end
if amount < startPriceCents then return {'ERR_TOO_LOW', amount, startPriceCents} end
if capPriceCents > 0 and amount > capPriceCents then return {'ERR_TOO_LOW', amount, capPriceCents} end

-- 5. preflight: stream last seq must match state seq before any mutation
-- (validate-before-write; no rollback).
local lastEntry = redis.call('XREVRANGE', stream_key, '+', '-', 'COUNT', 1)
local lastStreamSeq = 0
if lastEntry[1] then lastStreamSeq = tonumber(string.match(lastEntry[1][1], '^(%d+)')) or 0 end
if lastStreamSeq ~= stateSeq then return {'ERR_INTERNAL', 'seq_stream_mismatch'} end

-- 6. RECORD PRIVATELY. Keep each user's max sealed bid without ZADD GT so older
-- Redis versions remain compatible; the names hash maps userId -> displayName
-- for the reveal. The public leaderboard ZSET and the state Hash
-- currentPriceCents/winnerId are deliberately NOT touched (no leak).
local priorScore = redis.call('ZSCORE', sz_key, userId)
if not priorScore or tonumber(priorScore) < amount then
  redis.call('ZADD', sz_key, amountStr, userId)
end
redis.call('HSET', sn_key, userId, displayName)
local count = redis.call('ZCARD', sz_key)

local seq = redis.call('HINCRBY', state_key, 'seq', 1)

-- 7. REDACTED broadcast event (no amount) — the bytes every room client sees.
-- An earlier draft attached `commit = redis.sha1hex(user:amount:seq)` here so
-- the reveal could be checked against the chain. It was DROPPED (PR #117
-- review): SHA1 is unsalted and `amount` ∈ [startPrice, capPrice] is a small
-- search space, so an observer could brute-force the amount in milliseconds
-- and defeat the whole sealed mode. Integrity already lives in the HMAC-SHA256
-- evidence chain (server-computed over the persisted payload). For SEALED
-- bidding we rely on the same server-trust assumption ENGLISH already does.
local recv = {seq = seq, displayName = displayName, count = count, serverTimeMs = now}
local recvJson = cjson.encode(recv)
redis.call('XADD', stream_key, seq .. '-0', 'type', 'SEALED_BID_RECEIVED', 'seq', seq, 'payload', recvJson)
redis.call('PUBLISH', pub, cjson.encode({type = 'SEALED_BID_RECEIVED', seq = seq, data = recv}))

-- 8. PRIVATE ack for the bidder's own socket (their amount, shaped like
-- BID_ACCEPTED so the gateway direct-ack path is unchanged). The dedupe cache
-- stores this so a retry replays the bidder's own amount, never broadcast.
local ack = {seq = seq, userId = userId, displayName = displayName, amountCents = amountStr,
  endAtMs = endAtMs, status = 'LIVE', serverTimeMs = now}
local ackJson = cjson.encode(ack)
redis.call('HSET', dedupe_key, clientBidId, ackJson)
redis.call('EXPIRE', dedupe_key, 86400)
return {'OK_ACCEPTED', seq, ackJson}
