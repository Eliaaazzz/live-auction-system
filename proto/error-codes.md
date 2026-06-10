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
| `ERR_RATE_LIMITED` | WS gateway | too many `BID_PLACE` from one connection | `BID_REJECTED {code: ERR_RATE_LIMITED}` |
| `ERR_NOT_DUE` | close_auction (T3) | called before expiry | engine retries (not surfaced) |
| `ERR_ALREADY_TERMINAL` | close/cancel (T3) | already terminal | engine no-op (not surfaced) |
| `ERR_NOT_ALLOWED` | place_bid (seller self-bid, T2) / cancel_auction (T3) | seller bidding own auction, or caller not owner/admin | `BID_REJECTED {code: ERR_NOT_ALLOWED}` (bid) / `OPERATION_REJECTED {code: ERR_NOT_ALLOWED}` (cancel) |
| `ERR_BAD_STATE` | start_auction / freeze_rules | wrong source state | `OPERATION_REJECTED {code: ERR_BAD_STATE}` |
| `ERR_INTERNAL` | place_bid type-guard / preflight / Go dispatcher | wrong-typed key (`'key_type'`), stream/state seq desync (`'seq_stream_mismatch'`), or NOSCRIPT — distinct from the business `ERR_AUCTION_PAUSED` | `BID_REJECTED {code: ERR_INTERNAL}` |
| `ERR_FACTS_NOT_CONFIRMED` | REST `freeze` handler | seller has not confirmed the AI facts draft | `409 {code: ERR_FACTS_NOT_CONFIRMED}` |
| `ERR_BAD_INPUT` | WS gateway | malformed `BID_PLACE` (missing clientBidId/amount) | `BID_REJECTED {code: ERR_BAD_INPUT}` |

**Redis-unavailable vs internal**: an EVALSHA transport error is mapped to the frozen-boundary code `ERR_AUCTION_PAUSED` (Redis effectively down); only NOSCRIPT and Lua-returned `ERR_INTERNAL` map to `ERR_INTERNAL`.

**Single `ERR_TOO_LOW`** (fariZzzz #14 challenge #2): increment-fail and cap-overshoot are both "amount invalid"; cap-hit success is signalled by `OK_SOLD`, not a rejection. No `ERR_INCREMENT` / `ERR_OVER_CAP`.

## T1 / T2 subset

T1 uses: `OK_FROZEN`, `OK_LIVE`, `OK_ACCEPTED`, `DUPLICATE`, `ERR_NOT_LIVE`, `ERR_AFTER_END`, `ERR_TOO_LOW`, `ERR_AUCTION_PAUSED`, `ERR_BAD_STATE`, `ERR_INTERNAL`, `ERR_FACTS_NOT_CONFIRMED`, `ERR_BAD_INPUT`.

**T2 adds** `OK_EXTENDED` (anti-snipe), `OK_SOLD` (cap-hit / buy-now), and `ERR_RATE_LIMITED` (per-connection WS bid burst control) to `place_bid`. Both still ack the bid as `BID_ACCEPTED` on the originating socket; the extension/terminal event reaches the room as `AUCTION_EXTENDED` / `AUCTION_SOLD` (see `ws-envelope.md`). `ERR_BAD_INPUT` now also covers a non-numeric / non-positive / `> MaxMoneyCents` (2^53-1) `amountCents` (validated + canonicalized at the gateway before the Lua call); below-required / over-cap / over-MaxMoneyCents remain `ERR_TOO_LOW` (Lua defensive boundary). `place_bid` also surfaces `ERR_NOT_ALLOWED` (seller self-bid → `BID_REJECTED`) and `ERR_INTERNAL{'seq_stream_mismatch'}` (stream/state desync preflight).

**T3 implements** `OK_NO_BID` / `OK_CANCELLED` (close_auction / cancel_auction → `AUCTION_NO_BID` / `AUCTION_CANCELLED`), `ERR_NOT_DUE` + `ERR_ALREADY_TERMINAL` (close/cancel engine control, not surfaced to clients), and `ERR_NOT_ALLOWED` for cancel (non-owner → `OPERATION_REJECTED`/403). The hammer-race oracle is pinned: at `now >= endAtMs`, `place_bid` → `ERR_AFTER_END` and `close_auction` → `OK_SOLD`.
