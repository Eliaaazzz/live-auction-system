-- cancel_auction.lua (T3): seller/admin cancels a non-terminal auction
-- (SCHEDULED or LIVE; DRAFT has no Redis state and is handled in Go) -> CANCELLED.
-- KEYS[1]=state  KEYS[2]=events(stream)  ARGV[1]=callerId  ARGV[2]=pubChannel
--
-- Returns (proto/error-codes.md):
--   {'OK_CANCELLED', seq, cancelJson}     -- terminal CANCELLED, AUCTION_CANCELLED event
--   {'ERR_NOT_ALLOWED', 'not_owner'}      -- caller is not the seller
--   {'ERR_ALREADY_TERMINAL', status}      -- already terminal / no Redis state
--   {'ERR_INTERNAL', 'key_type' | 'seq_stream_mismatch'}
local state_key, stream_key = KEYS[1], KEYS[2]
local callerId, pub = ARGV[1], ARGV[2]

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

-- no Redis state (unfrozen DRAFT) or already terminal → nothing to cancel here.
local function is_terminal(st)
  return st == 'SOLD' or st == 'NO_BID' or st == 'CANCELLED' or st == 'ORDER_CREATED'
end
if not status or status == false or is_terminal(status) then
  return {'ERR_ALREADY_TERMINAL', status or 'UNKNOWN'}
end
-- ownership (defensive second gate; Go also verifies against MySQL before calling).
-- Fail CLOSED: a frozen auction always has sellerId (freeze_rules copies it in), so a
-- missing/empty sellerId means corrupt state — reject rather than let anyone cancel a
-- terminal-writing op. (place_bid's seller-self-bid check fails open because there the
-- safe default is "accept the bid"; here the safe default is "deny the cancel".)
if not sellerId or sellerId == '' or callerId ~= sellerId then
  return {'ERR_NOT_ALLOWED', 'not_owner'}
end

-- validate-before-write: stream/state seq lockstep (no dirty write on XADD conflict).
local last = redis.call('XREVRANGE', stream_key, '+', '-', 'COUNT', 1)
local lastStreamSeq = 0
if last[1] then lastStreamSeq = tonumber(string.match(last[1][1], '^(%d+)')) or 0 end
if lastStreamSeq ~= stateSeq then return {'ERR_INTERNAL', 'seq_stream_mismatch'} end

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local seq = redis.call('HINCRBY', state_key, 'seq', 1)
redis.call('HSET', state_key, 'status', 'CANCELLED')
local c = {seq = seq, status = 'CANCELLED', serverTimeMs = now}
local cJson = cjson.encode(c)
redis.call('XADD', stream_key, seq .. '-0', 'type', 'AUCTION_CANCELLED', 'seq', seq, 'payload', cJson)
redis.call('PUBLISH', pub, cjson.encode({type = 'AUCTION_CANCELLED', seq = seq, data = c}))
return {'OK_CANCELLED', seq, cJson}
