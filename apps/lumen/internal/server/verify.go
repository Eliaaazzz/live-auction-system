package server

import (
	"context"
	"fmt"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/config"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

// RunVerify is the T6 unified Replay Verifier (issue #1 §10 T6).
//
// Three-way diff across the durable surfaces:
//
//   - Redis Stream `stream:{aid}` (canonical event log)
//   - MySQL `auction_events` (idempotent projection)
//   - Redis snapshot `state:{aid}` (room sync tip)
//
// Plus a hash-chain integrity recompute (the T4 check) so any post-hoc
// tampering of payload/hash rows surfaces as hash_break_at_seq.
//
// One-line, machine-parseable output (stdout):
//
//   consistent: stream=N mysql=N snapshot_seq=S (auction=X)
//   mismatch_at_seq=N (stream=A mysql=B snapshot_seq=C, auction=X): <reason>
//   hash_break_at_seq=N (events=N, auction=X)
//
// Exit code: 0 = consistent, 1 = any mismatch or chain break.
//
// Usage notes:
//
//   - Intended to run AFTER an auction has settled (SOLD/CANCELLED/NO_BID).
//     During in-flight LIVE auctions the projection worker may legitimately
//     trail the Stream by a few events; the verifier is strict and will
//     flag that as mismatch_at_seq.
//   - The hash-chain check is byte-exact against the MySQL-normalized
//     payload_json (see proto/evidence-card.md §6 once that lands; the
//     algorithm is HMAC-SHA256 over "prev_hash\nseq\nevent_type\npayload").
//     It only runs when the upstream count/seq pass — otherwise the data
//     we'd be hashing is already known wrong, and re-reporting it as a hash
//     break would just mask the upstream mismatch.
func RunVerify(ctx context.Context, cfg config.Config, aid string) error {
	if aid == "" {
		aid = "auc_demo"
	}
	st, err := store.New(ctx, cfg.RedisAddr, cfg.MySQLDSN, cfg.EvidenceHMACKey)
	if err != nil {
		return err
	}
	defer st.Close()

	rep, err := computeVerifyReport(ctx, st, aid)
	if err != nil {
		return err
	}
	emitVerifyReport(rep)
	if !rep.Consistent() {
		return fmt.Errorf("verify: %s (auction=%s)", rep.shortReason(), rep.AID)
	}
	return nil
}

// RunVerifyEvidence is the focused T4 hash-chain-only check. Kept as a separate
// subcommand because operators sometimes want to verify integrity without paying
// for the stream/MySQL/snapshot round-trip (e.g. a periodic background scan).
// The unified `verify` subcommand subsumes this for the T6 acceptance gate.
func RunVerifyEvidence(ctx context.Context, cfg config.Config, aid string) error {
	if aid == "" {
		aid = "auc_demo"
	}
	st, err := store.New(ctx, cfg.RedisAddr, cfg.MySQLDSN, cfg.EvidenceHMACKey)
	if err != nil {
		return err
	}
	defer st.Close()

	ok, breakAtSeq, err := st.VerifyEvidenceChain(ctx, aid)
	if err != nil {
		return fmt.Errorf("verify evidence chain: %w", err)
	}
	n, _ := st.CountEvents(ctx, aid)
	if !ok {
		fmt.Printf("hash_break_at_seq=%d (events=%d, auction=%s)\n", breakAtSeq, n, aid)
		return fmt.Errorf("evidence chain broken at seq=%d (auction=%s)", breakAtSeq, aid)
	}
	fmt.Printf("evidence chain consistent: events=%d (auction=%s)\n", n, aid)
	return nil
}

// VerifyReport is the structured output of one RunVerify pass. Exported so
// future hooks (CI dashboards, an HTTP `/admin/verify` endpoint) can render
// the same fields without re-scraping stdout.
type VerifyReport struct {
	AID            string
	StreamCount    int
	MySQLCount     int
	SnapshotSeq    int64
	StreamTipSeq   int64
	MismatchAtSeq  int64
	MismatchReason string
	HashBreakAtSeq int64
}

// Consistent returns true when neither the three-way diff nor the hash chain
// flagged a problem.
func (r VerifyReport) Consistent() bool {
	return r.MismatchAtSeq == 0 && r.HashBreakAtSeq == 0
}

// shortReason returns the first failing condition for the error returned by
// RunVerify (so the test framework / make verify exit log is grep-friendly).
func (r VerifyReport) shortReason() string {
	switch {
	case r.HashBreakAtSeq != 0:
		return fmt.Sprintf("hash_break_at_seq=%d", r.HashBreakAtSeq)
	case r.MismatchAtSeq != 0:
		return fmt.Sprintf("mismatch_at_seq=%d", r.MismatchAtSeq)
	default:
		return "consistent"
	}
}

// emitVerifyReport prints one of the three machine-parseable status lines.
func emitVerifyReport(r VerifyReport) {
	switch {
	case r.HashBreakAtSeq != 0:
		fmt.Printf("hash_break_at_seq=%d (events=%d, auction=%s)\n",
			r.HashBreakAtSeq, r.MySQLCount, r.AID)
	case r.MismatchAtSeq != 0:
		fmt.Printf("mismatch_at_seq=%d (stream=%d mysql=%d snapshot_seq=%d, auction=%s): %s\n",
			r.MismatchAtSeq, r.StreamCount, r.MySQLCount, r.SnapshotSeq, r.AID, r.MismatchReason)
	default:
		fmt.Printf("consistent: stream=%d mysql=%d snapshot_seq=%d (auction=%s)\n",
			r.StreamCount, r.MySQLCount, r.SnapshotSeq, r.AID)
	}
}

// computeVerifyReport gathers the three durable surfaces + hash check.
// Surface order is intentional: cheapest (snapshot) → stream → MySQL →
// chain. Aborts on the first transport error so a flaky verifier never
// reports a fake mismatch.
func computeVerifyReport(ctx context.Context, st *store.Store, aid string) (VerifyReport, error) {
	rep := VerifyReport{AID: aid}

	snap, err := st.Snapshot(ctx, aid)
	if err != nil {
		return rep, fmt.Errorf("snapshot: %w", err)
	}
	rep.SnapshotSeq = snap.Seq

	streamEvents, _, err := st.ReadEventsAfter(ctx, aid, "")
	if err != nil {
		return rep, fmt.Errorf("read stream: %w", err)
	}
	rep.StreamCount = len(streamEvents)
	if rep.StreamCount > 0 {
		rep.StreamTipSeq = streamEvents[rep.StreamCount-1].Seq
	}

	timeline, err := st.EventTimeline(ctx, aid)
	if err != nil {
		return rep, fmt.Errorf("event timeline: %w", err)
	}
	rep.MySQLCount = len(timeline)

	rep.MismatchAtSeq, rep.MismatchReason = findMismatch(streamEvents, timeline, snap.Seq)
	if rep.MismatchAtSeq != 0 {
		return rep, nil // skip the chain check when upstream is already off
	}

	ok, breakAtSeq, err := st.VerifyEvidenceChain(ctx, aid)
	if err != nil {
		return rep, fmt.Errorf("verify evidence chain: %w", err)
	}
	if !ok {
		rep.HashBreakAtSeq = breakAtSeq
	}
	return rep, nil
}

// findMismatch walks the Stream and MySQL projection side-by-side in seq order
// and returns the first seq where they diverge (0 means agree). It then checks
// the snapshot tip seq against the stream tip — a non-zero snapshot seq that
// doesn't match the stream tip is treated as mismatch_at_seq=stream_tip.
// (Snapshot seq=0 with non-empty stream is allowed: state hash may have
// expired/been cleared after settlement.)
//
// Payload bytes are NOT compared here. The Stream payload is the raw cjson
// output from place_bid.lua; the MySQL payload_json is MySQL's normalized
// JSON form. They are semantically equal but not byte-equal — comparing them
// here would false-positive. Payload integrity is the job of the hash chain
// (storedb.VerifyEvidenceChain), which hashes the MySQL-normalized form
// canonically.
func findMismatch(stream []store.StreamEvent, db []store.EvidenceEvent, snapshotSeq int64) (int64, string) {
	i, j := 0, 0
	for i < len(stream) && j < len(db) {
		s, d := stream[i], db[j]
		switch {
		case s.Seq < d.Seq:
			return s.Seq, fmt.Sprintf("stream has seq=%d but MySQL projection does not", s.Seq)
		case d.Seq < s.Seq:
			return d.Seq, fmt.Sprintf("MySQL has seq=%d but Stream does not", d.Seq)
		case s.Type != d.EventType:
			return s.Seq, fmt.Sprintf("event_type mismatch at seq=%d: stream=%q mysql=%q", s.Seq, s.Type, d.EventType)
		}
		i++
		j++
	}
	if i < len(stream) {
		return stream[i].Seq, fmt.Sprintf("stream extends past MySQL projection at seq=%d", stream[i].Seq)
	}
	if j < len(db) {
		return db[j].Seq, fmt.Sprintf("MySQL projection extends past Stream at seq=%d", db[j].Seq)
	}

	// Snapshot tip vs stream tip — only if snapshot is present (non-zero).
	if snapshotSeq > 0 && len(stream) > 0 {
		tip := stream[len(stream)-1].Seq
		if snapshotSeq != tip {
			return tip, fmt.Sprintf("snapshot seq=%d does not match stream tip seq=%d", snapshotSeq, tip)
		}
	}
	return 0, ""
}
