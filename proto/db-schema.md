# MySQL Schema

Materialized from PR #13 `docs/mysql-schema.md`. MySQL is the fact store; Redis owns the hot path. DDL lives in `infra/mysql/init/01-schema.sql` (applied on container init).

## Tables (T1 subset bootstrapped)

```text
users(id, nickname, avatar, role, created_at)
products(id, seller_id, name, image_url, description, status, created_at, updated_at)
auction_rules(id, auction_id, mode, start_price_cents, increment_cents, cap_price_cents,
              duration_sec, extend_window_sec, extend_sec, max_extensions, frozen_at)
auctions(id, product_id, seller_id, status, current_price_cents, winner_id, seq,
         parent_auction_id, start_at, end_at, finished_at, cancel_reason, created_at, updated_at)
bids(id, auction_id, user_id, amount_cents, seq, client_bid_id, source, accepted_at)
orders(id, auction_id, product_id, buyer_id, amount_cents, status, created_at, paid_at)
auction_events(id, auction_id, seq, event_type, payload_json, created_at,
               event_hash, prev_hash)        -- hash columns nullable in T1; filled in T4
ai_usage_logs(id, scenario, model_name, input_summary, output_summary, human_reviewed, created_at)
coin_ledger(id, auction_id, user_id, delta_coins, reason, seq, created_at)  -- ALL_PAY only (issue #114)
```

### Issue #114 additions (auction modes)

- **`auction_rules.mode`** — `VARCHAR(32) NOT NULL DEFAULT 'ENGLISH'`. Values: `ENGLISH | SUDDEN_DEATH | SEALED_FIRST | VICKREY | HYBRID_REVEAL | ALL_PAY | PREQUALIFY`. The hot path reads it once at freeze (carried through `freeze_rules.lua` into the state Hash); per-bid dispatch is in-process by mode.
- **`auctions.parent_auction_id`** — `VARCHAR(64) NULL`, self-FK to `auctions(id)`. Populated **only** for the formal child spawned from a `PREQUALIFY` parent via `POST /api/auctions/{id}/spawn-formal`. Two independent state machines; no cross-auction atomicity — the seed is a one-shot read at spawn.
- **`coin_ledger`** — append-only, money-safety surface for `ALL_PAY` (no fiat path). `reason ∈ { 'WIN', 'RUNNER_UP_FORFEIT' }`. `delta_coins` is signed (negative = debit). **Hard invariant: an `ALL_PAY` auction writes to `coin_ledger` and writes ZERO rows to `orders`** (verified by the demo gate + a money-safety test).

## Unique constraints (prove correctness)

```text
bids:           UNIQUE(auction_id, seq)
bids:           UNIQUE(auction_id, user_id, client_bid_id)
orders:         UNIQUE(auction_id)
auction_events: UNIQUE(auction_id, seq)
coin_ledger:    UNIQUE(auction_id, user_id, seq)   -- idempotent projection of ALL_PAY events (#114)
```

`event_hash` / `prev_hash` are present from T1 (nullable) so the schema is stable, but the **hash chain is computed by the Persistence Worker at T4** (integrity check on the MySQL projection — per fariZzzz #14 challenge #3), not in T1 and not in Lua.

## Persistence (T1 → T4)

Persistence Worker consumes the `auction:{aid}:events` Stream and writes one `auction_events` row per event (idempotent via UNIQUE(auction_id, seq)). **T4** added, on the same Stream-first projection: the `event_hash`/`prev_hash` chain (filled idempotently + self-healing) and an idempotent `orders` row on `AUCTION_SOLD` (UNIQUE(auction_id) ⇒ exactly-once). The hash algorithm + canonical serialization are the `[全员 approve]` surface in **`proto/evidence-card.md`**.
