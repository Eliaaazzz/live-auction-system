-- close_auction.lua (T3): Timer Worker-triggered hammer. Closes a LIVE auction
-- as SOLD (had a winning bid) or NO_BID (none). Does NOT depend on the next bid.
-- KEYS[1]=state  KEYS[2]=events(stream)  KEYS[3]=leaderboard  ARGV[1]=pubChannel
--
-- Returns (proto/error-codes.md):
--   {'OK_SOLD', seq, soldJson}            -- terminal SOLD, AUCTION_SOLD event
--   {'OK_NO_BID', seq, noBidJson}         -- terminal NO_BID, AUCTION_NO_BID event
--   {'ERR_NOT_DUE', endAtMs, now}         -- not yet expired (anti-snipe may have moved it); engine retries
--   {'ERR_ALREADY_TERMINAL', status}      -- not LIVE (already closed / cap-hit SOLD); engine no-ops
--   {'ERR_INTERNAL', 'key_type' | 'seq_stream_mismatch'}
local state_key, stream_key, lb_key = KEYS[1], KEYS[2], KEYS[3]
local pub = ARGV[1]

local function bad_type(key, want)
  local t = redis.call('TYPE', key).ok
  return t ~= 'none' and t ~= want
end

local function canonicalAuctionMode(mode)
  if mode == nil then return 'first_price' end
  mode = string.lower(mode)
  mode = string.gsub(mode, '^%s*(.-)%s*$', '%1')
  mode = string.gsub(mode, '%s', '_')
  mode = string.gsub(mode, '-', '_')
  if mode == 'first' or mode == 'first_price' or mode == 'firstprice' then return 'first_price' end
  if mode == 'second' or mode == 'second_price' or mode == 'secondprice' or mode == 'vickrey' or mode == 'auction2' or mode == '2' then
    return 'second_price'
  end
  return mode
end

if bad_type(state_key, 'hash') or bad_type(stream_key, 'stream') or bad_type(lb_key, 'zset') then
  return {'ERR_INTERNAL', 'key_type'}
end

local s = redis.call('HMGET', state_key, 'status', 'endAtMs', 'currentPriceCents', 'winnerId', 'seq',
  'auctionMode', 'startPriceCents', 'reserveCents')
local status   = s[1]
local endAtMs  = tonumber(s[2]) or 0
local priceStr = s[3] or '0'
local winner   = s[4]
local stateSeq = tonumber(s[5]) or 0
local auctionMode = canonicalAuctionMode(s[6])
local startPriceCents = tonumber(s[7]) or 0
local reserveCents = tonumber(s[8]) or 0
if auctionMode ~= 'first_price' and auctionMode ~= 'second_price' then
  auctionMode = 'first_price'
end

local function soldAmountForMode()
  if auctionMode ~= 'second_price' then
    return priceStr
  end
  local reserveCentsForMode = reserveCents
  if reserveCentsForMode <= 0 then
    reserveCentsForMode = startPriceCents
  end
  local top2 = redis.call('ZREVRANGE', lb_key, 1, 1, 'WITHSCORES')
  if top2[2] == nil then
    return tostring(reserveCentsForMode)
  end
  local second = tonumber(top2[2]) or 0
  if second > reserveCentsForMode then
    return string.format('%.0f', second)
  end
  return tostring(reserveCentsForMode)
end

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
  local sold = {seq = seq, winnerId = winner, amountCents = soldAmountForMode(), status = 'SOLD', serverTimeMs = now}
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
