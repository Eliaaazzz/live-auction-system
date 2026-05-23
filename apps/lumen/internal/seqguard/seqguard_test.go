package seqguard

import "testing"

// In-order events are all applied and advance the cursor.
func TestApplyInOrder(t *testing.T) {
	g := New(0)
	for s := int64(1); s <= 5; s++ {
		if !g.Apply(s) {
			t.Fatalf("seq %d should be applied", s)
		}
		if g.Last() != s {
			t.Fatalf("Last()=%d want %d", g.Last(), s)
		}
	}
}

// The classic T2 case: a bidder gets its direct ack AND the Pub/Sub broadcast of
// the same seq. The duplicate must be dropped.
func TestApplyDropsDuplicate(t *testing.T) {
	g := New(0)
	if !g.Apply(7) {
		t.Fatal("first seq 7 should apply")
	}
	if g.Apply(7) {
		t.Fatal("duplicate seq 7 should be dropped")
	}
	if g.Last() != 7 {
		t.Fatalf("Last()=%d want 7", g.Last())
	}
}

// Out-of-order (a frame older than the cursor) is dropped without rewinding.
func TestApplyDropsOutOfOrder(t *testing.T) {
	g := New(10)
	if g.Apply(3) {
		t.Fatal("stale seq 3 should be dropped")
	}
	if g.Last() != 10 {
		t.Fatalf("cursor moved on stale frame: Last()=%d want 10", g.Last())
	}
	if !g.Apply(11) {
		t.Fatal("seq 11 should apply after the stale drop")
	}
}

// Forward jumps are applied (Apply never blocks); Gap reports the hole.
func TestApplyForwardJump(t *testing.T) {
	g := New(5)
	if got := g.Gap(9); got != 3 { // 6,7,8 skipped
		t.Fatalf("Gap(9)=%d want 3", got)
	}
	if !g.Apply(9) {
		t.Fatal("forward jump should still apply")
	}
	if g.Last() != 9 {
		t.Fatalf("Last()=%d want 9", g.Last())
	}
}

// seq<=0 are unordered control frames: always applied, cursor untouched.
func TestApplyControlFrames(t *testing.T) {
	g := New(4)
	for _, s := range []int64{0, -1} {
		if !g.Apply(s) {
			t.Fatalf("control frame seq=%d should apply", s)
		}
	}
	if g.Last() != 4 {
		t.Fatalf("control frame moved cursor: Last()=%d want 4", g.Last())
	}
}

func TestGapContiguousAndStale(t *testing.T) {
	g := New(5)
	if got := g.Gap(6); got != 0 { // next contiguous event
		t.Fatalf("Gap(6)=%d want 0", got)
	}
	if got := g.Gap(5); got != 0 { // duplicate
		t.Fatalf("Gap(5)=%d want 0", got)
	}
	if got := g.Gap(2); got != 0 { // stale
		t.Fatalf("Gap(2)=%d want 0", got)
	}
	if got := g.Gap(0); got != 0 { // control
		t.Fatalf("Gap(0)=%d want 0", got)
	}
}

// New clamps a negative prime to 0 (defensive against bad snapshot data).
func TestNewClampsNegative(t *testing.T) {
	g := New(-3)
	if g.Last() != 0 {
		t.Fatalf("New(-3).Last()=%d want 0", g.Last())
	}
	if !g.Apply(1) {
		t.Fatal("seq 1 should apply after negative prime is clamped")
	}
}

// Reconnect: priming with the last-seen seq drops the replay of already-applied
// events and resumes at the first new one — "reconnect final state == snapshot".
func TestReconnectResumes(t *testing.T) {
	g := New(200)
	for s := int64(198); s <= 200; s++ { // replayed tail
		if g.Apply(s) {
			t.Fatalf("replayed seq %d should be dropped", s)
		}
	}
	if !g.Apply(201) {
		t.Fatal("first new seq 201 should apply")
	}
}
