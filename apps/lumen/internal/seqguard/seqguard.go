// Package seqguard is the client-side ordering guard for the per-auction event
// log. Every accepted event carries a monotonic `seq` (no gap, RFC v2). A client
// applies events strictly in order, dropping duplicates and out-of-order frames
// — the originating bidder, for example, receives both a direct ack and the
// Pub/Sub broadcast of the same BID_ACCEPTED and must apply it once.
//
// This Go implementation is the reference + CI-gated spec; web/room.html mirrors
// it in JS for the browser client (V9 §4.1 `seq-guard`). Gap-driven snapshot
// fallback (gap > 200 → ROOM_SNAPSHOT) is wired at T5; Gap() exposes the signal.
package seqguard

// Guard tracks the last applied seq for one room. The zero value is ready to use
// (lastSeq 0 — the first real event is seq 1). It is not safe for concurrent use;
// a WS client applies frames from a single read loop.
type Guard struct {
	last int64
}

// New returns a Guard primed with the last seq the client already has (e.g. from
// a ROOM_SNAPSHOT or a previous session before reconnect). Negative values are
// treated as 0.
func New(lastSeq int64) *Guard {
	if lastSeq < 0 {
		lastSeq = 0
	}
	return &Guard{last: lastSeq}
}

// Apply reports whether the event with sequence s should be applied to client
// state, advancing the cursor when it should.
//
//   - s <= 0: an unordered control frame (PONG, BID_REJECTED, ROOM_SNAPSHOT
//     carrying seq 0) — always applied, cursor untouched.
//   - s <= last: a duplicate or out-of-order frame — dropped.
//   - s > last: applied; the cursor advances to s.
//
// A forward jump (s > last+1) is still applied — Apply never blocks on a gap;
// use Gap to decide whether to also request catchup/snapshot (T5).
func (g *Guard) Apply(s int64) bool {
	if s <= 0 {
		return true
	}
	if s <= g.last {
		return false
	}
	g.last = s
	return true
}

// Gap returns how many events would be skipped by jumping to seq s from the
// current cursor (s - last - 1), or 0 if s is the next contiguous event or a
// duplicate/out-of-order/control frame. T5 uses gap > 200 → snapshot fallback.
//
// Compares with `s <= g.last` rather than `s > g.last+1` so it does not overflow
// when g.last == math.MaxInt64 (a duplicate at max-int must report 0, not -1).
// g.last is always >= 0, so s - g.last - 1 cannot overflow for any valid s.
func (g *Guard) Gap(s int64) int64 {
	if s <= g.last {
		return 0
	}
	return s - g.last - 1
}

// Last returns the highest applied sequence.
func (g *Guard) Last() int64 { return g.last }
