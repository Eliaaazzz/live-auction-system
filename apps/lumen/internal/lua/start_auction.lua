-- start_auction.lua : SCHEDULED -> LIVE, sets endAtMs from Redis TIME.
-- KEYS[1]=state   ARGV[1]=durationMs
-- Ownership enforced in Go; T1 lua is state-only.
local state_key = KEYS[1]
-- type-guard before any write (Lua has no rollback; RFC v2 boundary 2)
local kt = redis.call('TYPE', state_key).ok
if kt ~= 'none' and kt ~= 'hash' then return {'ERR_BAD_STATE', 'key_type'} end
local status = redis.call('HGET', state_key, 'status')
if status ~= 'SCHEDULED' then return {'ERR_BAD_STATE', status or 'UNKNOWN'} end

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local endAtMs = now + tonumber(ARGV[1])
-- do NOT touch `seq` (bid-event sequence); see freeze_rules.lua.
redis.call('HMSET', state_key, 'status', 'LIVE', 'endAtMs', endAtMs)
return {'OK_LIVE', endAtMs}
