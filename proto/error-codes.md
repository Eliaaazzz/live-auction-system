# Error / Result Codes

Two namespaces (per V9 §6). Lua returns **internal** codes to the Go dispatcher; the dispatcher maps them to **wire** types/codes sent over WS. This file is the single source; `place_bid.lua` etc. mirror it.

## Lua-internal → wire mapping

| Lua-internal | Returned by | Meaning | Wire |
|---|---|---|---|
| `OK_ACCEPTED` | place_bid | bid accepted, price updated | `BID_ACCEPTED` |
| `OK_EXTENDED` | place_bid (anti-snipe, T2+) | accepted + endAtMs extended | `BID_ACCEPTED` (+ `AUCTION_EXTENDED`) |
| `OK_SOLD` | place_bid (cap) / close_auction | terminal SOLD | `AUCTION_SOLD` |
| `OK_NO_BID` | close_auction (T3) | terminal, no bids | `AUCTION_NO_BID` |
| `OK_CANCELLED` | cancel_auction (T3) | terminal cancel | `AUCTION_CANCELLED` |
| `OK_FROZEN` | freeze_rules | DRAFT → SCHEDULED | `AUCTION_FROZEN` (server emit) |
| `OK_LIVE` | start_auction | SCHEDULED → LIVE | `AUCTION_STARTED` (server emit) |
| `DUPLICATE` | place_bid | clientBidId seen; payload = cached ack | replay cached ack (**not** an error) |
| `ERR_NOT_LIVE` | place_bid | state ≠ LIVE (pre-live or terminal) | `BID_REJECTED {code: ERR_NOT_LIVE}` |
| `ERR_AFTER_END` | place_bid | `now >= endAtMs` (lost race to close) | `BID_REJECTED {code: ERR_AFTER_END}` |
| `ERR_TOO_LOW` | place_bid | `amount < current+increment` **or** `amount > cap` | `BID_REJECTED {code: ERR_TOO_LOW}` |
| `ERR_AUCTION_PAUSED` | place_bid | Redis-back recovery in progress | `BID_REJECTED {code: ERR_AUCTION_PAUSED}` |
| `ERR_NOT_DUE` | close_auction (T3) | called before expiry | engine retries (not surfaced) |
| `ERR_ALREADY_TERMINAL` | close/cancel (T3) | already terminal | engine no-op (not surfaced) |
| `ERR_NOT_ALLOWED` | cancel_auction (T3) | caller not owner/admin | `OPERATION_REJECTED {code: ERR_NOT_ALLOWED}` |
| `ERR_BAD_STATE` | start_auction / freeze_rules | wrong source state | `OPERATION_REJECTED {code: ERR_BAD_STATE}` |
| `ERR_INTERNAL` | (Go dispatcher only) | transport/script failure (Redis unreachable, NOSCRIPT, …) — distinct from the business `ERR_AUCTION_PAUSED` | `BID_REJECTED {code: ERR_INTERNAL}` |

**Single `ERR_TOO_LOW`** (fariZzzz #14 challenge #2): increment-fail and cap-overshoot are both "amount invalid"; cap-hit success is signalled by `OK_SOLD`, not a rejection. No `ERR_INCREMENT` / `ERR_OVER_CAP`.

## T1 subset

T1 uses: `OK_FROZEN`, `OK_LIVE`, `OK_ACCEPTED`, `ERR_NOT_LIVE`, `ERR_BAD_STATE`. The rest are authored here (frozen contract) and exercised by their gating T-steps.
