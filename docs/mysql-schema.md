# MySQL Schema

Source basis: RFC v1 §7, with V8 evidence and AI logging retained. MySQL is the fact store; Redis remains the live adjudication path.

```text
users(id, nickname, avatar, role, created_at)

products(id, seller_id, name, image_url, description, status, created_at, updated_at)

auction_rules(
  id, auction_id,
  start_price_cents, increment_cents, cap_price_cents,
  duration_sec, extend_window_sec, extend_sec, max_extensions,
  auction_mode,
  frozen_at
)

auctions(
  id, product_id, seller_id, status,
  current_price_cents, winner_id, seq,
  start_at, end_at, finished_at,
  cancel_reason,
  created_at, updated_at
)

bids(
  id, auction_id, user_id, amount_cents,
  seq, client_bid_id, source,
  accepted_at
)

orders(
  id, auction_id, product_id, buyer_id,
  amount_cents, status,
  created_at, paid_at
)

auction_events(id, auction_id, seq, event_type, payload_json, created_at)

ai_usage_logs(id, scenario, model_name, input_summary, output_summary, human_reviewed, created_at)
```

Unique constraints:

```text
bids:           UNIQUE(auction_id, seq)
bids:           UNIQUE(auction_id, user_id, client_bid_id)
orders:         UNIQUE(auction_id)
auction_events: UNIQUE(auction_id, seq)
```

Recommended indexes:

- `products(seller_id, status, created_at)`
- `auctions(status, start_at, end_at)`
- `auctions(seller_id, status, updated_at)`
- `bids(auction_id, accepted_at)`
- `orders(buyer_id, created_at)`
- `auction_events(auction_id, seq)`
- `ai_usage_logs(scenario, created_at)`

These constraints prove no duplicate accepted seq, no duplicate client retry effect, one order per auction, and replayable ordered events.
