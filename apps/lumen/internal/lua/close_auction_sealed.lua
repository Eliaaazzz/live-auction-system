-- close_auction_sealed.lua (issue #114): Timer-triggered reveal + hammer for the
-- sealed modes. Reveal happens ATOMICALLY at close — no separate REVEAL state.
-- Winner = highest sealed bid. Final price depends on the mode:
--   priceMode == 'FIRST'  -> winner pays their own bid (SEALED_FIRST)
--   priceMode == 'SECOND' -> winner pays the 2nd-highest bid (VICKREY); a lone
--                            bidder pays the reserve (startPriceCents).
--
-- Emits AUCTION_REVEALED (the now-public sorted bids) THEN AUCTION_SOLD (reusing
-- the normal terminal event so the persistence/order/evidence spine is
-- unchanged), each consuming its own seq + explicit <seq>-0 XADD to preserve
-- contiguity. Also populates the public leaderboard ZSET so post-close
-- GET /leaderboard works normally.
--
-- KEYS[1]=state KEYS[2]=sealedZ KEYS[3]=sealedNames KEYS[4]=leaderboard KEYS[5]=stream
-- ARGV[1]=pubChannel ARGV[2]=priceMode ('FIRST'|'SECOND')
--
-- Returns:
--   {'OK_SOLD', seq, soldJson}        -- reveal + terminal SOLD
--   {'OK_NO_BID', seq, noBidJson}     -- no sealed bids
--   {'ERR_NOT_DUE', endAtMs, now}     -- not yet expired; engine retries
--   {'ERR_ALREADY_TERMINAL', status}  -- not LIVE; engine no-ops
--   {'ERR_INTERNAL', 'key_type' | 'seq_stream_mismatch'}
local state_key, sz_key, sn_key, lb_key, stream_key = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5]
local pub = ARGV[1]
local priceMode = ARGV[2] or 'FIRST'

local function bad_type(key, want)
  local t = redis.call('TYPE', key).ok
  return t ~= 'none' and t ~= want
end
if bad_type(state_key, 'hash') or bad_type(stream_key, 'stream') then
  return {'ERR_INTERNAL', 'key_type'}
end

local s = redis.call('HMGET', state_key, 'status', 'endAtMs', 'seq', 'startPriceCents')
local status          = s[1]
local endAtMs         = tonumber(s[2]) or 0
local stateSeq        = tonumber(s[3]) or 0
local startPriceCents = tonumber(s[4]) or 0
if status ~= 'LIVE' then return {'ERR_ALREADY_TERMINAL', status or 'UNKNOWN'} end

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if now < endAtMs then return {'ERR_NOT_DUE', endAtMs, now} end

local last = redis.call('XREVRANGE', stream_key, '+', '-', 'COUNT', 1)
local lastStreamSeq = 0
if last[1] then lastStreamSeq = tonumber(string.match(last[1][1], '^(%d+)')) or 0 end
if lastStreamSeq ~= stateSeq then return {'ERR_INTERNAL', 'seq_stream_mismatch'} end

-- canon formats an integer-valued ZSET score string as a plain integer string
-- (avoids any scientific-notation formatting; amounts are <= 2^53-1).
local function canon(scoreStr) return string.format('%.0f', tonumber(scoreStr)) end

-- read all sealed bids high -> low, WITHSCORES (flat array: member, score, ...).
local z = redis.call('ZREVRANGE', sz_key, 0, -1, 'WITHSCORES')
if #z == 0 then
  -- no sealed bids -> NO_BID (mirrors close_auction.lua).
  local seq = redis.call('HINCRBY', state_key, 'seq', 1)
  redis.call('HSET', state_key, 'status', 'NO_BID')
  local nb = {seq = seq, status = 'NO_BID', serverTimeMs = now}
  local nbJson = cjson.encode(nb)
  redis.call('XADD', stream_key, seq .. '-0', 'type', 'AUCTION_NO_BID', 'seq', seq, 'payload', nbJson)
  redis.call('PUBLISH', pub, cjson.encode({type = 'AUCTION_NO_BID', seq = seq, data = nb}))
  return {'OK_NO_BID', seq, nbJson}
end

local winnerId = z[1]
local topAmount = canon(z[2])

-- build the public revealed list + populate the public leaderboard ZSET.
local bids = {}
for i = 1, #z, 2 do
  local uid = z[i]
  local amt = canon(z[i + 1])
  local nm = redis.call('HGET', sn_key, uid) or ''
  bids[#bids + 1] = {userId = uid, displayName = nm, amountCents = amt}
  redis.call('ZADD', lb_key, amt, uid)
end

-- final price: first-price = own bid; Vickrey = 2nd-highest (lone bidder = reserve).
local finalPrice = topAmount
if priceMode == 'SECOND' then
  if #z >= 4 then
    finalPrice = canon(z[4])
  else
    finalPrice = string.format('%.0f', startPriceCents)
  end
end

redis.call('HSET', state_key, 'winnerId', winnerId, 'currentPriceCents', finalPrice, 'status', 'SOLD')

-- AUCTION_REVEALED (own seq): the sealed bids become public.
local rseq = redis.call('HINCRBY', state_key, 'seq', 1)
local reveal = {seq = rseq, bids = bids, winnerId = winnerId, amountCents = finalPrice, serverTimeMs = now}
local revealJson = cjson.encode(reveal)
redis.call('XADD', stream_key, rseq .. '-0', 'type', 'AUCTION_REVEALED', 'seq', rseq, 'payload', revealJson)
redis.call('PUBLISH', pub, cjson.encode({type = 'AUCTION_REVEALED', seq = rseq, data = reveal}))

-- AUCTION_SOLD (own seq): reuse the normal terminal event -> persistence projects
-- the order at finalPrice via the unchanged projectSold path.
local sseq = redis.call('HINCRBY', state_key, 'seq', 1)
local sold = {seq = sseq, winnerId = winnerId, amountCents = finalPrice, status = 'SOLD', serverTimeMs = now}
local soldJson = cjson.encode(sold)
redis.call('XADD', stream_key, sseq .. '-0', 'type', 'AUCTION_SOLD', 'seq', sseq, 'payload', soldJson)
redis.call('PUBLISH', pub, cjson.encode({type = 'AUCTION_SOLD', seq = sseq, data = sold}))

-- Memory hygiene (PR #117 review): the private sealed ZSET + names hash are
-- only used to pick the winner at close. The amounts are now public via the
-- AUCTION_REVEALED event + the (now populated) public leaderboard ZSET, so the
-- private keys are dead weight on a finished auction. DEL is safe at the very
-- end of the script — anything that could read them has already happened.
redis.call('DEL', sz_key, sn_key)
return {'OK_SOLD', sseq, soldJson}
