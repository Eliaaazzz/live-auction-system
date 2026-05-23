# Component 07 — Order Service

> **Path**: `apps/lumen/internal/order/`
> **Owner discipline**: leader; order schema is **all-member approve** (V9 §6).
> **Gates trunk**: T4 (idempotent order on `AUCTION_SOLD`).
> **Cross-references**: [05-persistence-worker](05-persistence-worker.md), `proto/db-schema.md`, `proto/openapi.yaml`.

## Purpose

Creates and tracks orders for terminal `SOLD` auctions. Order creation is **idempotent** — at-least-once delivery from Persistence Worker means we'll be called multiple times for the same auction; only the first must create the row.

Per the canonical state machine: `SOLD → ORDER_CREATED`. ORDER_CREATED is the only auction status change that happens *after* Lua decisions — controlled by Order Service writing to MySQL.

## Directory layout

```
apps/lumen/internal/order/
├── service.go             type Service; CreateForSold, GetByAuction, ListByUser
├── idempotency.go         UNIQUE(auction_id) enforcement
├── transition.go          on order create → bump auction status to ORDER_CREATED
├── mock_payment.go        P0: simulated payment flow ("mark paid" button)
├── metrics.go             create_total, create_duplicate_total
└── service_test.go
```

## Key types

```go
type Order struct {
    ID              string     // uuid
    AuctionID       string     // UNIQUE (1:1 with sold auctions)
    BuyerUserID     string
    SellerUserID    string
    FinalPriceCents int64
    Status          string     // CREATED | PAID | EXPIRED | REFUNDED (P0: CREATED + PAID via mock)
    CreatedAt       time.Time
    PaidAt          *time.Time
    EvidenceCardID  string     // FK to evidence_cards (built by separate process)
}

type CreateForSoldRequest struct {
    AuctionID     string
    WinnerUserID  string
    PriceCents    int64
    SoldAtMs      int64
    SoldEventSeq  int64        // from the AUCTION_SOLD Stream event
}
```

## Key functions

### `CreateForSold` — the idempotent entry point

```go
func (s *Service) CreateForSold(ctx context.Context, req CreateForSoldRequest) (*Order, error) {
    // 1. Load auction (need seller_user_id)
    auction, err := s.repo.GetAuction(ctx, req.AuctionID)
    if err != nil { return nil, err }

    // 2. Insert with UNIQUE(auction_id) — duplicate is fine
    o := &Order{
        ID:              uuid.NewString(),
        AuctionID:       req.AuctionID,
        BuyerUserID:     req.WinnerUserID,
        SellerUserID:    auction.SellerUserID,
        FinalPriceCents: req.PriceCents,
        Status:          "CREATED",
        CreatedAt:       time.Now(),
    }
    res, err := s.db.ExecContext(ctx,
        `INSERT INTO orders (id, auction_id, buyer_user_id, seller_user_id, final_price_cents, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = id`,  // no-op
        o.ID, o.AuctionID, o.BuyerUserID, o.SellerUserID, o.FinalPriceCents, o.Status, o.CreatedAt)
    if err != nil { return nil, err }

    affected, _ := res.RowsAffected()
    if affected == 0 {
        // Duplicate — load existing row, return that
        s.metrics.createDuplicate.Inc()
        return s.repo.GetOrderByAuction(ctx, req.AuctionID)
    }

    // 3. First-time create → bump auction status
    if err := s.transition.MarkAuctionOrderCreated(ctx, req.AuctionID); err != nil {
        // Non-fatal — auction status update is reflective, can retry
        s.metrics.transitionErr.Inc()
    }

    s.metrics.created.Inc()
    return o, nil
}
```

### `transition.MarkAuctionOrderCreated`

```go
func (t *Transition) MarkAuctionOrderCreated(ctx context.Context, auctionID string) error {
    // Only transition if currently SOLD
    res, err := t.db.ExecContext(ctx,
        `UPDATE auctions SET status = 'ORDER_CREATED', order_created_at = NOW()
         WHERE id = ? AND status = 'SOLD'`,
        auctionID)
    if err != nil { return err }
    affected, _ := res.RowsAffected()
    if affected == 0 {
        // Auction already in ORDER_CREATED (idempotent) or not in SOLD state (error)
        var status string
        t.db.QueryRowContext(ctx, `SELECT status FROM auctions WHERE id = ?`, auctionID).Scan(&status)
        if status != "ORDER_CREATED" {
            return fmt.Errorf("auction %s in unexpected status %s", auctionID, status)
        }
    }
    return nil
}
```

### `MarkPaid` — P0 mock payment

```go
func (s *Service) MarkPaid(ctx context.Context, orderID, callerUserID string) error {
    // P0 only: any logged-in user can "pay" their own order (no real payment integration).
    res, err := s.db.ExecContext(ctx,
        `UPDATE orders SET status = 'PAID', paid_at = NOW()
         WHERE id = ? AND buyer_user_id = ? AND status = 'CREATED'`,
        orderID, callerUserID)
    if err != nil { return err }
    affected, _ := res.RowsAffected()
    if affected == 0 {
        return ErrOrderNotPayable
    }
    s.metrics.paid.Inc()
    return nil
}
```

### `GetByAuction` / `ListByUser` — read-side

Straightforward repo wrappers. Used by REST handlers `GET /auctions/{id}/order` and `GET /me/orders`.

## Schema

In `proto/db-schema.md`:

```sql
CREATE TABLE orders (
    id                  CHAR(36) PRIMARY KEY,
    auction_id          CHAR(36) NOT NULL UNIQUE,  -- one order per sold auction
    buyer_user_id       CHAR(36) NOT NULL,
    seller_user_id      CHAR(36) NOT NULL,
    final_price_cents   BIGINT NOT NULL,
    status              ENUM('CREATED', 'PAID', 'EXPIRED', 'REFUNDED') NOT NULL DEFAULT 'CREATED',
    created_at          DATETIME NOT NULL,
    paid_at             DATETIME NULL,
    evidence_card_id    CHAR(36) NULL,
    INDEX idx_orders_buyer (buyer_user_id, created_at),
    INDEX idx_orders_seller (seller_user_id, created_at),
    FOREIGN KEY (auction_id) REFERENCES auctions(id)
);
```

`UNIQUE(auction_id)` is the idempotency guarantee. Without it, retries would create duplicate rows and the rubric correctness gate "no duplicate orders" would fail.

## Test surface (Go)

| Test | Verifies |
|---|---|
| `TestCreateForSold_HappyPath` | first call creates row, auction → ORDER_CREATED |
| `TestCreateForSold_Duplicate` | second call returns existing row, no second INSERT |
| `TestCreateForSold_RaceTenConcurrent` | 10 goroutines call CreateForSold → exactly one wins, others return same order |
| `TestCreateForSold_AuctionMissing` | unknown auction_id → error |
| `TestCreateForSold_AuctionNotSold` | auction in LIVE → error (Persistence Worker shouldn't call this case but defensive) |
| `TestMarkPaid_HappyPath` | CREATED → PAID; paid_at set |
| `TestMarkPaid_NotBuyer` | wrong user → ErrOrderNotPayable |
| `TestMarkPaid_AlreadyPaid` | PAID → PAID twice; second call returns ErrOrderNotPayable (no idempotency on payment per design) |
| `TestTransition_NoOpOnAlreadyCreated` | auction already in ORDER_CREATED → no error, no state change |

Coverage target: **≥85%**.

## NEEDS HUMAN REVIEW

1. **Mock payment design**: P0 does fake "mark paid" button. P1 might want OTP-style confirm. Either way, payment is OUT of the bid hot path; not affected by SLO.
2. **`evidence_card_id` linkage**: evidence card is built by a separate process (likely a small worker that listens for `AUCTION_SOLD` and assembles the timeline). For P0, can be built on-demand when user clicks "view evidence" instead of pre-built. Defer.
3. **Order expiry**: V9 doesn't mention CREATED → EXPIRED transition. Could be a TTL cron. Defer to P1.
4. **Refunds**: out of P0 scope. Schema has `REFUNDED` enum value but no flow.
