-- close_auction_allpay.lua (issue #114): Timer-triggered reveal + hammer for
-- ALL_PAY (the Dollar-Auction / chaos mode). Winner pays their own bid AND the
-- runner-up forfeits their bid — both settled in VIRTUAL COINS only (the
-- persistence worker is hard-gated to never create an `orders` row for an
-- ALL_PAY auction, so no losing buyer is ever charged real money).
--
-- Bid storage is identical to SEALED_FIRST/VICKREY (sealed ZSET + names hash),
-- so place_bid_sealed.lua is shared. Only the close logic differs: this script
-- additionally emits ALL_PAY_FORFEIT for the runner-up; AUCTION_SOLD is still
-- emitted at the winner's own price, but persistence will route it to
-- coin_ledger (not orders) when the auction's mode is ALL_PAY.
--
-- KEYS[1]=state KEYS[2]=sealedZ KEYS[3]=sealedNames KEYS[4]=leaderboard KEYS[5]=stream
-- ARGV[1]=pubChannel
--
-- Returns:
--   {'OK_SOLD', seq, soldJson}        -- reveal + (winner WIN) + (runner-up FORFEIT)
--   {'OK_NO_BID', seq, noBidJson}     -- no sealed bids
--   {'ERR_NOT_DUE', endAtMs, now}     -- not yet expired; engine retries
--   {'ERR_ALREADY_TERMINAL', status}  -- not LIVE; engine no-ops
--   {'ERR_INTERNAL', 'key_type' | 'seq_stream_mismatch'}
local state_key, sz_key, sn_key, lb_key, stream_key = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5]
local pub = ARGV[1]

local function bad_type(key, want)
  local t = redis.call('TYPE', key).ok
  return t ~= 'none' and t ~= want
end
-- Mirror the type-guard pattern from close_auction_sealed.lua: cover all keys
-- the close script touches (#114 adversarial test pinned sz_key as the gap).
if bad_type(state_key, 'hash') or bad_type(stream_key, 'stream')
   or bad_type(sz_key, 'zset') or bad_type(sn_key, 'hash')
   or bad_type(lb_key, 'zset') then
  return {'ERR_INTERNAL', 'key_type'}
end

local s = redis.call('HMGET', state_key, 'status', 'endAtMs', 'seq')
local status   = s[1]
local endAtMs  = tonumber(s[2]) or 0
local stateSeq = tonumber(s[3]) or 0
if status ~= 'LIVE' then return {'ERR_ALREADY_TERMINAL', status or 'UNKNOWN'} end

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if now < endAtMs then return {'ERR_NOT_DUE', endAtMs, now} end

local last = redis.call('XREVRANGE', stream_key, '+', '-', 'COUNT', 1)
local lastStreamSeq = 0
if last[1] then lastStreamSeq = tonumber(string.match(last[1][1], '^(%d+)')) or 0 end
if lastStreamSeq ~= stateSeq then return {'ERR_INTERNAL', 'seq_stream_mismatch'} end

local function canon(x) return string.format('%.0f', tonumber(x)) end

local z = redis.call('ZREVRANGE', sz_key, 0, -1, 'WITHSCORES')
if #z == 0 then
  local seq = redis.call('HINCRBY', state_key, 'seq', 1)
  redis.call('HSET', state_key, 'status', 'NO_BID')
  local nb = {seq = seq, status = 'NO_BID', serverTimeMs = now}
  local nbJson = cjson.encode(nb)
  redis.call('XADD', stream_key, seq .. '-0', 'type', 'AUCTION_NO_BID', 'seq', seq, 'payload', nbJson)
  redis.call('PUBLISH', pub, cjson.encode({type = 'AUCTION_NO_BID', seq = seq, data = nb}))
  return {'OK_NO_BID', seq, nbJson}
end

local winnerId = z[1]
local winnerAmount = canon(z[2])

-- public revealed list + populate the public leaderboard for post-close reads.
local bids = {}
for i = 1, #z, 2 do
  local uid = z[i]
  local amt = canon(z[i + 1])
  local nm = redis.call('HGET', sn_key, uid) or ''
  bids[#bids + 1] = {userId = uid, displayName = nm, amountCents = amt}
  redis.call('ZADD', lb_key, amt, uid)
end

-- ALL_PAY: winner pays their own bid; runner-up (if any) also pays. The state
-- Hash currentPriceCents reflects the WINNER's bid for downstream reads.
redis.call('HSET', state_key, 'winnerId', winnerId, 'currentPriceCents', winnerAmount, 'status', 'SOLD')

-- AUCTION_REVEALED (own seq): the sealed bids become public.
local rseq = redis.call('HINCRBY', state_key, 'seq', 1)
local reveal = {seq = rseq, bids = bids, winnerId = winnerId, amountCents = winnerAmount, serverTimeMs = now}
local revealJson = cjson.encode(reveal)
redis.call('XADD', stream_key, rseq .. '-0', 'type', 'AUCTION_REVEALED', 'seq', rseq, 'payload', revealJson)
redis.call('PUBLISH', pub, cjson.encode({type = 'AUCTION_REVEALED', seq = rseq, data = reveal}))

-- ALL_PAY_FORFEIT (own seq) — only when a runner-up exists. Settlement is
-- VIRTUAL COINS ONLY; persistence projects this to coin_ledger.
if #z >= 4 then
  local runnerUpId = z[3]
  local runnerUpAmt = canon(z[4])
  local fseq = redis.call('HINCRBY', state_key, 'seq', 1)
  local forfeit = {seq = fseq, userId = runnerUpId, coinsForfeit = runnerUpAmt, serverTimeMs = now}
  local forfeitJson = cjson.encode(forfeit)
  redis.call('XADD', stream_key, fseq .. '-0', 'type', 'ALL_PAY_FORFEIT', 'seq', fseq, 'payload', forfeitJson)
  redis.call('PUBLISH', pub, cjson.encode({type = 'ALL_PAY_FORFEIT', seq = fseq, data = forfeit}))
end

-- AUCTION_SOLD (own seq): persistence's projectSold path checks the auction's
-- mode and routes this to coin_ledger (NOT orders) for ALL_PAY — the hard
-- money-safety gate.
local sseq = redis.call('HINCRBY', state_key, 'seq', 1)
local sold = {seq = sseq, winnerId = winnerId, amountCents = winnerAmount, status = 'SOLD', serverTimeMs = now}
local soldJson = cjson.encode(sold)
redis.call('XADD', stream_key, sseq .. '-0', 'type', 'AUCTION_SOLD', 'seq', sseq, 'payload', soldJson)
redis.call('PUBLISH', pub, cjson.encode({type = 'AUCTION_SOLD', seq = sseq, data = sold}))
-- Memory hygiene (PR #117 review): the private sealed ZSET + names hash are
-- dead after reveal — coin_ledger has all the settlement data the ALL_PAY
-- evidence trail needs.
redis.call('DEL', sz_key, sn_key)
return {'OK_SOLD', sseq, soldJson}
