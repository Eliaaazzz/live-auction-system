package store

import (
	"errors"
	"fmt"
	"testing"

	"github.com/redis/go-redis/v9"
)

// Hidden tests for collectStreamEvents (bounded-chunk catchup paging). They run
// WITHOUT Redis by injecting a fake XRANGE-N. The landmine these guard is the
// chunk SEAM: we re-include the previous chunk's last id inclusively (no Redis
// 6.2 "(") and skip it via seq<=lastSeq, so a paged read MUST return every event
// exactly once with no gap and no duplicate — anything else corrupts catchup
// (and would make the gateway seq-guard false-positive or drop frames).

func mkEvents(n int) []redis.XMessage {
	out := make([]redis.XMessage, n)
	for i := 0; i < n; i++ {
		seq := i + 1
		out[i] = redis.XMessage{
			ID: fmt.Sprintf("%d-0", seq),
			Values: map[string]interface{}{
				"seq":     fmt.Sprintf("%d", seq),
				"type":    "BID_ACCEPTED",
				"payload": fmt.Sprintf(`{"seq":%d}`, seq),
			},
		}
	}
	return out
}

// fakeStream mimics XRANGE-N: inclusive lower bound by seq, capped at count.
type fakeStream struct {
	msgs  []redis.XMessage
	calls int
	errAt int // return an error on the errAt-th call (0 = never)
}

func (f *fakeStream) fetch(start string, count int64) ([]redis.XMessage, error) {
	f.calls++
	if f.errAt > 0 && f.calls == f.errAt {
		return nil, errors.New("boom")
	}
	startSeq := streamIDSeq(start) // "-" -> 0, "k-0" -> k
	var out []redis.XMessage
	for _, m := range f.msgs {
		if parseInt(valStr(m.Values, "seq")) >= startSeq {
			out = append(out, m)
			if int64(len(out)) >= count {
				break
			}
		}
	}
	return out, nil
}

// assertContiguous checks the result is exactly seqs (lo..hi) inclusive, once each.
func assertContiguous(t *testing.T, out []StreamEvent, lo, hi int64) {
	t.Helper()
	if int64(len(out)) != hi-lo+1 {
		t.Fatalf("got %d events, want %d (seqs %d..%d)", len(out), hi-lo+1, lo, hi)
	}
	want := lo
	for i, e := range out {
		if e.Seq != want {
			t.Fatalf("event[%d].Seq=%d, want %d (gap/dup/disorder at seam)", i, e.Seq, want)
		}
		want++
	}
}

func TestCollectStreamEvents_Empty(t *testing.T) {
	out, last, err := collectStreamEvents("", 1000, (&fakeStream{}).fetch)
	if err != nil || len(out) != 0 || last != "" {
		t.Fatalf("empty: out=%d last=%q err=%v", len(out), last, err)
	}
}

func TestCollectStreamEvents_SingleChunk(t *testing.T) {
	f := &fakeStream{msgs: mkEvents(5)}
	out, last, err := collectStreamEvents("", 1000, f.fetch)
	if err != nil {
		t.Fatal(err)
	}
	assertContiguous(t, out, 1, 5)
	if last != "5-0" {
		t.Fatalf("newLast=%q want 5-0", last)
	}
}

func TestCollectStreamEvents_LastIDMidStream(t *testing.T) {
	f := &fakeStream{msgs: mkEvents(5)}
	out, _, err := collectStreamEvents("3-0", 1000, f.fetch)
	if err != nil {
		t.Fatal(err)
	}
	assertContiguous(t, out, 4, 5) // strictly after seq 3
}

func TestCollectStreamEvents_MultiChunkNoSeamDup(t *testing.T) {
	// Exact multiple AND non-multiple AND a brutally small chunk that maximises
	// seam re-reads — all must yield each event exactly once, in order.
	for _, tc := range []struct {
		n, chunk int
	}{
		{2000, 1000}, // exact multiple of chunk
		{2500, 1000}, // non-multiple
		{7, 2},       // tiny chunk => every iteration straddles a seam
		{1, 2},       // single event
		{100, 3},     // odd chunk
	} {
		f := &fakeStream{msgs: mkEvents(tc.n)}
		out, last, err := collectStreamEvents("", tc.chunk, f.fetch)
		if err != nil {
			t.Fatalf("n=%d chunk=%d: %v", tc.n, tc.chunk, err)
		}
		assertContiguous(t, out, 1, int64(tc.n))
		if want := fmt.Sprintf("%d-0", tc.n); last != want {
			t.Fatalf("n=%d chunk=%d: newLast=%q want %q", tc.n, tc.chunk, last, want)
		}
	}
}

func TestCollectStreamEvents_ChunkClampedNoDataLoss(t *testing.T) {
	// chunk < 2 must be clamped to 2 (chunk=1 cannot advance the cursor and would
	// silently lose every event past the first).
	f := &fakeStream{msgs: mkEvents(5)}
	out, _, err := collectStreamEvents("", 1, f.fetch)
	if err != nil {
		t.Fatal(err)
	}
	assertContiguous(t, out, 1, 5)
}

func TestCollectStreamEvents_ErrorPropagates(t *testing.T) {
	f := &fakeStream{msgs: mkEvents(3000), errAt: 2} // fail mid-paging
	out, last, err := collectStreamEvents("", 1000, f.fetch)
	if err == nil {
		t.Fatal("want error from mid-paging fetch failure")
	}
	if out != nil || last != "" {
		t.Fatalf("on error want (nil, lastID, err); got out=%d last=%q", len(out), last)
	}
}
