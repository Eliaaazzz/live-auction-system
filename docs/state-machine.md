# Auction State Machine

Source basis: Plan V8 §2 and RFC v1 §4. V8 vocabulary is used as the public canonical model; RFC `LIVE/SOLD/NO_BID/ORDER_CREATED` maps to `Bidding/Hammered/Passed/Settled` behavior.

```text
Draft
  │ seller edits product and rules; no bidding
  ▼
Scheduled
  │ rules frozen; waits for start
  ▼
Bidding
  │ accepts valid bids through Redis Lua
  ├── abnormal seller cancel ─────────────▶ Cancelled
  ├── cap reached ────────────────────────▶ Hammered
  └── now >= ends_at_ms ──────────────────▶ Cooling
                                                ├── highest bid exists ─▶ Hammered
                                                ├── no valid bid ───────▶ Passed
                                                └── reserve unmet ──────▶ ReserveNotMet

Hammered
  ├── seller confirm required ────────────▶ AwaitingSellerConfirm
  └── no seller confirm required ─────────▶ Settled

AwaitingSellerConfirm ─ seller confirms ─▶ Settled
```

| From | Event / command | To | Adjudicator |
|---|---|---|---|
| Draft | seller publishes and freezes rules | Scheduled | Auction Service / freeze Lua |
| Scheduled | seller starts or scheduled start arrives | Bidding | `start_auction.lua` |
| Bidding | legal bid below cap | Bidding | `place_bid.lua` |
| Bidding | legal anti-snipe bid | Bidding + `AUCTION_EXTENDED` | `place_bid.lua` |
| Bidding | legal bid reaches cap | Hammered | `place_bid.lua` |
| Bidding | Redis TIME `now >= ends_at_ms` | Cooling | Timer Worker + `close_auction.lua` |
| Cooling | valid highest bid | Hammered | `close_auction.lua` |
| Cooling | no accepted bid | Passed | `close_auction.lua` |
| Cooling | reserve not met | ReserveNotMet | `close_auction.lua` |
| Hammered | order created | Settled | Order Service |
| Draft/Scheduled/Bidding | abnormal cancel | Cancelled | `cancel_auction.lua` |

Terminal states reject new bids: `Hammered`, `Passed`, `ReserveNotMet`, `Settled`, and `Cancelled`. Existing V8 correctness wording says terminal bids return `after_hammer`; protocol docs may map that user-facing reason onto `ERR_NOT_LIVE` or a terminal-specific rejection, but accepted state must not change.

There is no `EXTENDED` state. Anti-snipe extension is an event inside `Bidding`: Redis updates `ends_at_ms`, increments `extendCount`, writes Stream, and broadcasts `AUCTION_EXTENDED`. Keeping it as an event avoids two bid-accepting states.
