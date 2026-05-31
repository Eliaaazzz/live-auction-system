# MySQL Schema

Materialized from PR #13 `docs/mysql-schema.md`. MySQL is the fact store; Redis owns the hot path. DDL lives in `infra/mysql/init/01-schema.sql` (applied on container init).

## Tables (T1 subset bootstrapped)

```text
users(id, nickname, avatar, role, created_at)
products(id, seller_id, name, image_url, description, status, created_at, updated_at)
auction_rules(id, auction_id, start_price_cents, increment_cents, cap_price_cents,
              duration_sec, extend_window_sec, extend_sec, max_extensions, frozen_at)
auctions(id, product_id, seller_id, status, current_price_cents, winner_id, seq,
         start_at, end_at, finished_at, cancel_reason, created_at, updated_at)
bids(id, auction_id, user_id, amount_cents, seq, client_bid_id, source, accepted_at)
orders(id, auction_id, product_id, buyer_id, amount_cents, status, created_at, paid_at)
auction_events(id, auction_id, seq, event_type, payload_json, created_at,
               event_hash, prev_hash, hmac_key_version) -- hash columns nullable in T1; filled in T4
ai_usage_logs(id, scenario, model_name, input_summary, output_summary, human_reviewed, created_at)
```

## Unique constraints (prove correctness)

```text
bids:           UNIQUE(auction_id, seq)
bids:           UNIQUE(auction_id, user_id, client_bid_id)
orders:         UNIQUE(auction_id)
auction_events: UNIQUE(auction_id, seq)
```

`event_hash` / `prev_hash` are present from T1 (nullable) so the schema is stable, but the **hash chain is computed by the Persistence Worker at T4** (integrity check on the MySQL projection — per fariZzzz #14 challenge #3), not in T1 and not in Lua. `hmac_key_version` records the evidence-key version used for each row; existing rows default to version 1.

## Persistence (T1 → T4)

Persistence Worker consumes the `auction:{aid}:events` Stream and writes one `auction_events` row per event (idempotent via UNIQUE(auction_id, seq)). **T4** added, on the same Stream-first projection: the `event_hash`/`prev_hash` chain (filled idempotently + self-healing) and an idempotent `orders` row on `AUCTION_SOLD` (UNIQUE(auction_id) ⇒ exactly-once). The hash algorithm + canonical serialization are the `[全员 approve]` surface in **`proto/evidence-card.md`**.
