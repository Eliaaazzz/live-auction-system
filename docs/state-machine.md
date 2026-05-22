# Auction State Machine

Source basis: Plan V8 §2 and RFC v1 §4, simplified to the P0 backend contract. Seller confirmation of AI facts happens before rule freeze in `SCHEDULED`; it is not an auction runtime state.

```text
DRAFT
  │ seller edits product and rules; no bidding
  ▼
SCHEDULED
  │ AI facts confirmed, rules frozen, waits for start
  ▼
LIVE
  │ accepts valid bids through Redis Lua
  ├── abnormal seller cancel ─────────────▶ CANCELLED
  ├── cap reached ────────────────────────▶ SOLD
  ├── now >= ends_at_ms and highest bid ──▶ SOLD
  └── now >= ends_at_ms and no bid ───────▶ NO_BID

SOLD ── order created idempotently ───────▶ ORDER_CREATED
```

| From | Event / command | To | Adjudicator |
|---|---|---|---|
| DRAFT | seller publishes, confirms AI facts, and freezes rules | SCHEDULED | Auction Service / freeze Lua |
| SCHEDULED | seller starts or scheduled start arrives | LIVE | `start_auction.lua` |
| LIVE | legal bid below cap | LIVE | `place_bid.lua` |
| LIVE | legal anti-snipe bid | LIVE + `AUCTION_EXTENDED` | `place_bid.lua` |
| LIVE | legal bid reaches cap | SOLD | `place_bid.lua` |
| LIVE | Redis TIME `now >= ends_at_ms` and highest bid exists | SOLD | Timer Worker + `close_auction.lua` |
| LIVE | Redis TIME `now >= ends_at_ms` and no accepted bid exists | NO_BID | Timer Worker + `close_auction.lua` |
| SOLD | order created | ORDER_CREATED | Order Service |
| DRAFT/SCHEDULED/LIVE | abnormal cancel | CANCELLED | `cancel_auction.lua` |

Terminal states reject new bids: `SOLD`, `NO_BID`, `CANCELLED`, and `ORDER_CREATED`. Existing V8 correctness wording says terminal bids return `after_hammer`; protocol docs may map that user-facing reason onto `ERR_NOT_LIVE` or a terminal-specific rejection, but accepted state must not change.

There is no `EXTENDED` state. Anti-snipe extension is an event inside `LIVE`: Redis updates `ends_at_ms`, increments `extendCount`, writes Stream, and broadcasts `AUCTION_EXTENDED`. Keeping it as an event avoids two bid-accepting states. Expiry adjudication is also not a separate persistent state: the backend remains `LIVE + endAtMs` until `close_auction.lua` atomically returns `OK_SOLD` or `OK_NO_BID`.
