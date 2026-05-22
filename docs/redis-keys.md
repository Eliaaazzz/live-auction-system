# Redis Keys And Lua Contracts

Source basis: RFC v1 §6 plus Plan V8 §0.3 hard boundaries.

All auction-local keys must use the same cluster hash tag, written as `{<aid>}`, so multi-key Lua stays in one Redis slot.

```text
auction:{<aid>}:state
  Hash
  status, currentPriceCents, winnerId, endAtMs, seq,
  startPriceCents, incrementCents, capPriceCents,
  extendWindowSec, extendSec, extendCount

auction:{<aid>}:leaderboard
  ZSET
  member = userId
  score = user's accepted max amount cents

auction:{<aid>}:dedupe:{userId}
  Hash
  clientBidId -> accepted/rejected result json
  TTL: 24h

auction:{<aid>}:events
  Stream
  durable ordered auction event log
  Stream ID = <seq>-0

auction:{<aid>}:pub
  Pub/Sub channel
  wakeup and room fanout only

auction:active
  ZSET
  member = auctionId
  score = endAtMs

room:{<aid>}:online
  Set / Hash
  online users or connection markers
```

Lua has no rollback. Scripts must type-guard and validate before writes. Business code must not directly mutate these hot keys.

P0 Lua scripts are `start_auction.lua`, `place_bid.lua`, `close_auction.lua`, and `cancel_auction.lua`.

## `place_bid.lua`

Signature: `place_bid.lua(auctionId, userId, clientBidId, amountCents, requestId)`.

Return codes:

```text
OK_ACCEPTED(seq, amount, endAtMs, extended=false)
OK_ACCEPTED(seq, amount, endAtMs, extended=true)
OK_SOLD(seq, finalAmount, winnerId)
DUPLICATE(previousResult)
ERR_NOT_LIVE
ERR_TOO_LOW(currentPrice, increment)
ERR_AFTER_END
ERR_RATE_LIMITED
ERR_AUCTION_PAUSED
```

Rules: Redis TIME is authoritative; boundary is `>=`; dedupe is a Hash and retry returns the original ack; amount must satisfy fixed increment except cap boundary; accepted amount is `min(amountCents, capPriceCents)`; success increments the single `seq`, writes Stream, then publishes.

## `close_auction.lua`

Signature: `close_auction.lua(auctionId)`.

Return codes:

```text
OK_SOLD(seq, winnerId, finalAmount)
OK_NO_BID(seq)
ERR_NOT_DUE(msRemaining)
ERR_ALREADY_TERMINAL(status)
```

## `cancel_auction.lua`

Signature: `cancel_auction.lua(auctionId, sellerId, reason)`.

Return codes:

```text
OK_CANCELLED(seq)
ERR_ALREADY_TERMINAL(status)
ERR_NOT_ALLOWED
```

AOF everysec is the persistence stance. If Redis is unavailable, auctions pause with `ERR_AUCTION_PAUSED`; the system must not silently accept bids through MySQL.
