-- KEYS[1] = auction:{aid}:state          (Hash)
-- KEYS[2] = auction:{aid}:ranking        (ZSet)
-- KEYS[3] = auction:{aid}:events         (Stream)
-- KEYS[4] = auction:{aid}:dedupe:{uid}   (Set, 24h TTL)
-- ARGV    = { aid, uid, client_bid_id, amount_cents, now_ms }

local aid           = ARGV[1]
local uid           = ARGV[2]
local client_bid_id = ARGV[3]
local amount        = tonumber(ARGV[4])
local now_ms        = tonumber(ARGV[5])

if redis.call('SISMEMBER', KEYS[4], client_bid_id) == 1 then
  return { 'err', 'duplicate_bid' }
end

local state = redis.call('HGET', KEYS[1], 'state')
if state ~= 'Bidding' and state ~= 'Cooling' then
  return { 'err', 'not_bidding' }
end

local ends_at = tonumber(redis.call('HGET', KEYS[1], 'ends_at_ms') or '0')
if now_ms > ends_at then
  return { 'err', 'after_hammer' }
end

local cur  = tonumber(redis.call('HGET', KEYS[1], 'max_amount_cents') or '0')
local step = tonumber(redis.call('HGET', KEYS[1], 'step_cents') or '1')
if amount < cur + step then
  return { 'err', 'too_low', tostring(cur), tostring(step) }
end

local seq  = redis.call('HINCRBY', KEYS[1], 'seq', 1)
local anti = tonumber(redis.call('HGET', KEYS[1], 'anti_snipe_ms') or '0')
local extend_to = ends_at
if anti > 0 and (ends_at - now_ms) <= anti then
  extend_to = now_ms + anti
end

redis.call('HSET', KEYS[1],
  'max_amount_cents', amount,
  'max_user_id',      uid,
  'last_seq',         seq,
  'ends_at_ms',       extend_to,
  'state',            'Bidding')

redis.call('ZADD', KEYS[2], amount, uid)
redis.call('SADD', KEYS[4], client_bid_id)
redis.call('EXPIRE', KEYS[4], 86400)

local payload = cjson.encode({
  type = 'bid.accepted',
  aid  = aid,
  uid  = uid,
  amount_cents = amount,
  seq = seq,
  ts_ms = now_ms,
  ends_at_ms = extend_to,
  client_bid_id = client_bid_id,
})

redis.call('XADD', KEYS[3], 'MAXLEN', '~', '10000', '*',
  'seq', seq,
  'type', 'bid.accepted',
  'payload', payload)

redis.call('PUBLISH', 'auction:' .. aid .. ':pub', payload)

return { 'ok', tostring(seq), tostring(extend_to) }
