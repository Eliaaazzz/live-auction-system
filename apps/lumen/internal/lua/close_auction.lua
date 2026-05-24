-- close_auction.lua (T3): Timer Worker-triggered hammer. Closes a LIVE auction
-- as SOLD (had a winning bid) or NO_BID (none). Does NOT depend on the next bid.
-- KEYS[1]=state  KEYS[2]=events(stream)  ARGV[1]=pubChannel
--
-- Returns (proto/error-codes.md):
--   {'OK_SOLD', seq, soldJson}            -- terminal SOLD, AUCTION_SOLD event
--   {'OK_NO_BID', seq, noBidJson}         -- terminal NO_BID, AUCTION_NO_BID event
--   {'ERR_NOT_DUE', endAtMs, now}         -- not yet expired (anti-snipe may have moved it); engine retries
--   {'ERR_ALREADY_TERMINAL', status}      -- not LIVE (already closed / cap-hit SOLD); engine no-ops
--   {'ERR_INTERNAL', 'key_type' | 'seq_stream_mismatch'}
local state_key, stream_key = KEYS[1], KEYS[2]
local pub = ARGV[1]

local function bad_type(key, want)
  local t = redis.call('TYPE', key).ok
  return t ~= 'none' and t ~= want
end
if bad_type(state_key, 'hash') or bad_type(stream_key, 'stream') then
  return {'ERR_INTERNAL', 'key_type'}
end

local s = redis.call('HMGET', state_key, 'status', 'endAtMs', 'currentPriceCents', 'winnerId', 'seq')
local status   = s[1]
local endAtMs  = tonumber(s[2]) or 0
local priceStr = s[3] or '0'
local winner   = s[4]
local stateSeq = tonumber(s[5]) or 0

-- only a LIVE auction can be hammered; anything else is a no-op for the Timer.
if status ~= 'LIVE' then return {'ERR_ALREADY_TERMINAL', status or 'UNKNOWN'} end

-- Redis TIME is authoritative; only close when actually due (boundary >=). An
-- anti-snipe extension since the Timer's scan would land here as ERR_NOT_DUE.
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if now < endAtMs then return {'ERR_NOT_DUE', endAtMs, now} end

-- validate-before-write: stream last seq must match state seq, else the explicit
-- <seq>-0 XADD would error after the HINCRBY (dirty write; Lua has no rollback).
local last = redis.call('XREVRANGE', stream_key, '+', '-', 'COUNT', 1)
local lastStreamSeq = 0
if last[1] then lastStreamSeq = tonumber(string.match(last[1][1], '^(%d+)')) or 0 end
if lastStreamSeq ~= stateSeq then return {'ERR_INTERNAL', 'seq_stream_mismatch'} end

local seq = redis.call('HINCRBY', state_key, 'seq', 1)
if winner and winner ~= '' then
  redis.call('HSET', state_key, 'status', 'SOLD')
  local sold = {seq = seq, winnerId = winner, amountCents = priceStr, status = 'SOLD', serverTimeMs = now}
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
