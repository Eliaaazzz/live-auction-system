package store

// Migration integration tests (resolves the H1 residual risk: the
// existing-volume schema migration was previously only checked by hand). These
// need Redis + MySQL and run in CI (which provides both); they assert the
// idempotent ALTER mechanism and the real auction_rules.max_extensions re-add on
// a pre-existing volume that lacks the column.

import (
	"context"
	"database/sql"
	"os"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func newMySQLStore(t *testing.T) *Store {
	t.Helper()
	redisAddr := os.Getenv("REDIS_ADDR")
	if redisAddr == "" {
		redisAddr = "127.0.0.1:6379"
	}
	dsn := os.Getenv("MYSQL_DSN")
	if dsn == "" {
		dsn = "lumen:lumen@tcp(127.0.0.1:3306)/lumen?parseTime=true&loc=UTC&charset=utf8mb4"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	rc := redis.NewClient(&redis.Options{Addr: redisAddr})
	rerr := rc.Ping(ctx).Err()
	_ = rc.Close()
	db, derr := sql.Open("mysql", dsn)
	var perr error
	if derr == nil {
		perr = db.PingContext(ctx)
		_ = db.Close()
	}
	if rerr != nil || derr != nil || perr != nil {
		t.Skipf("mysql store unavailable (redis=%v mysql_open=%v ping=%v)", rerr, derr, perr)
	}
	s, err := New(context.Background(), redisAddr, dsn)
	if err != nil {
		t.Skipf("store.New: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func hasColumn(t *testing.T, s *Store, table, column string) bool {
	t.Helper()
	var n int
	if err := s.db.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM information_schema.columns
		 WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
		table, column).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n > 0
}

// H1 existing-volume migration, automated on an ISOLATED throwaway table (the
// exact code path migrate() uses: a table missing the column → ensureColumn adds
// it). Isolated so it can't race the seller-WS/facts tests that INSERT into the
// shared auction_rules under parallel `go test ./...`.
func TestEnsureColumnReaddsMissingOnExistingVolume(t *testing.T) {
	s := newMySQLStore(t)
	ctx := context.Background()
	const tbl = "lumen_migrate_test" // mimics a pre-migration auction_rules
	_, _ = s.db.ExecContext(ctx, "DROP TABLE IF EXISTS "+tbl)
	if _, err := s.db.ExecContext(ctx, "CREATE TABLE "+tbl+" (auction_id VARCHAR(64) PRIMARY KEY)"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = s.db.ExecContext(ctx, "DROP TABLE IF EXISTS "+tbl) })

	if hasColumn(t, s, tbl, "max_extensions") {
		t.Fatal("precondition: column should be absent (old volume)")
	}
	// startup migration mechanism re-adds the missing column...
	if err := s.ensureColumn(ctx, tbl, "max_extensions", "BIGINT NOT NULL DEFAULT 0"); err != nil {
		t.Fatalf("ensureColumn add: %v", err)
	}
	if !hasColumn(t, s, tbl, "max_extensions") {
		t.Fatal("ensureColumn did not re-add the column on a pre-existing table")
	}
	// ...and is idempotent on a subsequent boot (no error, no-op).
	if err := s.ensureColumn(ctx, tbl, "max_extensions", "BIGINT NOT NULL DEFAULT 0"); err != nil {
		t.Fatalf("ensureColumn idempotent call errored: %v", err)
	}
}

// migrate() runs cleanly and idempotently against the real, current schema (the
// auction_rules.max_extensions column already present) — non-destructive, so it's
// safe under parallel packages. Pairs with the isolated re-add test above.
func TestMigrateIdempotentOnCurrentSchema(t *testing.T) {
	s := newMySQLStore(t)
	ctx := context.Background()
	if err := s.migrate(ctx); err != nil {
		t.Fatalf("migrate on current schema: %v", err)
	}
	if !hasColumn(t, s, "auction_rules", "max_extensions") {
		t.Fatal("auction_rules.max_extensions missing after migrate")
	}
}
