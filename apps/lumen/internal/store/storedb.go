package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

// ErrNotFound is returned when a row does not exist.
var ErrNotFound = errors.New("not found")

// ErrNotAllowed is returned when a caller tries to operate on another owner's row.
var ErrNotAllowed = errors.New("not allowed")

func (s *Store) UpsertUser(ctx context.Context, id, nickname, role string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO users (id, nickname, role, created_at) VALUES (?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE nickname = VALUES(nickname), role = VALUES(role)`,
		id, nickname, role, time.Now().UTC())
	return err
}

// UserNickname returns the display nickname for a user id, or "" if not found.
// Used by the WS gateway to label bids with the human name rather than the id.
func (s *Store) UserNickname(ctx context.Context, id string) (string, error) {
	var nickname string
	err := s.db.QueryRowContext(ctx, `SELECT nickname FROM users WHERE id = ?`, id).Scan(&nickname)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return nickname, err
}

func (s *Store) CreateProduct(ctx context.Context, id, sellerID, name, imageURL, description string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO products (id, seller_id, name, image_url, description, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
		id, sellerID, name, imageURL, description, time.Now().UTC(), time.Now().UTC())
	return err
}

// CreateAuction inserts a DRAFT auction and its frozen-able rules in one tx.
// factsConfirmed records that the seller confirmed the AI facts draft before
// the auction can be frozen/started; confirmedFacts is the confirmed snapshot
// (may be empty).
func (s *Store) CreateAuction(ctx context.Context, id, productID, sellerID string, r model.Rules, factsConfirmed bool, confirmedFacts string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	var productSellerID string
	if err = tx.QueryRowContext(ctx, `SELECT seller_id FROM products WHERE id = ?`, productID).Scan(&productSellerID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if productSellerID != sellerID {
		return ErrNotAllowed
	}

	var facts any
	if confirmedFacts != "" {
		facts = confirmedFacts
	}
	if _, err = tx.ExecContext(ctx,
		`INSERT INTO auctions (id, product_id, seller_id, status, current_price_cents, seq, facts_confirmed, confirmed_facts_json, created_at, updated_at)
		 VALUES (?, ?, ?, 'DRAFT', ?, 0, ?, ?, ?, ?)`,
		id, productID, sellerID, r.StartPriceCents, factsConfirmed, facts, time.Now().UTC(), time.Now().UTC()); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx,
		`INSERT INTO auction_rules (auction_id, start_price_cents, increment_cents, cap_price_cents, duration_sec, extend_window_sec, extend_sec, max_extensions)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		id, r.StartPriceCents, r.IncrementCents, r.CapPriceCents, r.DurationSec, r.ExtendWindowSec, r.ExtendSec, r.MaxExtensions); err != nil {
		return err
	}
	return tx.Commit()
}

// Auction is the minimal row used for ownership + state checks.
type Auction struct {
	ID             string
	ProductID      string
	SellerID       string
	Status         string
	FactsConfirmed bool
}

func (s *Store) GetAuction(ctx context.Context, id string) (Auction, error) {
	var a Auction
	err := s.db.QueryRowContext(ctx,
		`SELECT id, product_id, seller_id, status, facts_confirmed FROM auctions WHERE id = ?`, id).
		Scan(&a.ID, &a.ProductID, &a.SellerID, &a.Status, &a.FactsConfirmed)
	if errors.Is(err, sql.ErrNoRows) {
		return a, ErrNotFound
	}
	return a, err
}

func (s *Store) GetRules(ctx context.Context, aid string) (model.Rules, error) {
	var r model.Rules
	err := s.db.QueryRowContext(ctx,
		`SELECT start_price_cents, increment_cents, cap_price_cents, duration_sec, extend_window_sec, extend_sec, max_extensions
		 FROM auction_rules WHERE auction_id = ?`, aid).
		Scan(&r.StartPriceCents, &r.IncrementCents, &r.CapPriceCents, &r.DurationSec, &r.ExtendWindowSec, &r.ExtendSec, &r.MaxExtensions)
	if errors.Is(err, sql.ErrNoRows) {
		return r, ErrNotFound
	}
	return r, err
}

func (s *Store) UpdateAuctionStatus(ctx context.Context, id, status string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE auctions SET status = ?, updated_at = ? WHERE id = ?`, status, time.Now().UTC(), id)
	return err
}

// ErrEventPayloadMismatch means a row already exists for (auction_id, seq) with a
// DIFFERENT payload than the one being projected — a tamper/bug signal, not the
// normal idempotent re-projection. The full hash chain lands in T4; this is the
// lightweight integrity tripwire.
var ErrEventPayloadMismatch = errors.New("event payload mismatch for existing (auction_id, seq)")

// InsertEvent projects one Stream event into auction_events. Idempotent via
// UNIQUE(auction_id, seq): a re-projection of the same (seq, payload) is a no-op,
// but a DIFFERENT payload for an existing seq returns ErrEventPayloadMismatch
// rather than being silently swallowed by INSERT IGNORE.
func (s *Store) InsertEvent(ctx context.Context, aid string, seq int64, eventType, payload string) error {
	res, err := s.db.ExecContext(ctx,
		`INSERT IGNORE INTO auction_events (auction_id, seq, event_type, payload_json, created_at)
		 VALUES (?, ?, ?, ?, ?)`,
		aid, seq, eventType, payload, time.Now().UTC())
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		return nil // freshly inserted
	}
	// Row already exists: confirm it's an identical re-projection. MySQL JSON
	// comparison normalizes key order/whitespace, so this only trips on a genuine
	// different-payload-for-same-seq, not on cjson formatting differences.
	var diff int
	if err := s.db.QueryRowContext(ctx,
		`SELECT payload_json <> CAST(? AS JSON) FROM auction_events WHERE auction_id = ? AND seq = ?`,
		payload, aid, seq).Scan(&diff); err != nil {
		return err
	}
	if diff == 1 {
		return fmt.Errorf("%w: aid=%s seq=%d", ErrEventPayloadMismatch, aid, seq)
	}
	return nil
}

func (s *Store) CountEvents(ctx context.Context, aid string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM auction_events WHERE auction_id = ?`, aid).Scan(&n)
	return n, err
}
