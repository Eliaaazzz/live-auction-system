-- freeze_rules.lua : DRAFT -> SCHEDULED, copies frozen rules into state Hash.
-- KEYS[1]=state   ARGV[1]=rulesJson   ARGV[2]=sellerId
-- Ownership is enforced in Go (authoritative against MySQL); sellerId is also
-- copied into the state Hash so place_bid.lua can reject seller self-bids on the
-- hot path without a MySQL lookup.
local state_key = KEYS[1]
-- type-guard before any write (Lua has no rollback; RFC v2 boundary 2)
local kt = redis.call('TYPE', state_key).ok
if kt ~= 'none' and kt ~= 'hash' then return {'ERR_BAD_STATE', 'key_type'} end
local status = redis.call('HGET', state_key, 'status')
-- absent state == not-yet-frozen (auction is DRAFT in MySQL); any non-DRAFT is illegal
if status and status ~= 'DRAFT' then return {'ERR_BAD_STATE', status} end

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

-- NB: do NOT touch the `seq` counter here. `seq` is the bid-event sequence
-- (Stream ID source); freeze/start are state transitions, not events, so the
-- first accepted bid must be seq=1 with no gap. seq is left unset until the
-- first place_bid HINCRBY (which initialises 0 -> 1).
local r = cjson.decode(ARGV[1])
local mode = canonicalAuctionMode(r.auctionMode)
if mode ~= 'first_price' and mode ~= 'second_price' then
  mode = 'first_price'
end
local reserveCents = r.reserveCents
if reserveCents == nil then
  reserveCents = r.startPriceCents or 0
end
redis.call('HMSET', state_key,
  'status', 'SCHEDULED',
  'startPriceCents', r.startPriceCents or 0,
  'reserveCents', reserveCents,
  'currentPriceCents', r.startPriceCents or 0,
  'incrementCents', r.incrementCents or 0,
  'capPriceCents', r.capPriceCents or 0,
  'extendWindowSec', r.extendWindowSec or 0,
  'extendSec', r.extendSec or 0,
  'auctionMode', mode,
  'maxExtensions', r.maxExtensions or 0,
  'extendCount', 0,
  'winnerId', '',
  'sellerId', ARGV[2] or '',
  'seq', 0,
  'paused', 'false')
return {'OK_FROZEN'}
