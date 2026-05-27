package server

// T5 tests: the backpressure channel split (critical force-close vs lossy frame-drop)
// and multi-gateway fanout (two independent hubs each fan out the canonical Stream to
// their own room members). The backpressure cases are pure-Conn unit tests (no infra);
// the fanout case needs Redis (fullStore).

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

// A full CRITICAL lane force-closes the connection (client reconnects + re-syncs)
// rather than silently dropping a bid ack / terminal event.
func TestT5BackpressureCriticalDropsConn(t *testing.T) {
	c := &Conn{send: make(chan []byte, 2), lossy: make(chan []byte, 2), done: make(chan struct{})}
	c.trySend([]byte("a"))
	c.trySend([]byte("b")) // fills the critical buffer (cap 2)
	c.trySend([]byte("c")) // full → force-close

	select {
	case <-c.done: // closed, as expected
	default:
		t.Fatal("a full critical lane must force-close the connection")
	}
}

// A full LOSSY lane drops the overflow frame but keeps the connection — a slow client
// is never force-closed over a replaceable frame (e.g. a heartbeat).
func TestT5BackpressureLossyDropsFrameKeepsConn(t *testing.T) {
	c := &Conn{send: make(chan []byte, 2), lossy: make(chan []byte, 1), done: make(chan struct{})}
	c.trySendLossy([]byte("a")) // fills the lossy buffer (cap 1)
	c.trySendLossy([]byte("b")) // full → drop the frame, keep the conn

	select {
	case <-c.done:
		t.Fatal("a full lossy lane must NOT close the connection")
	default: // still open, as expected
	}
	if len(c.lossy) != 1 {
		t.Fatalf("lossy buffered=%d want 1 (the overflow frame must be dropped)", len(c.lossy))
	}
}

// Multi-gateway fanout: two independent hubs (each its own Pub/Sub subscription), each
// with a client in the same room. One bid → both gateways fan the event out to their
// own client from the canonical Stream. This is the horizontal-scale acceptance: no
// shared in-process hub, no re-plumbing — Pub/Sub + Stream do the cross-gateway fanout.
func TestT5MultiGatewayFanout(t *testing.T) {
	st := fullStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	aid := fmt.Sprintf("test_t5_mg_%d", time.Now().UnixNano())
	t.Cleanup(func() {
		c := context.Background()
		if keys, _ := st.Redis().Keys(c, "auction:{"+aid+"}:*").Result(); len(keys) > 0 {
			_ = st.Redis().Del(c, keys...).Err()
		}
	})

	if code, err := st.FreezeRules(ctx, aid, "seller_t5", reconcileRules()); err != nil || code != model.CodeOKFrozen {
		t.Fatalf("freeze: %s %v", code, err)
	}
	if code, _, err := st.StartAuction(ctx, aid, 3600_000); err != nil || code != model.CodeOKLive {
		t.Fatalf("start: %s %v", code, err)
	}

	hubA, hubB := newHub(), newHub()
	go hubA.subscribe(ctx, st, nil)
	go hubB.subscribe(ctx, st, nil)
	cA := &Conn{send: make(chan []byte, 16), lossy: make(chan []byte, 4), done: make(chan struct{}), aid: aid}
	cB := &Conn{send: make(chan []byte, 16), lossy: make(chan []byte, 4), done: make(chan struct{}), aid: aid}
	hubA.join(aid, cA)
	hubB.join(aid, cB)

	if code, _, _, err := st.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1"); err != nil || code != model.CodeOKAccepted {
		t.Fatalf("bid: %s %v", code, err)
	}
	assertConnReceives(t, cA, model.TypeBidAccepted, 4*time.Second)
	assertConnReceives(t, cB, model.TypeBidAccepted, 4*time.Second)
}

// Catchup pre-condition: the per-conn CRITICAL buffer must exceed catchupMaxGap,
// otherwise a slow client's full Stream replay will trip trySend's force-close
// (after exactly cap(send)+1 trySends), looping the just-reconnected client back
// into the very reconnect cycle catchup exists to break. Pins the invariant so a
// future refactor that re-tunes one constant without the other fails CI loudly.
func TestT5CatchupFitsInSendBuffer(t *testing.T) {
	if sendBufFrames <= catchupMaxGap {
		t.Fatalf("sendBufFrames=%d must exceed catchupMaxGap=%d (catchup replay would force-close)", sendBufFrames, catchupMaxGap)
	}
	c := &Conn{send: make(chan []byte, sendBufFrames), lossy: make(chan []byte, 4), done: make(chan struct{})}
	for i := 0; i < catchupMaxGap; i++ {
		c.trySend([]byte("catchup-event"))
	}
	select {
	case <-c.done:
		t.Fatalf("a full catchupMaxGap replay must NOT force-close (sendBufFrames=%d catchupMaxGap=%d)", sendBufFrames, catchupMaxGap)
	default: // still open, as expected
	}
	if got := len(c.send); got != catchupMaxGap {
		t.Fatalf("buffered=%d want %d (no drops, no loss)", got, catchupMaxGap)
	}
}

// trySend MUST drop frames once close() has fired: hub.leave runs in the read
// goroutine's defer, so there's a window where the conn still sits in hub.rooms
// and would otherwise accumulate dead-conn frames in the buffer (stale memory,
// and arbitrarily many re-broadcasts call trySend on the same closed conn).
func TestT5TrySendAfterCloseDoesNotEnqueue(t *testing.T) {
	c := &Conn{send: make(chan []byte, 8), lossy: make(chan []byte, 4), done: make(chan struct{})}
	c.close()
	for i := 0; i < 100; i++ {
		c.trySend([]byte("post-close"))
		c.trySendLossy([]byte("post-close"))
	}
	if got := len(c.send); got != 0 {
		t.Fatalf("post-close critical buffered=%d want 0 (frames must drop, not accumulate)", got)
	}
	if got := len(c.lossy); got != 0 {
		t.Fatalf("post-close lossy buffered=%d want 0 (frames must drop, not accumulate)", got)
	}
}

// assertConnReceives drains the conn's critical lane until it sees an envelope of the
// given type, or fails after d.
func assertConnReceives(t *testing.T, c *Conn, typ string, d time.Duration) {
	t.Helper()
	deadline := time.After(d)
	for {
		select {
		case b := <-c.send:
			var env model.Envelope
			if json.Unmarshal(b, &env) == nil && env.Type == typ {
				return
			}
		case <-deadline:
			t.Fatalf("conn (room=%s) did not receive %s within %s", c.aid, typ, d)
		}
	}
}
