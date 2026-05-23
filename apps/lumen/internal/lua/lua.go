// Package lua embeds the Redis Lua scripts so they ship inside the binary and
// are loaded via SCRIPT LOAD at startup. Redis Lua is the only writer of hot
// keys. T1 ships freeze/start/place_bid; close/cancel land in T3.
package lua

import _ "embed"

//go:embed place_bid.lua
var PlaceBid string

//go:embed freeze_rules.lua
var FreezeRules string

//go:embed start_auction.lua
var StartAuction string
