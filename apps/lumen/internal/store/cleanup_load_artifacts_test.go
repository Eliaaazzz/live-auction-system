package store

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestCleanupLoadArtifactsDryRunAndExecute(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	prefix := "auc_load_cleanup_"
	loadAid := prefix + suffix
	activeOnlyAid := prefix + "active_" + suffix
	demoAid := "auc_demo_cleanup_" + suffix
	loadDedupeKey := dedupeKey(loadAid, "u1")

	t.Cleanup(func() {
		keys := []string{
			stateKey(loadAid), streamKey(loadAid), loadDedupeKey,
			stateKey(demoAid), streamKey(demoAid),
		}
		_ = s.rdb.Del(context.Background(), keys...).Err()
		_ = s.rdb.ZRem(context.Background(), activeKey, loadAid, activeOnlyAid, demoAid).Err()
	})

	if err := s.rdb.HSet(ctx, stateKey(loadAid), "status", "LIVE").Err(); err != nil {
		t.Fatal(err)
	}
	if err := s.rdb.XAdd(ctx, &redis.XAddArgs{
		Stream: streamKey(loadAid),
		Values: map[string]interface{}{"type": "TEST"},
	}).Err(); err != nil {
		t.Fatal(err)
	}
	if err := s.rdb.Set(ctx, loadDedupeKey, "1", 0).Err(); err != nil {
		t.Fatal(err)
	}
	if err := s.rdb.HSet(ctx, stateKey(demoAid), "status", "LIVE").Err(); err != nil {
		t.Fatal(err)
	}
	if err := s.rdb.XAdd(ctx, &redis.XAddArgs{
		Stream: streamKey(demoAid),
		Values: map[string]interface{}{"type": "TEST"},
	}).Err(); err != nil {
		t.Fatal(err)
	}
	if err := s.rdb.ZAdd(ctx, activeKey,
		redis.Z{Score: 1, Member: loadAid},
		redis.Z{Score: 2, Member: activeOnlyAid},
		redis.Z{Score: 3, Member: demoAid},
	).Err(); err != nil {
		t.Fatal(err)
	}

	res, err := s.CleanupLoadArtifacts(ctx, prefix, false)
	if err != nil {
		t.Fatal(err)
	}
	wantAIDs := []string{activeOnlyAid, loadAid}
	sort.Strings(wantAIDs)
	if !reflect.DeepEqual(res.AuctionIDs, wantAIDs) {
		t.Fatalf("dry-run auction ids=%v want %v", res.AuctionIDs, wantAIDs)
	}
	wantKeys := []string{loadDedupeKey, stateKey(loadAid), streamKey(loadAid)}
	sort.Strings(wantKeys)
	if !reflect.DeepEqual(res.Keys, wantKeys) {
		t.Fatalf("dry-run keys=%v want %v", res.Keys, wantKeys)
	}
	if res.Execute || res.DeletedKeys != 0 || res.Untracked != 0 {
		t.Fatalf("dry-run result mutated counters: %+v", res)
	}
	assertRedisKeyExists(t, s, stateKey(loadAid))
	assertActiveMember(t, s, loadAid, true)

	if _, err := s.CleanupLoadArtifacts(ctx, "auc_demo_cleanup_", false); err == nil || !strings.Contains(err.Error(), "must start with auc_load_") {
		t.Fatalf("unsafe prefix error=%v, want rejection", err)
	}

	res, err = s.CleanupLoadArtifacts(ctx, prefix, true)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Execute || res.DeletedKeys != int64(len(wantKeys)) || res.Untracked != 2 {
		t.Fatalf("execute result=%+v, want deleted=%d untracked=2", res, len(wantKeys))
	}
	for _, key := range wantKeys {
		assertRedisKeyExists(t, s, key, false)
	}
	assertActiveMember(t, s, loadAid, false)
	assertActiveMember(t, s, activeOnlyAid, false)
	assertRedisKeyExists(t, s, stateKey(demoAid))
	assertActiveMember(t, s, demoAid, true)
}

func assertRedisKeyExists(t *testing.T, s *Store, key string, want ...bool) {
	t.Helper()
	expected := true
	if len(want) > 0 {
		expected = want[0]
	}
	got, err := s.rdb.Exists(context.Background(), key).Result()
	if err != nil {
		t.Fatal(err)
	}
	if (got > 0) != expected {
		t.Fatalf("exists(%s)=%v want %v", key, got > 0, expected)
	}
}

func assertActiveMember(t *testing.T, s *Store, aid string, want bool) {
	t.Helper()
	_, err := s.rdb.ZScore(context.Background(), activeKey, aid).Result()
	got := err == nil
	if err != nil && !errors.Is(err, redis.Nil) {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("active member %s=%v want %v", aid, got, want)
	}
}
