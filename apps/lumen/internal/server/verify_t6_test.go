package server

// T6 unified Replay Verifier — three-way diff (Stream / MySQL / snapshot) plus
// hash-chain recompute. Unit cases cover findMismatch with synthetic slices
// (no datastore needed); integration cases drive RunVerify end-to-end against
// the same fullStore used by the T4 evidence tests and skip when Redis/MySQL
// aren't reachable.
//
// Acceptance contract (issue #1 §10 T6):
//   make verify → "consistent: ..." (exit 0)
//                "mismatch_at_seq=N ..." (exit != 0)
//                "hash_break_at_seq=N ..." (exit != 0)

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

// ─── Unit: findMismatch ───────────────────────────────────────────────

// TC-T6-V01 — Stream and MySQL agree, snapshot tracks the tip → no mismatch.
func TestFindMismatch_Consistent(t *testing.T) {
	stream := []store.StreamEvent{
		{Seq: 1, Type: model.TypeBidAccepted},
		{Seq: 2, Type: model.TypeAuctionSold},
	}
	db := []store.EvidenceEvent{
		{Seq: 1, EventType: model.TypeBidAccepted},
		{Seq: 2, EventType: model.TypeAuctionSold},
	}
	if seq, reason := findMismatch(stream, db, 2); seq != 0 || reason != "" {
		t.Fatalf("want consistent, got seq=%d reason=%q", seq, reason)
	}
}

// TC-T6-V02 — Stream has a seq the projection missed (most common drift:
// persistence worker lagged or crashed mid-projection).
func TestFindMismatch_StreamAheadOfMySQL(t *testing.T) {
	stream := []store.StreamEvent{
		{Seq: 1, Type: model.TypeBidAccepted},
		{Seq: 2, Type: model.TypeBidAccepted},
		{Seq: 3, Type: model.TypeAuctionSold},
	}
	db := []store.EvidenceEvent{
		{Seq: 1, EventType: model.TypeBidAccepted},
		{Seq: 3, EventType: model.TypeAuctionSold}, // seq 2 missing
	}
	seq, reason := findMismatch(stream, db, 3)
	if seq != 2 {
		t.Fatalf("want mismatch_at_seq=2, got %d (%s)", seq, reason)
	}
	if !strings.Contains(reason, "MySQL projection does not") {
		t.Fatalf("reason should name MySQL missing, got %q", reason)
	}
}

// TC-T6-V03 — Symmetric: MySQL has a seq Stream lost (e.g. stream trimmed
// past MAXLEN before persistence wrote, then verifier ran without re-seeding).
func TestFindMismatch_MySQLAheadOfStream(t *testing.T) {
	stream := []store.StreamEvent{
		{Seq: 1, Type: model.TypeBidAccepted},
	}
	db := []store.EvidenceEvent{
		{Seq: 1, EventType: model.TypeBidAccepted},
		{Seq: 2, EventType: model.TypeAuctionSold},
	}
	seq, reason := findMismatch(stream, db, 0)
	if seq != 2 {
		t.Fatalf("want mismatch_at_seq=2, got %d (%s)", seq, reason)
	}
	if !strings.Contains(reason, "Stream") {
		t.Fatalf("reason should name Stream, got %q", reason)
	}
}

// TC-T6-V04 — Same seq, divergent event_type (operator surgery, projection bug).
func TestFindMismatch_TypeDivergence(t *testing.T) {
	stream := []store.StreamEvent{
		{Seq: 1, Type: model.TypeBidAccepted},
	}
	db := []store.EvidenceEvent{
		{Seq: 1, EventType: model.TypeAuctionCancelled},
	}
	seq, reason := findMismatch(stream, db, 1)
	if seq != 1 || !strings.Contains(reason, "event_type mismatch") {
		t.Fatalf("want type-mismatch at seq=1, got %d (%s)", seq, reason)
	}
}

// TC-T6-V05 — Snapshot trails the stream tip (state hash refresh lost a beat).
// The verifier flags this at the stream-tip seq.
func TestFindMismatch_SnapshotBehindStreamTip(t *testing.T) {
	stream := []store.StreamEvent{
		{Seq: 1, Type: model.TypeBidAccepted},
		{Seq: 2, Type: model.TypeAuctionSold},
	}
	db := []store.EvidenceEvent{
		{Seq: 1, EventType: model.TypeBidAccepted},
		{Seq: 2, EventType: model.TypeAuctionSold},
	}
	seq, reason := findMismatch(stream, db, 1) // snapshot says we're at seq=1
	if seq != 2 {
		t.Fatalf("want mismatch at tip=2, got %d (%s)", seq, reason)
	}
	if !strings.Contains(reason, "snapshot seq=1") {
		t.Fatalf("reason should reference snapshot seq, got %q", reason)
	}
}

// TC-T6-V06 — Snapshot cleared (seq=0) post-settlement is tolerated. The state
// hash may have TTL'd; that's a Redis lifecycle concern, not a Stream/MySQL
// divergence — don't false-alarm a settled auction.
func TestFindMismatch_ClearedSnapshotIgnored(t *testing.T) {
	stream := []store.StreamEvent{
		{Seq: 1, Type: model.TypeBidAccepted},
		{Seq: 2, Type: model.TypeAuctionSold},
	}
	db := []store.EvidenceEvent{
		{Seq: 1, EventType: model.TypeBidAccepted},
		{Seq: 2, EventType: model.TypeAuctionSold},
	}
	if seq, reason := findMismatch(stream, db, 0); seq != 0 {
		t.Fatalf("snapshotSeq=0 should be tolerated, got %d (%s)", seq, reason)
	}
}

// TC-T6-V07 — Empty auction (no events at all) is consistent by definition.
// Common during pre-LIVE windows; verifier shouldn't crash on the empty case.
func TestFindMismatch_EmptyAuction(t *testing.T) {
	if seq, _ := findMismatch(nil, nil, 0); seq != 0 {
		t.Fatalf("empty auction should be consistent, got %d", seq)
	}
}

// ─── Unit: VerifyReport surface ───────────────────────────────────────

func TestVerifyReport_ConsistentAndReason(t *testing.T) {
	ok := VerifyReport{StreamCount: 3, MySQLCount: 3, SnapshotSeq: 3}
	if !ok.Consistent() || ok.shortReason() != "consistent" {
		t.Fatalf("consistent report misclassified: %+v", ok)
	}
	mismatch := VerifyReport{MismatchAtSeq: 5}
	if mismatch.Consistent() {
		t.Fatal("mismatch report should not be Consistent()")
	}
	if mismatch.shortReason() != "mismatch_at_seq=5" {
		t.Fatalf("shortReason=%q want mismatch_at_seq=5", mismatch.shortReason())
	}
	broken := VerifyReport{HashBreakAtSeq: 7}
	if broken.shortReason() != "hash_break_at_seq=7" {
		t.Fatalf("shortReason=%q want hash_break_at_seq=7", broken.shortReason())
	}
}

// ─── Integration: full RunVerify against Redis + MySQL ────────────────

// seedT6 inserts n identical events into BOTH the Redis Stream and the MySQL
// projection, then sets the snapshot tip to n. Mirrors what a healthy
// persistence worker leaves behind.
func seedT6(t *testing.T, st *store.Store, aid string, n int) {
	t.Helper()
	ctx := context.Background()
	t.Cleanup(func() {
		_, _ = st.DB().ExecContext(context.Background(), "DELETE FROM auction_events WHERE auction_id=?", aid)
		if keys, _ := st.Redis().Keys(ctx, "auction:{"+aid+"}:*").Result(); len(keys) > 0 {
			_ = st.Redis().Del(ctx, keys...).Err()
		}
		_ = st.Redis().Del(ctx, "stream:"+aid, "state:"+aid).Err()
	})
	for seq := 1; seq <= n; seq++ {
		payload := fmt.Sprintf(`{"seq":%d,"amountCents":"%d"}`, seq, 10000+seq*100)
		if err := st.InsertEvent(ctx, aid, int64(seq), model.TypeBidAccepted, payload); err != nil {
			t.Fatalf("insert mysql seq=%d: %v", seq, err)
		}
		if err := st.Redis().XAdd(ctx, &redis.XAddArgs{
			Stream: "stream:" + aid,
			ID:     fmt.Sprintf("%d-0", seq),
			Values: map[string]any{
				"seq":     fmt.Sprintf("%d", seq),
				"type":    model.TypeBidAccepted,
				"payload": payload,
			},
		}).Err(); err != nil {
			t.Fatalf("xadd seq=%d: %v", seq, err)
		}
	}
	if err := st.Redis().HSet(ctx, "state:"+aid, "seq", fmt.Sprintf("%d", n)).Err(); err != nil {
		t.Fatalf("hset snapshot seq: %v", err)
	}
}

// TC-T6-I01 — seeded auction passes the unified verifier (consistent path).
func TestRunVerify_T6_Consistent(t *testing.T) {
	st := fullStore(t)
	aid := fmt.Sprintf("test_t6_consistent_%d", time.Now().UnixNano())
	seedT6(t, st, aid, 3)

	rep, err := computeVerifyReport(context.Background(), st, aid)
	if err != nil {
		t.Fatal(err)
	}
	if !rep.Consistent() {
		t.Fatalf("want consistent, got %+v", rep)
	}
	if rep.StreamCount != 3 || rep.MySQLCount != 3 || rep.SnapshotSeq != 3 {
		t.Fatalf("counts wrong: %+v", rep)
	}
}

// TC-T6-I02 — stream extends past MySQL projection (the most common in-flight
// drift: persistence worker stopped after writing the Stream but before
// projecting to MySQL). Acceptance: mismatch_at_seq is the missing seq.
func TestRunVerify_T6_StreamAheadMismatch(t *testing.T) {
	st := fullStore(t)
	ctx := context.Background()
	aid := fmt.Sprintf("test_t6_stream_ahead_%d", time.Now().UnixNano())
	seedT6(t, st, aid, 2)

	// Add one extra event to the Stream (and bump snapshot tip to match) without
	// projecting to MySQL — simulates the persistence-worker-lag scenario.
	extraSeq := 3
	if err := st.Redis().XAdd(ctx, &redis.XAddArgs{
		Stream: "stream:" + aid,
		ID:     fmt.Sprintf("%d-0", extraSeq),
		Values: map[string]any{"seq": fmt.Sprintf("%d", extraSeq), "type": model.TypeAuctionSold, "payload": `{"seq":3}`},
	}).Err(); err != nil {
		t.Fatal(err)
	}
	if err := st.Redis().HSet(ctx, "state:"+aid, "seq", fmt.Sprintf("%d", extraSeq)).Err(); err != nil {
		t.Fatal(err)
	}

	rep, err := computeVerifyReport(ctx, st, aid)
	if err != nil {
		t.Fatal(err)
	}
	if rep.MismatchAtSeq != int64(extraSeq) {
		t.Fatalf("want mismatch_at_seq=%d, got %+v", extraSeq, rep)
	}
	if rep.HashBreakAtSeq != 0 {
		t.Fatalf("hash check should be skipped on upstream mismatch, got break=%d", rep.HashBreakAtSeq)
	}
	if rep.Consistent() {
		t.Fatal("should not be consistent")
	}
}

// TC-T6-I03 — tampered payload in MySQL breaks the chain. Same threat model as
// T4 TestT4HashChainTamperBreaksAtSeq, but proves the unified verifier surfaces
// it via VerifyReport.HashBreakAtSeq (not the older error-return shape).
func TestRunVerify_T6_HashBreak(t *testing.T) {
	st := fullStore(t)
	ctx := context.Background()
	aid := fmt.Sprintf("test_t6_break_%d", time.Now().UnixNano())
	seedT6(t, st, aid, 3)

	// Tamper seq 2's payload directly. Counts stay equal (no upstream mismatch),
	// so the chain check runs and finds the break.
	if _, err := st.DB().ExecContext(ctx,
		`UPDATE auction_events SET payload_json=? WHERE auction_id=? AND seq=2`,
		`{"seq":2,"amountCents":"999999"}`, aid); err != nil {
		t.Fatal(err)
	}

	rep, err := computeVerifyReport(ctx, st, aid)
	if err != nil {
		t.Fatal(err)
	}
	if rep.HashBreakAtSeq != 2 {
		t.Fatalf("want hash_break_at_seq=2, got %+v", rep)
	}
	if rep.MismatchAtSeq != 0 {
		t.Fatalf("counts agree, mismatch should be 0, got %d", rep.MismatchAtSeq)
	}
}

// TC-T6-I04 — snapshot.Seq trails the stream tip. Treated as a soft sync gap
// (state hash refresh dropped a beat); RunVerify still flags it because demo
// freeze + replay want a tight invariant.
func TestRunVerify_T6_SnapshotTrails(t *testing.T) {
	st := fullStore(t)
	ctx := context.Background()
	aid := fmt.Sprintf("test_t6_snap_trail_%d", time.Now().UnixNano())
	seedT6(t, st, aid, 3)

	// Rewind snapshot.seq to 1 while Stream + MySQL agree at tip=3.
	if err := st.Redis().HSet(ctx, "state:"+aid, "seq", "1").Err(); err != nil {
		t.Fatal(err)
	}

	rep, err := computeVerifyReport(ctx, st, aid)
	if err != nil {
		t.Fatal(err)
	}
	if rep.MismatchAtSeq != 3 {
		t.Fatalf("want mismatch_at_seq=3 (stream tip), got %+v", rep)
	}
}
