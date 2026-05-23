-- freeze_rules.lua : DRAFT -> SCHEDULED, copies frozen rules into state Hash.
-- KEYS[1]=state   ARGV[1]=rulesJson
-- Ownership is enforced in Go (authoritative against MySQL); T1 lua is state-only.
local state_key = KEYS[1]
local status = redis.call('HGET', state_key, 'status')
-- absent state == not-yet-frozen (auction is DRAFT in MySQL); any non-DRAFT is illegal
if status and status ~= 'DRAFT' then return {'ERR_BAD_STATE', status} end

-- NB: do NOT touch the `seq` counter here. `seq` is the bid-event sequence
-- (Stream ID source); freeze/start are state transitions, not events, so the
-- first accepted bid must be seq=1 with no gap. seq is left unset until the
-- first place_bid HINCRBY (which initialises 0 -> 1).
local r = cjson.decode(ARGV[1])
redis.call('HMSET', state_key,
  'status', 'SCHEDULED',
  'startPriceCents', r.startPriceCents or 0,
  'currentPriceCents', r.startPriceCents or 0,
  'incrementCents', r.incrementCents or 0,
  'capPriceCents', r.capPriceCents or 0,
  'extendWindowSec', r.extendWindowSec or 0,
  'extendSec', r.extendSec or 0,
  'extendCount', 0,
  'winnerId', '',
  'seq', 0,
  'paused', 'false')
return {'OK_FROZEN'}
