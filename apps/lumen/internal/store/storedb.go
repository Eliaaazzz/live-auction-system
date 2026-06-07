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

// Product is the listed item behind an auction (商品 名称/图片/介绍). Surfaced on
// the auction detail so the room can show the real image and the VLM page can
// draft facts from it.
type Product struct {
	ID          string
	SellerID    string
	Name        string
	ImageURL    string
	Description string
}

// GetProduct returns the product row, or ErrNotFound.
func (s *Store) GetProduct(ctx context.Context, id string) (Product, error) {
	var p Product
	var img, desc sql.NullString
	err := s.db.QueryRowContext(ctx,
		`SELECT id, seller_id, name, image_url, description FROM products WHERE id = ?`, id).
		Scan(&p.ID, &p.SellerID, &p.Name, &img, &desc)
	if errors.Is(err, sql.ErrNoRows) {
		return p, ErrNotFound
	}
	p.ImageURL = img.String
	p.Description = desc.String
	return p, err
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
		`INSERT INTO auction_rules (auction_id, mode, start_price_cents, increment_cents, cap_price_cents, duration_sec, extend_window_sec, extend_sec, max_extensions, live_play_url, live_stream_key)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, model.NormalizeMode(r.Mode), r.StartPriceCents, r.IncrementCents, r.CapPriceCents, r.DurationSec, r.ExtendWindowSec, r.ExtendSec, r.MaxExtensions, r.LivePlayUrl, r.LiveStreamKey); err != nil {
		return err
	}
	return tx.Commit()
}

// UpdateConfirmedFacts persists the seller-confirmed facts snapshot at the
// freeze boundary. The caller holds the auction transition lock, so the
// confirmed snapshot and DRAFT->SCHEDULED transition stay together from the
// product/audit perspective.
func (s *Store) UpdateConfirmedFacts(ctx context.Context, id, confirmedFacts string) error {
	var facts any
	if confirmedFacts != "" {
		facts = confirmedFacts
	}
	res, err := s.db.ExecContext(ctx,
		`UPDATE auctions SET facts_confirmed = TRUE, confirmed_facts_json = ?, updated_at = ? WHERE id = ?`,
		facts, time.Now().UTC(), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// Auction is the minimal row used for ownership + state checks.
type Auction struct {
	ID              string
	ProductID       string
	SellerID        string
	Status          string
	FactsConfirmed  bool
	ParentAuctionID string
}

func (s *Store) GetAuction(ctx context.Context, id string) (Auction, error) {
	var a Auction
	var parent sql.NullString
	err := s.db.QueryRowContext(ctx,
		`SELECT id, product_id, seller_id, status, facts_confirmed, parent_auction_id FROM auctions WHERE id = ?`, id).
		Scan(&a.ID, &a.ProductID, &a.SellerID, &a.Status, &a.FactsConfirmed, &parent)
	if errors.Is(err, sql.ErrNoRows) {
		return a, ErrNotFound
	}
	a.ParentAuctionID = parent.String
	return a, err
}

func (s *Store) ChildAuctionByParent(ctx context.Context, parentAID string) (Auction, error) {
	var a Auction
	var parent sql.NullString
	err := s.db.QueryRowContext(ctx,
		`SELECT id, product_id, seller_id, status, facts_confirmed, parent_auction_id
		   FROM auctions WHERE parent_auction_id = ? ORDER BY created_at ASC LIMIT 1`, parentAID).
		Scan(&a.ID, &a.ProductID, &a.SellerID, &a.Status, &a.FactsConfirmed, &parent)
	if errors.Is(err, sql.ErrNoRows) {
		return a, ErrNotFound
	}
	a.ParentAuctionID = parent.String
	return a, err
}

func (s *Store) GetRules(ctx context.Context, aid string) (model.Rules, error) {
	var r model.Rules
	err := s.db.QueryRowContext(ctx,
		`SELECT mode, start_price_cents, increment_cents, cap_price_cents, duration_sec, extend_window_sec, extend_sec, max_extensions, live_play_url, live_stream_key
		 FROM auction_rules WHERE auction_id = ?`, aid).
		Scan(&r.Mode, &r.StartPriceCents, &r.IncrementCents, &r.CapPriceCents, &r.DurationSec, &r.ExtendWindowSec, &r.ExtendSec, &r.MaxExtensions, &r.LivePlayUrl, &r.LiveStreamKey)
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

// SetParentAuction links a freshly-created formal auction to the sealed PREQUALIFY
// parent it was seeded from (issue #114 phase 6). parent must already exist.
func (s *Store) SetParentAuction(ctx context.Context, aid, parentAID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE auctions SET parent_auction_id = ?, updated_at = ? WHERE id = ?`,
		parentAID, time.Now().UTC(), aid)
	return err
}

// UpdateRules replaces a pre-start auction's rules (商品管理: 修改未开始竞拍的规则).
// The caller gates on status (DRAFT/SCHEDULED) and ownership; this validates +
// writes. Also realigns the auctions display price with the new start price so
// the room/snapshot reflects the edit before freeze.
func (s *Store) UpdateRules(ctx context.Context, aid string, r model.Rules) error {
	if err := r.Validate(); err != nil {
		return err
	}
	res, err := s.db.ExecContext(ctx,
		`UPDATE auction_rules SET mode=?, start_price_cents=?, increment_cents=?, cap_price_cents=?,
		        duration_sec=?, extend_window_sec=?, extend_sec=?, max_extensions=?, live_play_url=?, live_stream_key=?
		  WHERE auction_id=?`,
		model.NormalizeMode(r.Mode), int64(r.StartPriceCents), int64(r.IncrementCents), int64(r.CapPriceCents),
		r.DurationSec, r.ExtendWindowSec, r.ExtendSec, r.MaxExtensions, r.LivePlayUrl, r.LiveStreamKey, aid)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	_, _ = s.db.ExecContext(ctx,
		`UPDATE auctions SET current_price_cents=?, updated_at=? WHERE id=? AND status IN ('DRAFT','SCHEDULED')`,
		int64(r.StartPriceCents), time.Now().UTC(), aid)
	return nil
}

// AuctionListItem is a row in the auctions list (商家 商品管理 / 买家 竞拍浏览 /
// 历史竞拍记录). Joined to the product for display name + image. Nullable
// winner/end columns are zero-valued when absent.
type AuctionListItem struct {
	ID                string
	ProductName       string
	ImageURL          string
	Status            string
	CurrentPriceCents int64
	WinnerID          string
	EndAtMs           int64
	CreatedAtMs       int64
	Mode              string
	ParentAuctionID   string
	// Rules + bid count back the 商品管理 table columns (起拍价 / 固定加价 /
	// 封顶价 / 出价次数) so the console renders without N+1 detail fetches.
	StartPriceCents int64
	IncrementCents  int64
	CapPriceCents   int64
	BidCount        int64
}

// ListAuctions returns recent auctions (newest first), joined to their product.
// Bounded by limit (default 100, max 200). Backs the seller 商品管理 table, the
// buyer browse list, and 历史竞拍记录 — replacing the hardcoded mock rows.
func (s *Store) ListAuctions(ctx context.Context, limit int) ([]AuctionListItem, error) {
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT a.id, COALESCE(p.name,''), COALESCE(p.image_url,''), a.status,
		        a.current_price_cents, COALESCE(a.winner_id,''), a.end_at, a.created_at,
		        COALESCE(ar.mode,'ENGLISH'), COALESCE(a.parent_auction_id,''),
		        COALESCE(ar.start_price_cents,0), COALESCE(ar.increment_cents,0),
		        COALESCE(ar.cap_price_cents,0),
		        (SELECT COUNT(*) FROM bids b WHERE b.auction_id = a.id)
		   FROM auctions a
		   LEFT JOIN products p ON a.product_id = p.id
		   LEFT JOIN auction_rules ar ON ar.auction_id = a.id
		  ORDER BY a.created_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AuctionListItem{}
	for rows.Next() {
		var it AuctionListItem
		var endAt, createdAt sql.NullTime
		if err := rows.Scan(&it.ID, &it.ProductName, &it.ImageURL, &it.Status,
			&it.CurrentPriceCents, &it.WinnerID, &endAt, &createdAt, &it.Mode, &it.ParentAuctionID,
			&it.StartPriceCents, &it.IncrementCents, &it.CapPriceCents, &it.BidCount); err != nil {
			return nil, err
		}
		if endAt.Valid {
			it.EndAtMs = endAt.Time.UnixMilli()
		}
		if createdAt.Valid {
			it.CreatedAtMs = createdAt.Time.UnixMilli()
		}
		out = append(out, it)
	}
	return out, rows.Err()
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
	defer func() { _, _ = conn.ExecContext(context.Background(), `SELECT RELEASE_LOCK(?)`, lockName) }()
	return fn()
}

func (s *Store) RecreateAuctionRules(ctx context.Context, aid string, r model.Rules) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM auction_rules WHERE auction_id = ?`, aid); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO auction_rules (auction_id, mode, start_price_cents, increment_cents, cap_price_cents, duration_sec, extend_window_sec, extend_sec, max_extensions, live_play_url, live_stream_key)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		aid, model.NormalizeMode(r.Mode), r.StartPriceCents, r.IncrementCents, r.CapPriceCents, r.DurationSec, r.ExtendWindowSec, r.ExtendSec, r.MaxExtensions, r.LivePlayUrl, r.LiveStreamKey); err != nil {
		return err
	}
	return tx.Commit()
}

// ErrEventPayloadMismatch is returned when a projected event row already exists
// for (auction_id, seq) but its payload differs from the Stream payload. A replay
// of the same Stream entry is idempotent; a divergent row is a projection bug or
// tamper signal.
var ErrEventPayloadMismatch = errors.New("event payload mismatch")

func (s *Store) SaveBid(ctx context.Context, aid, user string, amount int64, seq int64, clientBidID, source string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO bids (auction_id, user_id, amount_cents, seq, client_bid_id, source, accepted_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = id`,
		aid, user, amount, seq, clientBidID, source, time.Now().UTC())
	return err
}

func (s *Store) SaveOrder(ctx context.Context, id, aid, productID, buyer string, amount int64) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO orders (id, auction_id, product_id, buyer_id, amount_cents, status, created_at)
		 VALUES (?, ?, ?, ?, ?, 'created', ?)
		 ON DUPLICATE KEY UPDATE id = id`,
		id, aid, productID, buyer, amount, time.Now().UTC())
	return err
}

func (s *Store) SaveCoinLedger(ctx context.Context, aid, user string, delta int64, reason string, seq int64) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO coin_ledger (auction_id, user_id, delta_coins, reason, seq, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE id = id`,
		aid, user, delta, reason, seq, time.Now().UTC())
	return err
}

func (s *Store) SaveEvent(ctx context.Context, aid string, seq int64, eventType string, payload string) error {
	res, err := s.db.ExecContext(ctx,
		`INSERT IGNORE INTO auction_events (auction_id, seq, event_type, payload_json, created_at)
		 VALUES (?, ?, ?, CAST(? AS JSON), ?)`,
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
	return evidenceHashWithKey(s.evidenceKey, prevHash, seq, eventType, payload)
}

func (s *Store) evidenceHashForVersion(version int, prevHash string, seq int64, eventType, payload string) (string, error) {
	key, err := s.evidenceKeySource.EvidenceKey(version)
	if err != nil {
		return "", err
	}
	return evidenceHashWithKey(key, prevHash, seq, eventType, payload), nil
}

func evidenceHashWithKey(key []byte, prevHash string, seq int64, eventType, payload string) string {
	mac := hmac.New(sha256.New, key)
	// Byte-identical to fmt.Fprintf("%s\n%d\n%s\n%s", ...) but zero-alloc (no reflection)
	// — matters on a long VerifyEvidenceChain (1 HMAC/row). Output is unchanged, so this
	// does not invalidate existing chains. (@fariZzzz #34 second-pass §4.)
	mac.Write([]byte(prevHash))
	mac.Write([]byte{'\n'})
	mac.Write(strconv.AppendInt(nil, seq, 10))
	mac.Write([]byte{'\n'})
	mac.Write([]byte(eventType))
	mac.Write([]byte{'\n'})
	mac.Write([]byte(payload))
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
	var prevSeq sql.NullInt64
	err = tx.QueryRowContext(ctx,
		`SELECT seq, event_hash FROM auction_events WHERE auction_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1 FOR UPDATE`,
		aid, seq).Scan(&prevSeq, &prev)
	if errors.Is(err, sql.ErrNoRows) {
		if seq > 1 {
			return fmt.Errorf("%w: aid=%s seq=%d", ErrPreviousEventHashMissing, aid, seq)
		}
	} else if err != nil {
		return err
	}
	// Contiguity guard (TC-T4-112 / Eliaaazzz #35 2nd-pass): the chain must link to the
	// IMMEDIATELY-prior seq, not just the highest seq below this one. If the closest
	// existing row is < seq-1, then seq-1 hasn't been projected yet — transient (the
	// worker projects in seq order, so seq-1 arrives next sweep). Chaining across the
	// gap would build e.g. 1->3, which VerifyEvidenceChain used to still accept → a
	// false green for a dropped event, defeating the tamper-evidence point. An unchained
	// prev (empty hash) is the documented crash-window retry.
	if err == nil && (prevSeq.Int64 != seq-1 || !prev.Valid || prev.String == "") {
		return fmt.Errorf("%w: aid=%s seq=%d (closest prior seq=%d, want %d)", ErrPreviousEventHashMissing, aid, seq, prevSeq.Int64, seq-1)
	}
	h := s.evidenceHash(prev.String, seq, eventType, payloadNorm.String)
	if _, err := tx.ExecContext(ctx,
		`UPDATE auction_events SET event_hash = ?, prev_hash = ?, hmac_key_version = ? WHERE auction_id = ? AND seq = ? AND event_hash IS NULL`,
		h, prev.String, s.evidenceKeyVersion, aid, seq); err != nil {
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
	stats, err := s.evidenceChainStats(ctx, aid)
	if err != nil {
		return false, 0, err
	}
	if c, ok, err := s.loadEvidenceChainCache(ctx, aid); err != nil {
		return false, 0, err
	} else if ok {
		if c.verifiedSeq == stats.maxSeq && c.eventsCount == stats.count && c.chainHead == stats.tipHash && stats.maxUpdatedAt.Before(c.verifiedAt) {
			if err := s.ensureEvidenceKeysAvailable(ctx, aid, c.verifiedSeq); err != nil {
				return false, 0, err
			}
			return true, 0, nil
		}
		if c.verifiedSeq > 0 && c.verifiedSeq < stats.maxSeq {
			verifyStartedAt, err := s.dbNow(ctx)
			if err != nil {
				return false, 0, err
			}
			if err := s.ensureEvidenceKeysAvailable(ctx, aid, c.verifiedSeq); err != nil {
				return false, 0, err
			}
			prefixOK, err := s.evidencePrefixUnchanged(ctx, aid, c)
			if err != nil {
				return false, 0, err
			}
			if prefixOK {
				ok, brk, lastSeq, head, err := s.verifyEvidenceChainRows(ctx, aid, c.verifiedSeq+1, c.verifiedSeq+1, c.chainHead)
				if err != nil || !ok {
					return ok, brk, err
				}
				if err := s.storeEvidenceChainCache(ctx, aid, lastSeq, head, verifyStartedAt); err != nil {
					return false, 0, err
				}
				return true, 0, nil
			}
		}
	}
	verifyStartedAt, err := s.dbNow(ctx)
	if err != nil {
		return false, 0, err
	}
	ok, brk, lastSeq, head, err := s.verifyEvidenceChainRows(ctx, aid, 1, 1, "")
	if err != nil || !ok {
		return ok, brk, err
	}
	if err := s.storeEvidenceChainCache(ctx, aid, lastSeq, head, verifyStartedAt); err != nil {
		return false, 0, err
	}
	return true, 0, nil
}

type evidenceChainCache struct {
	verifiedSeq       int64
	eventsCount       int
	chainHead         string
	maxEventUpdatedAt time.Time
	verifiedAt        time.Time
}

type evidenceChainStats struct {
	count        int
	maxSeq       int64
	tipHash      string
	maxUpdatedAt time.Time
}

func (s *Store) verifyEvidenceChainRows(ctx context.Context, aid string, minSeq, expectedSeq int64, prev string) (ok bool, breakAtSeq int64, lastSeq int64, head string, err error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT seq, event_type, payload_json, event_hash, prev_hash, hmac_key_version
		 FROM auction_events WHERE auction_id = ? AND seq >= ? ORDER BY seq ASC`, aid, minSeq)
	if err != nil {
		return false, 0, 0, "", err
	}
	defer rows.Close()
	lastSeq = expectedSeq - 1
	head = prev
	for rows.Next() {
		var seq int64
		var eventType string
		var payload, eventHash, prevHash sql.NullString
		var hmacKeyVersion int
		if err := rows.Scan(&seq, &eventType, &payload, &eventHash, &prevHash, &hmacKeyVersion); err != nil {
			return false, 0, 0, "", err
		}
		if seq != expectedSeq {
			return false, seq, 0, "", nil // non-contiguous seq: a projection gap/skip (missing event) — defense-in-depth over fillEventHash's contiguity guard (TC-T4-112)
		}
		expectedSeq = seq + 1
		if prevHash.String != prev {
			return false, seq, 0, "", nil // chain link broken (prev_hash doesn't match the running head)
		}
		expectedHash, err := s.evidenceHashForVersion(hmacKeyVersion, prev, seq, eventType, payload.String)
		if err != nil {
			return false, seq, 0, "", err
		}
		if !eventHash.Valid || expectedHash != eventHash.String {
			return false, seq, 0, "", nil // missing or tampered event_hash
		}
		prev = eventHash.String
		lastSeq, head = seq, prev
	}
	if err := rows.Err(); err != nil {
		return false, 0, 0, "", err
	}
	return true, 0, lastSeq, head, nil
}

func (s *Store) ensureEvidenceKeysAvailable(ctx context.Context, aid string, maxSeq int64) error {
	if maxSeq <= 0 {
		return nil
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT DISTINCT hmac_key_version FROM auction_events WHERE auction_id = ? AND seq <= ?`,
		aid, maxSeq)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var version int
		if err := rows.Scan(&version); err != nil {
			return err
		}
		if _, err := s.evidenceKeySource.EvidenceKey(version); err != nil {
			return fmt.Errorf("evidence key version %d unavailable: %w", version, err)
		}
	}
	return rows.Err()
}

func (s *Store) evidenceChainStats(ctx context.Context, aid string) (evidenceChainStats, error) {
	var st evidenceChainStats
	if err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*), COALESCE(MAX(seq), 0),
		        COALESCE(MAX(updated_at), CAST('1970-01-01 00:00:00.000000' AS DATETIME(6)))
		   FROM auction_events WHERE auction_id = ?`, aid).
		Scan(&st.count, &st.maxSeq, &st.maxUpdatedAt); err != nil {
		return st, err
	}
	if st.maxSeq == 0 {
		return st, nil
	}
	var tip sql.NullString
	if err := s.db.QueryRowContext(ctx,
		`SELECT event_hash FROM auction_events WHERE auction_id = ? AND seq = ?`, aid, st.maxSeq).Scan(&tip); err != nil {
		return st, err
	}
	st.tipHash = tip.String
	return st, nil
}
