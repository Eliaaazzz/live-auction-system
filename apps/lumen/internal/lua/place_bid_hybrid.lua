-- place_bid_hybrid.lua (issue #114): HYBRID_REVEAL bid path. Same ENGLISH
-- adjudication as place_bid.lua (price/winner/leaderboard/anti-snipe/cap-hit
-- semantics are identical and the close path is unchanged), but the
-- Stream/PubSub broadcast carries the PRIOR leader's amount + identity (the new
-- runner-up after this accept), while the new leader stays hidden in the state
-- Hash until close. The bidder's OWN ack — returned to Go and pushed only to
-- their socket — carries their true amount, exactly like the sealed modes.
--
-- Why this works at the gateway:
--   * roomState.priceCents is ratcheted from the broadcast amount. The
--     broadcast carries 2nd-highest, which is always <= the true currentPrice,
--     so cache <= actual: the V10k fast-reject stays SOUND (a bid <= cache is
--     also <= actual, ERR_TOO_LOW). It is just less effective for hybrid —
--     fewer rejections happen at the gateway; the slack lands in Lua. That is
--     acceptable since hybrid is a low-volume suspense mode, not the 10k path.
--   * endAtMs is broadcast as-is (no lie), so anti-snipe + countdown remain
--     accurate to every observer.
--
-- KEYS[1]=state KEYS[2]=leaderboard KEYS[3]=events(stream) KEYS[4]=dedupe:{userId}
-- ARGV[1]=userId ARGV[2]=clientBidId ARGV[3]=amountCents ARGV[4]=displayName ARGV[5]=pubChannel
--
-- Returns (mirror place_bid.lua):
--   {'OK_ACCEPTED', seq, ackJson}                  -- ackJson is the bidder's PRIVATE full ack
--   {'OK_EXTENDED', seq, ackJson, seq2, extJson}   -- anti-snipe; ext payload has no amount
--   {'OK_SOLD',     seq, ackJson, seq2, soldJson}  -- cap-hit reveals at the terminal moment
--   {'DUPLICATE', ackJson}
--   {'ERR_NOT_LIVE', status} {'ERR_AFTER_END', endAtMs, now} {'ERR_TOO_LOW', amount, required}
--   {'ERR_NOT_ALLOWED','seller_self_bid'} {'ERR_AUCTION_PAUSED'}
--   {'ERR_INTERNAL', 'key_type' | 'seq_stream_mismatch'}
local state_key, lb_key, stream_key, dedupe_key = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local userId, clientBidId, displayName, pub = ARGV[1], ARGV[2], ARGV[4], ARGV[5]
local amountStr = ARGV[3]
local amount = tonumber(amountStr)
local MAX_MONEY = 9007199254740991

-- SHARED prologue (mirrors place_bid.lua) ---------------------------------
local function bad_type(key, want)
  local t = redis.call('TYPE', key).ok
  return t ~= 'none' and t ~= want
end
if bad_type(state_key, 'hash') or bad_type(lb_key, 'zset')
   or bad_type(stream_key, 'stream') or bad_type(dedupe_key, 'hash') then
  return {'ERR_INTERNAL', 'key_type'}
end

local function ensure_dedupe_ttl()
  if redis.call('TTL', dedupe_key) < 0 then redis.call('EXPIRE', dedupe_key, 86400) end
end
local cached = redis.call('HGET', dedupe_key, clientBidId)
if cached then
  ensure_dedupe_ttl()
  return {'DUPLICATE', cached}
end

-- HMGET also reads winnerId + winnerDisplayName so we can broadcast the PRIOR
-- leader's identity. winnerDisplayName is a hybrid-only Hash field; English /
-- sealed never read it, and freeze leaves it empty.
local s = redis.call('HMGET', state_key,
  'status', 'endAtMs', 'paused', 'currentPriceCents', 'incrementCents',
  'capPriceCents', 'extendWindowSec', 'extendSec', 'extendCount', 'maxExtensions',
  'sellerId', 'seq', 'winnerId', 'winnerDisplayName')
local status              = s[1]
local endAtMs             = tonumber(s[2]) or 0
local paused              = s[3]
local currentPriceCents   = tonumber(s[4]) or 0
local incrementCents      = tonumber(s[5]) or 0
local capPriceCents       = tonumber(s[6]) or 0
local extendWindowSec     = tonumber(s[7]) or 0
local extendSec           = tonumber(s[8]) or 0
local curExtendCount      = tonumber(s[9]) or 0
local maxExtensions       = tonumber(s[10]) or 0
local sellerId            = s[11]
local stateSeq            = tonumber(s[12]) or 0
local priorWinnerId       = s[13] or ''
local priorWinnerName     = s[14] or ''
-- Saved BEFORE any mutation: these are what the redacted broadcast will carry.
local priorPriceStr       = s[4] or '0'

if paused == 'true' then return {'ERR_AUCTION_PAUSED'} end
if status ~= 'LIVE' then return {'ERR_NOT_LIVE', status or 'UNKNOWN'} end
if sellerId and sellerId ~= '' and userId == sellerId then
  return {'ERR_NOT_ALLOWED', 'seller_self_bid'}
end

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if now >= endAtMs then return {'ERR_AFTER_END', endAtMs, now} end

if not amount or amount <= 0 or amount > MAX_MONEY then return {'ERR_TOO_LOW', amount or 0, 0} end
local required = currentPriceCents + incrementCents
if capPriceCents > 0 and required > capPriceCents then required = capPriceCents end
if amount < required then return {'ERR_TOO_LOW', amount, required} end
if capPriceCents > 0 and amount > capPriceCents then return {'ERR_TOO_LOW', amount, required} end

local lastEntry = redis.call('XREVRANGE', stream_key, '+', '-', 'COUNT', 1)
local lastStreamSeq = 0
if lastEntry[1] then lastStreamSeq = tonumber(string.match(lastEntry[1][1], '^(%d+)')) or 0 end
if lastStreamSeq ~= stateSeq then return {'ERR_INTERNAL', 'seq_stream_mismatch'} end

-- 6. ACCEPT (same as English): seq + state HMSET + max leaderboard score.
local capHit = capPriceCents > 0 and amount >= capPriceCents
local extend = (not capHit) and extendWindowSec > 0 and extendSec > 0
  and (endAtMs - now) <= extendWindowSec * 1000
  and (maxExtensions <= 0 or curExtendCount < maxExtensions)

local seq = redis.call('HINCRBY', state_key, 'seq', 1)
redis.call('HMSET', state_key,
  'currentPriceCents', amountStr,
  'winnerId', userId,
  'winnerDisplayName', displayName)
local priorScore = redis.call('ZSCORE', lb_key, userId)
if not priorScore or tonumber(priorScore) < amount then
  redis.call('ZADD', lb_key, amountStr, userId)
end

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

-- 7. Build the TWO payloads:
--   streamBid -> goes to Stream/PubSub (the WHOLE room sees it). Redacted to
--     the prior leader unless cap-hit reveals at the terminal.
--   ackBid    -> returned to Go for the bidder's direct ack on their own
--     socket; carries the bidder's TRUE amount. Also cached in dedupe so a
--     retry replays the private ack (never the redacted broadcast).
local statusOut = (capHit and 'SOLD' or 'LIVE')
local ackBid = {seq = seq, userId = userId, displayName = displayName, amountCents = amountStr,
  endAtMs = newEndAtMs, status = statusOut, serverTimeMs = now}
local ackJson = cjson.encode(ackBid)

local streamBid
if capHit then
  -- Cap-hit is terminal — reveal the true winner + price (same as English).
  streamBid = ackBid
else
  -- Hybrid redaction: the room sees the prior leader as the "runner-up". For
  -- the very first bid there is no prior leader, so the broadcast shows the
  -- reserve (startPrice == priorPriceStr) with an empty identity.
  streamBid = {seq = seq, userId = priorWinnerId, displayName = priorWinnerName,
    amountCents = priorPriceStr, endAtMs = newEndAtMs, status = statusOut, serverTimeMs = now}
end
local streamJson = cjson.encode(streamBid)

redis.call('XADD', stream_key, seq .. '-0', 'type', 'BID_ACCEPTED', 'seq', seq, 'payload', streamJson)
redis.call('HSET', dedupe_key, clientBidId, ackJson)
redis.call('EXPIRE', dedupe_key, 86400)
redis.call('PUBLISH', pub, cjson.encode({type = 'BID_ACCEPTED', seq = seq, data = streamBid}))

-- 8. Secondary extension / terminal event (own seq each, contiguous <seq>-0 XADD).
if extend then
  local seq2 = redis.call('HINCRBY', state_key, 'seq', 1)
  local ext = {seq = seq2, endAtMs = newEndAtMs, extendCount = extendCount, serverTimeMs = now}
  local extJson = cjson.encode(ext)
  redis.call('XADD', stream_key, seq2 .. '-0', 'type', 'AUCTION_EXTENDED', 'seq', seq2, 'payload', extJson)
  redis.call('PUBLISH', pub, cjson.encode({type = 'AUCTION_EXTENDED', seq = seq2, data = ext}))
  return {'OK_EXTENDED', seq, ackJson, seq2, extJson}
end
if capHit then
  local seq2 = redis.call('HINCRBY', state_key, 'seq', 1)
  local sold = {seq = seq2, winnerId = userId, amountCents = amountStr, status = 'SOLD', serverTimeMs = now}
  local soldJson = cjson.encode(sold)
  redis.call('XADD', stream_key, seq2 .. '-0', 'type', 'AUCTION_SOLD', 'seq', seq2, 'payload', soldJson)
  redis.call('PUBLISH', pub, cjson.encode({type = 'AUCTION_SOLD', seq = seq2, data = sold}))
  return {'OK_SOLD', seq, ackJson, seq2, soldJson}
end
return {'OK_ACCEPTED', seq, ackJson}
