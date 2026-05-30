// Package lua embeds the Redis Lua scripts so they ship inside the binary and
// are loaded via SCRIPT LOAD at startup. Redis Lua is the only writer of hot
// keys. T1 ships freeze/start/place_bid; T3 adds close/cancel.
package lua

import _ "embed"

//go:embed place_bid.lua
var PlaceBid string

// PlaceBidSealed / CloseSealed implement the sealed modes (issue #114):
// SEALED_FIRST and VICKREY. Bids are hidden during LIVE; reveal + winner/price
// at close. The bid script is shared (price rule is chosen at close).
//
//go:embed place_bid_sealed.lua
var PlaceBidSealed string

//go:embed close_auction_sealed.lua
var CloseSealed string

//go:embed freeze_rules.lua
var FreezeRules string

//go:embed start_auction.lua
var StartAuction string

//go:embed close_auction.lua
var CloseAuction string

//go:embed cancel_auction.lua
var CancelAuction string
