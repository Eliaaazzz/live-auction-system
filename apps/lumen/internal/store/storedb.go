package store

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
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

// UpdateAuctionStatusIf performs a status-conditional update and reports whether it
// applied (RowsAffected == 1). It is the compare-and-set guard for the DRAFT cancel
// TOCTOU: a plain UpdateAuctionStatus would clobber a status a concurrent transition
// moved the row to between the caller's read and write. With `WHERE status = expected`
// the write no-ops (ok == false) when the row is no longer in the expected state, so
// the caller can re-read and re-dispatch instead of corrupting it. (TC-T3-100)
func (s *Store) UpdateAuctionStatusIf(ctx context.Context, id, status, expected string) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE auctions SET status = ?, updated_at = ? WHERE id = ? AND status = ?`,
		status, time.Now().UTC(), id, expected)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n == 1, nil
}

// WithAuctionTransitionLock serializes DRAFT edge transitions that span MySQL and
// Redis (currently freeze vs DRAFT cancel). The lock is advisory, so every
// participant in that cross-store transition must opt in.
func (s *Store) WithAuctionTransitionLock(ctx context.Context, aid string, fn func() error) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()

	lockName := "auction_transition:" + aid
	var got sql.NullInt64
	if err := conn.QueryRowContext(ctx, `SELECT GET_LOCK(?, 5)`, lockName).Scan(&got); err != nil {
		return err
	}
	if !got.Valid || got.Int64 != 1 {
		return fmt.Errorf("auction transition lock timeout: %s", aid)
	}
	defer func() {
		releaseCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		var released sql.NullInt64
		_ = conn.QueryRowContext(releaseCtx, `SELECT RELEASE_LOCK(?)`, lockName).Scan(&released)
	}()

	return fn()
}

// ErrEventPayloadMismatch means a row already exists for (auction_id, seq) with a
// DIFFERENT event type or payload than the one being projected — a tamper/bug
// signal, not the normal idempotent re-projection.
var ErrEventPayloadMismatch = errors.New("event type/payload mismatch for existing (auction_id, seq)")

// ErrPreviousEventHashMissing is a transient hash-fill dependency: the previous seq
// exists but has not been chained yet. The persistence worker should retry later.
var ErrPreviousEventHashMissing = errors.New("previous event hash missing")

// ErrPermanentOrderProjection marks a SOLD event/order inconsistency that retrying
// cannot repair without operator action.
var ErrPermanentOrderProjection = errors.New("permanent order projection error")

// ErrOrderProjectionMismatch means an idempotent order re-projection found an
// existing order for the auction that disagrees with the SOLD event.
var ErrOrderProjectionMismatch = errors.New("order projection mismatch")

// InsertEvent projects one Stream event into auction_events and extends the hash
// chain. Idempotent via UNIQUE(auction_id, seq): a re-projection of the same (seq,
// payload) is a no-op, but a DIFFERENT payload for an existing seq returns
// ErrEventPayloadMismatch rather than being silently swallowed by INSERT IGNORE.
// The hash chain (event_hash/prev_hash) is filled separately and idempotently — see
// fillEventHash — so it self-heals after a crash between the INSERT and the fill.
func (s *Store) InsertEvent(ctx context.Context, aid string, seq int64, eventType, payload string) error {
	res, err := s.db.ExecContext(ctx,
		`INSERT IGNORE INTO auction_events (auction_id, seq, event_type, payload_json, created_at)
		 VALUES (?, ?, ?, ?, ?)`,
		aid, seq, eventType, payload, time.Now().UTC())
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		// Row already exists: confirm it's an identical re-projection. event_type is
		// part of the hash canonical string, so a type-only mismatch must fail too.
		var existingType string
		var diff int
		if err := s.db.QueryRowContext(ctx,
			`SELECT event_type, payload_json <> CAST(? AS JSON) FROM auction_events WHERE auction_id = ? AND seq = ?`,
			payload, aid, seq).Scan(&existingType, &diff); err != nil {
			return err
		}
		if existingType != eventType || diff == 1 {
			return fmt.Errorf("%w: aid=%s seq=%d", ErrEventPayloadMismatch, aid, seq)
		}
	}
	return s.fillEventHash(ctx, aid, seq, eventType)
}

// evidenceHash computes the chained HMAC for one event (T4, proto/evidence-card.md):
//
//	event_hash = HMAC-SHA256(key, prev_hash || "\n" || seq || "\n" || event_type || "\n" || payload)
//
// payload is the MySQL-normalized payload_json text (read back from the column), so the
// writer (fillEventHash) and the verifier (VerifyEvidenceChain) — both of which read
// that column — hash byte-identical input regardless of cjson key order/whitespace.
func (s *Store) evidenceHash(prevHash string, seq int64, eventType, payload string) string {
	mac := hmac.New(sha256.New, s.evidenceKey)
	fmt.Fprintf(mac, "%s\n%d\n%s\n%s", prevHash, seq, eventType, payload)
	return hex.EncodeToString(mac.Sum(nil))
}

// fillEventHash idempotently sets event_hash/prev_hash for one already-inserted event.
// prev_hash links to the highest seq below this one ("" at genesis). The `event_hash IS
// NULL` guard makes it a no-op on re-projection and lets it self-heal a row left
// unchained by a crash between the INSERT and this fill. The persistence worker projects
// in seq order, so the previous event is already chained when this runs.
func (s *Store) fillEventHash(ctx context.Context, aid string, seq int64, eventType string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	var payloadNorm, existing sql.NullString
	if err := tx.QueryRowContext(ctx,
		`SELECT payload_json, event_hash FROM auction_events WHERE auction_id = ? AND seq = ? FOR UPDATE`,
		aid, seq).Scan(&payloadNorm, &existing); err != nil {
		return err
	}
	if existing.Valid && existing.String != "" {
		return tx.Commit() // already chained
	}
	var prev sql.NullString
	err = tx.QueryRowContext(ctx,
		`SELECT event_hash FROM auction_events WHERE auction_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1 FOR UPDATE`,
		aid, seq).Scan(&prev)
	if errors.Is(err, sql.ErrNoRows) {
		if seq > 1 {
			return fmt.Errorf("%w: aid=%s seq=%d", ErrPreviousEventHashMissing, aid, seq)
		}
	} else if err != nil {
		return err
	}
	if err == nil && (!prev.Valid || prev.String == "") {
		return fmt.Errorf("%w: aid=%s seq=%d", ErrPreviousEventHashMissing, aid, seq)
	}
	h := s.evidenceHash(prev.String, seq, eventType, payloadNorm.String)
	if _, err := tx.ExecContext(ctx,
		`UPDATE auction_events SET event_hash = ?, prev_hash = ? WHERE auction_id = ? AND seq = ? AND event_hash IS NULL`,
		h, prev.String, aid, seq); err != nil {
		return err
	}
	return tx.Commit()
}

// VerifyEvidenceChain recomputes the auction_events hash chain for aid and returns the
// first seq where it breaks: a prev_hash that doesn't link to the running head, or an
// event_hash that doesn't match a recompute over the stored payload (a post-hoc tamper
// of the payload or the hash itself). ok is true / breakAtSeq 0 when the whole chain
// verifies (an empty chain verifies). This backs the T4 `make verify-evidence` gate
// (hash_break_at_seq).
func (s *Store) VerifyEvidenceChain(ctx context.Context, aid string) (ok bool, breakAtSeq int64, err error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT seq, event_type, payload_json, event_hash, prev_hash FROM auction_events WHERE auction_id = ? ORDER BY seq ASC`, aid)
	if err != nil {
		return false, 0, err
	}
	defer rows.Close()
	prev := ""
	for rows.Next() {
		var seq int64
		var eventType string
		var payload, eventHash, prevHash sql.NullString
		if err := rows.Scan(&seq, &eventType, &payload, &eventHash, &prevHash); err != nil {
			return false, 0, err
		}
		if prevHash.String != prev {
			return false, seq, nil // chain link broken (prev_hash doesn't match the running head)
		}
		if !eventHash.Valid || s.evidenceHash(prev, seq, eventType, payload.String) != eventHash.String {
			return false, seq, nil // missing or tampered event_hash
		}
		prev = eventHash.String
	}
	if err := rows.Err(); err != nil {
		return false, 0, err
	}
	return true, 0, nil
}

func (s *Store) CountEvents(ctx context.Context, aid string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM auction_events WHERE auction_id = ?`, aid).Scan(&n)
	return n, err
}

// Order is the buyer order created when an auction is hammered SOLD (T4).
type Order struct {
	ID          string      `json:"id"`
	AuctionID   string      `json:"auctionId"`
	ProductID   string      `json:"productId"`
	BuyerID     string      `json:"buyerId"`
	AmountCents model.Cents `json:"amountCents"` // money-as-string on the JSON boundary
	Status      string      `json:"status"`
	CreatedAt   time.Time   `json:"createdAt"`
}

// CreateOrderFromSold creates the buyer order for a hammered/cap-hit SOLD auction from
// its AUCTION_SOLD event payload. It is exactly-once: orders.UNIQUE(auction_id) +
// INSERT IGNORE make it idempotent under re-projection or a double persistence worker,
// and the id is derived from the auction id so the primary key is stable too. Returns
// nil when the order already exists.
func (s *Store) CreateOrderFromSold(ctx context.Context, aid, payload string) error {
	var p model.AuctionSoldData
	if err := json.Unmarshal([]byte(payload), &p); err != nil {
		return fmt.Errorf("%w: parse AUCTION_SOLD payload for %s: %v", ErrPermanentOrderProjection, aid, err)
	}
	if p.WinnerID == "" {
		return fmt.Errorf("%w: AUCTION_SOLD payload has empty winnerId (aid=%s)", ErrPermanentOrderProjection, aid)
	}
	amount, err := strconv.ParseInt(p.AmountCents, 10, 64)
	if err != nil {
		return fmt.Errorf("%w: parse amountCents %q for %s: %v", ErrPermanentOrderProjection, p.AmountCents, aid, err)
	}
	var productID string
	if err := s.db.QueryRowContext(ctx,
		`SELECT product_id FROM auctions WHERE id = ?`, aid).Scan(&productID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("%w: missing auction/product for %s", ErrPermanentOrderProjection, aid)
		}
		return fmt.Errorf("order: look up product for %s: %w", aid, err)
	}
	res, err := s.db.ExecContext(ctx,
		`INSERT IGNORE INTO orders (id, auction_id, product_id, buyer_id, amount_cents, status, created_at)
		 VALUES (?, ?, ?, ?, ?, 'created', ?)`,
		"ord_"+aid, aid, productID, p.WinnerID, amount, time.Now().UTC())
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		return nil
	}
	o, err := s.GetOrder(ctx, aid)
	if err != nil {
		return err
	}
	if o.ProductID != productID || o.BuyerID != p.WinnerID || int64(o.AmountCents) != amount || o.Status != "created" {
		return fmt.Errorf("%w: aid=%s", ErrOrderProjectionMismatch, aid)
	}
	return nil
}

// GetOrder returns the order for an auction, or ErrNotFound if none exists yet.
func (s *Store) GetOrder(ctx context.Context, aid string) (Order, error) {
	var o Order
	err := s.db.QueryRowContext(ctx,
		`SELECT id, auction_id, product_id, buyer_id, amount_cents, status, created_at
		 FROM orders WHERE auction_id = ?`, aid).
		Scan(&o.ID, &o.AuctionID, &o.ProductID, &o.BuyerID, &o.AmountCents, &o.Status, &o.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return o, ErrNotFound
	}
	return o, err
}

// EvidenceEvent is one row of the evidence-card timeline (T4): the projected event plus
// its hash-chain links. payload is embedded as JSON (the MySQL-normalized form that the
// hash was computed over).
type EvidenceEvent struct {
	Seq       int64           `json:"seq"`
	EventType string          `json:"eventType"`
	Payload   json.RawMessage `json:"payload"`
	EventHash string          `json:"eventHash"`
	PrevHash  string          `json:"prevHash"`
}

// EventTimeline returns the full hash-chained event timeline for an auction in seq
// order — the body of the evidence card (T4).
func (s *Store) EventTimeline(ctx context.Context, aid string) ([]EvidenceEvent, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT seq, event_type, payload_json, event_hash, prev_hash
		 FROM auction_events WHERE auction_id = ? ORDER BY seq ASC`, aid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []EvidenceEvent
	for rows.Next() {
		var e EvidenceEvent
		var payload, eh, ph sql.NullString
		if err := rows.Scan(&e.Seq, &e.EventType, &payload, &eh, &ph); err != nil {
			return nil, err
		}
		if payload.Valid {
			e.Payload = json.RawMessage(payload.String)
		} else {
			e.Payload = json.RawMessage("null")
		}
		e.EventHash, e.PrevHash = eh.String, ph.String
		out = append(out, e)
	}
	return out, rows.Err()
}
