package store

// Hard-delete integration tests for the 后台「删除发布历史 / 近期成交」cleanup path.
// They need Redis + MySQL and run in CI (which provides both); they t.Skip
// locally via newMySQLStore when the infra is unavailable. Each test uses a
// UnixNano-unique auction id so it can't collide with parallel packages, and
// cleans up after itself.

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

// seedAuctionRow inserts one auction plus every auction-keyed row (product,
// rules, order, event, coin ledger, evidence cache) and seeds the Redis state
// hash / event stream / leaderboard / active-set membership, so a delete has
// something to remove in every table and key.
func seedAuctionRow(t *testing.T, s *Store, aid, productID, sellerID, status string) {
	t.Helper()
	ctx := context.Background()
	now := time.Now().UTC()
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := s.db.ExecContext(ctx, q, args...); err != nil {
			t.Fatalf("seed %q: %v", q, err)
		}
	}
	exec(`INSERT INTO products (id, seller_id, name, image_url, description, status, created_at, updated_at)
	      VALUES (?,?,?,?,?,?,?,?)`, productID, sellerID, "删除测试商品", "/uploads/x.png", "", "active", now, now)
	exec(`INSERT INTO auctions (id, product_id, seller_id, status, current_price_cents, winner_id, seq, facts_confirmed, created_at, updated_at)
	      VALUES (?,?,?,?,?,?,?,?,?,?)`, aid, productID, sellerID, status, 50000, "user_win", 3, 1, now, now)
	exec(`INSERT INTO auction_rules (auction_id, mode, start_price_cents, increment_cents, cap_price_cents, duration_sec)
	      VALUES (?,?,?,?,?,?)`, aid, "ENGLISH", 0, 5000, 1200000, 80)
	exec(`INSERT INTO orders (id, auction_id, product_id, buyer_id, amount_cents, status, created_at)
	      VALUES (?,?,?,?,?,?,?)`, "order_"+aid, aid, productID, "user_win", 50000, "created", now)
	exec(`INSERT INTO auction_events (auction_id, seq, event_type, payload_json, created_at)
	      VALUES (?,?,?,?,?)`, aid, 1, "BID_ACCEPTED", `{"x":1}`, now)
	exec(`INSERT INTO coin_ledger (auction_id, user_id, delta_coins, reason, seq, created_at)
	      VALUES (?,?,?,?,?,?)`, aid, "user_win", -100, "WIN", 1, now)
	exec(`INSERT INTO evidence_chain_cache (auction_id, verified_seq, events_count, chain_head, max_event_updated_at, verified_at)
	      VALUES (?,?,?,?,?,?)`, aid, 1, 1, "deadbeef", now, now)

	if err := s.rdb.HSet(ctx, stateKey(aid), "status", status, "sellerId", sellerID).Err(); err != nil {
		t.Fatalf("seed state: %v", err)
	}
	if err := s.rdb.XAdd(ctx, &redis.XAddArgs{Stream: streamKey(aid), Values: map[string]any{"e": "x"}}).Err(); err != nil {
		t.Fatalf("seed stream: %v", err)
	}
	if err := s.rdb.ZAdd(ctx, lbKey(aid), redis.Z{Score: 1, Member: "user_win"}).Err(); err != nil {
		t.Fatalf("seed leaderboard: %v", err)
	}
	// Future score so a concurrent server-package timer worker (shared Redis under
	// CI `go test ./...`) never sees these as DUE and untracks/closes them under us
	// — the documented shared-Redis timer flake. We only need active-set membership
	// to exist, not to be due.
	if err := s.rdb.ZAdd(ctx, activeKey, redis.Z{Score: float64(now.Add(time.Hour).UnixMilli()), Member: aid}).Err(); err != nil {
		t.Fatalf("seed active set: %v", err)
	}
}

func countWhere(t *testing.T, s *Store, query, arg string) int {
	t.Helper()
	var n int
	if err := s.db.QueryRowContext(context.Background(), query, arg).Scan(&n); err != nil {
		t.Fatalf("count %q: %v", query, err)
	}
	return n
}

// A terminal auction is removed from every MySQL table + every Redis key, the
// unreferenced product is dropped, and it is untracked from auction:active.
func TestDeleteAuctionPurgesTerminalEverywhere(t *testing.T) {
	s := newMySQLStore(t)
	ctx := context.Background()
	aid := fmt.Sprintf("del_ok_%d", time.Now().UnixNano())
	pid := "prod_" + aid
	const seller = "seller_del_test"
	seedAuctionRow(t, s, aid, pid, seller, model.StateSold)
	t.Cleanup(func() {
		_, _ = s.db.ExecContext(ctx, "DELETE FROM auctions WHERE id=?", aid)
		_, _ = s.db.ExecContext(ctx, "DELETE FROM products WHERE id=?", pid)
	})

	res, err := s.DeleteAuction(ctx, aid, seller)
	if err != nil {
		t.Fatalf("DeleteAuction: %v", err)
	}
	if !res.ProductDeleted {
		t.Errorf("ProductDeleted = false, want true (product is unreferenced)")
	}
	for _, q := range []string{
		"SELECT COUNT(*) FROM auctions WHERE id=?",
		"SELECT COUNT(*) FROM auction_rules WHERE auction_id=?",
		"SELECT COUNT(*) FROM orders WHERE auction_id=?",
		"SELECT COUNT(*) FROM auction_events WHERE auction_id=?",
		"SELECT COUNT(*) FROM coin_ledger WHERE auction_id=?",
		"SELECT COUNT(*) FROM evidence_chain_cache WHERE auction_id=?",
	} {
		if n := countWhere(t, s, q, aid); n != 0 {
			t.Errorf("%q = %d, want 0", q, n)
		}
	}
	if n := countWhere(t, s, "SELECT COUNT(*) FROM products WHERE id=?", pid); n != 0 {
		t.Errorf("product row remained: %d", n)
	}
	if ex, _ := s.rdb.Exists(ctx, stateKey(aid), streamKey(aid), lbKey(aid)).Result(); ex != 0 {
		t.Errorf("redis keys remain after delete: exists=%d", ex)
	}
	if err := s.rdb.ZScore(ctx, activeKey, aid).Err(); err != redis.Nil {
		t.Errorf("auction still tracked in active set (ZScore err=%v, want redis.Nil)", err)
	}
}

// A non-terminal (LIVE) auction is rejected — and crucially its Redis live state
// is left intact, because the terminal gate runs before the purge.
func TestDeleteAuctionRejectsNonTerminalWithoutPurge(t *testing.T) {
	s := newMySQLStore(t)
	ctx := context.Background()
	aid := fmt.Sprintf("del_live_%d", time.Now().UnixNano())
	pid := "prod_" + aid
	const seller = "seller_del_test"
	seedAuctionRow(t, s, aid, pid, seller, model.StateLive)
	t.Cleanup(func() {
		for _, q := range []string{
			"DELETE FROM auctions WHERE id=?", "DELETE FROM auction_rules WHERE auction_id=?",
			"DELETE FROM orders WHERE auction_id=?", "DELETE FROM auction_events WHERE auction_id=?",
			"DELETE FROM coin_ledger WHERE auction_id=?", "DELETE FROM evidence_chain_cache WHERE auction_id=?",
			"DELETE FROM products WHERE id=?",
		} {
			arg := aid
			if q == "DELETE FROM products WHERE id=?" {
				arg = pid
			}
			_, _ = s.db.ExecContext(ctx, q, arg)
		}
		_ = s.rdb.Del(ctx, stateKey(aid), streamKey(aid), lbKey(aid)).Err()
		_ = s.rdb.ZRem(ctx, activeKey, aid).Err()
	})

	if _, err := s.DeleteAuction(ctx, aid, seller); err != ErrAuctionNotDeletable {
		t.Fatalf("DeleteAuction(LIVE) err = %v, want ErrAuctionNotDeletable", err)
	}
	if n := countWhere(t, s, "SELECT COUNT(*) FROM auctions WHERE id=?", aid); n != 1 {
		t.Errorf("LIVE auction row should remain, got %d", n)
	}
	// Ordering guarantee: the live Redis state must NOT have been purged.
	if ex, _ := s.rdb.Exists(ctx, stateKey(aid)).Result(); ex != 1 {
		t.Errorf("LIVE state key was purged on a rejected delete (exists=%d)", ex)
	}
	if err := s.rdb.ZScore(ctx, activeKey, aid).Err(); err == redis.Nil {
		t.Errorf("LIVE auction was untracked from active set on a rejected delete")
	}
}

// Deleting one auction must NOT drop a product another auction still references
// (spawn-formal reuse), and the sibling auction stays intact.
func TestDeleteAuctionKeepsSharedProduct(t *testing.T) {
	s := newMySQLStore(t)
	ctx := context.Background()
	base := fmt.Sprintf("%d", time.Now().UnixNano())
	pid := "prod_shared_" + base
	a1 := "del_shared_a_" + base
	a2 := "del_shared_b_" + base
	const seller = "seller_del_test"
	seedAuctionRow(t, s, a1, pid, seller, model.StateSold)
	now := time.Now().UTC()
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO auctions (id, product_id, seller_id, status, current_price_cents, seq, facts_confirmed, created_at, updated_at)
		 VALUES (?,?,?,?,?,?,?,?,?)`, a2, pid, seller, model.StateScheduled, 0, 0, 1, now, now); err != nil {
		t.Fatalf("seed sibling auction: %v", err)
	}
	t.Cleanup(func() {
		_, _ = s.db.ExecContext(ctx, "DELETE FROM auctions WHERE id IN (?,?)", a1, a2)
		_, _ = s.db.ExecContext(ctx, "DELETE FROM products WHERE id=?", pid)
	})

	res, err := s.DeleteAuction(ctx, a1, seller)
	if err != nil {
		t.Fatalf("DeleteAuction(a1): %v", err)
	}
	if res.ProductDeleted {
		t.Errorf("ProductDeleted = true, but a2 still references the product")
	}
	if n := countWhere(t, s, "SELECT COUNT(*) FROM products WHERE id=?", pid); n != 1 {
		t.Errorf("shared product row missing, got %d", n)
	}
	if n := countWhere(t, s, "SELECT COUNT(*) FROM auctions WHERE id=?", a2); n != 1 {
		t.Errorf("sibling auction a2 should remain, got %d", n)
	}
}
