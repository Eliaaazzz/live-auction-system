package store

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

var benchAIDCounter int64

func newBenchStore(b *testing.B) *Store {
	b.Helper()
	addr := os.Getenv("REDIS_ADDR")
	if addr == "" {
		addr = "127.0.0.1:6379"
	}
	rdb := redis.NewClient(&redis.Options{Addr: addr})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		_ = rdb.Close()
		b.Skipf("redis not available at %s: %v (set REDIS_ADDR to run Lua benchmarks)", addr, err)
	}
	s := &Store{rdb: rdb}
	if err := s.loadScripts(context.Background()); err != nil {
		_ = rdb.Close()
		b.Fatalf("load scripts: %v", err)
	}
	b.Cleanup(func() { _ = rdb.Close() })
	return s
}

func liveBenchAuction(b *testing.B, s *Store) string {
	b.Helper()
	ctx := context.Background()
	aid := fmt.Sprintf("bench_placebid_%d_%d", time.Now().UnixNano(), atomic.AddInt64(&benchAIDCounter, 1))
	b.Cleanup(func() { cleanupAID(s, aid) })

	rules := defaultRules()
	rules.IncrementCents = 1
	if code, err := s.FreezeRules(ctx, aid, sellerTestID, rules); err != nil || code != model.CodeOKFrozen {
		b.Fatalf("freeze: code=%s err=%v", code, err)
	}
	if code, _, err := s.StartAuction(ctx, aid, int64(time.Hour/time.Millisecond)); err != nil || code != model.CodeOKLive {
		b.Fatalf("start: code=%s err=%v", code, err)
	}
	return aid
}

// BenchmarkPlaceBidLuaHotPath is the #92 G5 regression hook for the Redis Lua
// bid adjudicator. It drives the real place_bid.lua script against Redis with a
// long-lived uncapped auction, unique clientBidIDs, and strictly increasing
// amounts so every iteration measures the accepted-bid hot path rather than
// duplicate replay, cap close, or rejection handling.
func BenchmarkPlaceBidLuaHotPath(b *testing.B) {
	s := newBenchStore(b)
	aid := liveBenchAuction(b, s)
	ctx := context.Background()

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		amount := strconv.FormatInt(11_000+int64(i), 10)
		uid := fmt.Sprintf("bench_user_%03d", i&127)
		code, _, _, err := s.PlaceBid(ctx, aid, uid, fmt.Sprintf("bench_cb_%d", i), amount, uid)
		if err != nil {
			b.Fatalf("place bid %d: %v", i, err)
		}
		if code != model.CodeOKAccepted {
			b.Fatalf("place bid %d: code=%s want %s", i, code, model.CodeOKAccepted)
		}
	}
}
