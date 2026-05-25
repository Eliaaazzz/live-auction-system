package server

// Persistence-worker integration tests (review doc HT-030/031/032). They need a
// full store (Redis + MySQL) and skip when either is unreachable, so a bare
// `go test` stays green; CI provides both services so they gate.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// fullStore builds a Redis+MySQL store, skipping fast (no 30s retry) when either
// backend is unreachable.
func fullStore(t *testing.T) *store.Store {
	t.Helper()
	redisAddr := envOr("REDIS_ADDR", "127.0.0.1:6379")
	dsn := envOr("MYSQL_DSN", "lumen:lumen@tcp(127.0.0.1:3306)/lumen?parseTime=true&loc=UTC&charset=utf8mb4")

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
		t.Skipf("full store unavailable (redis=%v mysql_open=%v mysql_ping=%v)", rerr, derr, perr)
	}
	st, err := store.New(context.Background(), redisAddr, dsn)
	if err != nil {
		t.Skipf("store.New: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func persistRules() model.Rules {
	return model.Rules{StartPriceCents: 10000, IncrementCents: 1000, CapPriceCents: 0, DurationSec: 3600}
}

func liveAuctionFull(t *testing.T, st *store.Store, aid string) {
	t.Helper()
	ctx := context.Background()
	t.Cleanup(func() {
		if keys, _ := st.Redis().Keys(ctx, "auction:{"+aid+"}:*").Result(); len(keys) > 0 {
			_ = st.Redis().Del(ctx, keys...).Err()
		}
		_, _ = st.DB().ExecContext(ctx, "DELETE FROM auction_events WHERE auction_id = ?", aid)
	})
	if code, err := st.FreezeRules(ctx, aid, "seller_x", persistRules()); err != nil || code != model.CodeOKFrozen {
		t.Fatalf("freeze: code=%s err=%v", code, err)
	}
	if code, _, err := st.StartAuction(ctx, aid, 3_600_000); err != nil || code != model.CodeOKLive {
		t.Fatalf("start: code=%s err=%v", code, err)
	}
}

func eventually(t *testing.T, d time.Duration, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal(msg)
}

func newAID(prefix string) string { return fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano()) }

// HT-030: the worker must project from the Stream even when it started AFTER the
// bid was published (the Pub/Sub hint was missed) — the initial Stream sweep.
func TestT2HiddenPersistenceWorkerCatchesUpWithoutFuturePubSub(t *testing.T) {
	st := fullStore(t)
	aid := newAID("test_persist_catchup")
	liveAuctionFull(t, st, aid)
	ctx := context.Background()

	// Bid BEFORE any worker exists → Stream gets the event; the PUBLISH is heard by nobody.
	if code, _, _, err := st.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1"); err != nil || code != model.CodeOKAccepted {
		t.Fatalf("bid: code=%s err=%v", code, err)
	}
	if n, _ := st.CountEvents(ctx, aid); n != 0 {
		t.Fatalf("precondition: mysql already has %d events; worker should not have run yet", n)
	}

	wctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go runPersistenceWorker(wctx, st)

	eventually(t, 5*time.Second, func() bool {
		n, _ := st.CountEvents(ctx, aid)
		return n == 1
	}, "worker must catch up from the Stream even though the Pub/Sub hint was missed")
}

// HT-032: a fresh worker (simulating a restart with an empty cursor) re-sweeps
// from the beginning and must NOT create duplicate rows (idempotent projection).
func TestT2HiddenPersistenceWorkerRestartNoDuplicates(t *testing.T) {
	st := fullStore(t)
	aid := newAID("test_persist_restart")
	liveAuctionFull(t, st, aid)
	ctx := context.Background()

	st.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1")
	st.PlaceBid(ctx, aid, "u2", "cb2", "12000", "U2")

	w1, cancel1 := context.WithCancel(ctx)
	go runPersistenceWorker(w1, st)
	eventually(t, 5*time.Second, func() bool { n, _ := st.CountEvents(ctx, aid); return n == 2 }, "first worker should project 2 events")
	cancel1()
	time.Sleep(100 * time.Millisecond)

	// "restart": new worker, fresh cursor → re-reads from the start → INSERT IGNORE.
	w2, cancel2 := context.WithCancel(ctx)
	defer cancel2()
	go runPersistenceWorker(w2, st)
	time.Sleep(1 * time.Second) // let the initial sweep run
	if n, _ := st.CountEvents(ctx, aid); n != 2 {
		t.Fatalf("after restart mysql events=%d want 2 (no duplicates)", n)
	}
}

// HT-031: a different payload for an existing (auction_id, seq) is reported as a
// mismatch, not silently swallowed by INSERT IGNORE.
func TestT2HiddenInsertEventPayloadMismatch(t *testing.T) {
	st := fullStore(t)
	aid := newAID("test_persist_mismatch")
	ctx := context.Background()
	t.Cleanup(func() { _, _ = st.DB().ExecContext(ctx, "DELETE FROM auction_events WHERE auction_id = ?", aid) })

	if err := st.InsertEvent(ctx, aid, 1, "BID_ACCEPTED", `{"seq":1,"amountCents":"11000"}`); err != nil {
		t.Fatalf("first insert: %v", err)
	}
	// identical re-projection (different key order/whitespace) is idempotent.
	if err := st.InsertEvent(ctx, aid, 1, "BID_ACCEPTED", `{"amountCents":"11000", "seq":1}`); err != nil {
		t.Fatalf("idempotent re-insert must not error: %v", err)
	}
	// a genuinely different payload for the same seq is a mismatch.
	err := st.InsertEvent(ctx, aid, 1, "BID_ACCEPTED", `{"seq":1,"amountCents":"99999"}`)
	if !errors.Is(err, store.ErrEventPayloadMismatch) {
		t.Fatalf("payload mismatch: got %v want ErrEventPayloadMismatch", err)
	}
}
