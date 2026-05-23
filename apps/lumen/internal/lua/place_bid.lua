-- place_bid.lua (T1 = accept-any; full atomic validation is T2)
-- KEYS[1]=state  KEYS[2]=leaderboard  KEYS[3]=events(stream)  KEYS[4]=dedupe:{userId}
-- ARGV[1]=userId ARGV[2]=clientBidId ARGV[3]=amountCents(string) ARGV[4]=displayName ARGV[5]=pubChannel
local state_key, lb_key, stream_key, dedupe_key = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local userId, clientBidId, displayName, pub = ARGV[1], ARGV[2], ARGV[4], ARGV[5]
local amount = tonumber(ARGV[3])

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

-- 1. dedupe: retry returns the original ack (NOT an error)
local cached = redis.call('HGET', dedupe_key, clientBidId)
if cached then return {'DUPLICATE', cached} end

-- 2. state guards
local s = redis.call('HMGET', state_key, 'status', 'endAtMs', 'paused')
local status, endAtMs, paused = s[1], tonumber(s[2]) or 0, s[3]
if paused == 'true' then return {'ERR_AUCTION_PAUSED'} end
if status ~= 'LIVE' then return {'ERR_NOT_LIVE', status or 'UNKNOWN'} end

-- 3. time: Redis TIME authoritative, boundary >=
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if now >= endAtMs then return {'ERR_AFTER_END', endAtMs, now} end

-- 4. T1 only checks shape (>0). increment/cap/anti-snipe/cap-hit = T2.
if not amount or amount <= 0 then return {'ERR_TOO_LOW', 0, 0} end

-- 5. single seq, update price/winner, leaderboard
local seq = redis.call('HINCRBY', state_key, 'seq', 1)
redis.call('HMSET', state_key, 'currentPriceCents', amount, 'winnerId', userId)
redis.call('ZADD', lb_key, amount, userId)

-- 6. Stream append (ID = <seq>-0) + dedupe cache + pubsub fanout hint
local payload = cjson.encode({
  seq = seq, userId = userId, displayName = displayName,
  amountCents = ARGV[3], endAtMs = endAtMs, status = 'LIVE', serverTimeMs = now,
})
redis.call('XADD', stream_key, seq .. '-0', 'type', 'BID_ACCEPTED', 'seq', seq, 'payload', payload)
redis.call('HSET', dedupe_key, clientBidId, payload)
redis.call('PUBLISH', pub, payload)
return {'OK_ACCEPTED', seq, payload}
