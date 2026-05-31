package server

import (
	"fmt"
	"sync"
	"testing"
)

// Fan-out tests for the lock-free broadcast snapshot (issue #118).

// BenchmarkBroadcastFanout measures Hub.broadcast across recipient counts
// (docs/architecture-scaling-v10k.md §9). Each conn's CRITICAL lane is buffered
// to b.N so the fan-out never force-closes a "slow" client mid-run — this
// isolates broadcast's cost (snapshot + per-conn enqueue + the once-per-event
// PreparedMessage build), which is the only part the writePump-draining at the
// other end doesn't cover. The snapshot + sync.Pool keep the fan-out
// allocation-free per recipient: allocs/op stays ~constant as N grows (the
// residual is the single per-broadcast PreparedMessage, not per-recipient).
func BenchmarkBroadcastFanout(b *testing.B) {
	msg := []byte(`{"schemaVersion":1,"type":"BID_ACCEPTED","auctionId":"auc_bench","seq":1,"data":{"amountCents":"100000","userId":"u"}}`)
	for _, n := range []int{100, 1000, 10000} {
		b.Run(fmt.Sprintf("N=%d", n), func(b *testing.B) {
			h := newHub()
			const aid = "auc_bench"
			for i := 0; i < n; i++ {
				h.join(aid, &Conn{
					aid:  aid,
					done: make(chan struct{}),
					crit: make(chan outboundFrame, b.N+1),
				})
			}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				h.broadcast(aid, msg)
			}
		})
	}
}

// TestBroadcastFanoutDeliversToAll verifies the lock-free fan-out enqueues a
// frame to EVERY recipient. These hand-built conns have no socket (ws==nil), so
// the fan-out uses the raw fallback (the PreparedMessage path is covered by the
// real-client harness tests); the point here is reach, not frame encoding.
func TestBroadcastFanoutDeliversToAll(t *testing.T) {
	h := newHub()
	const aid = "auc_t"
	const n = 50
	conns := make([]*Conn, n)
	for i := 0; i < n; i++ {
		conns[i] = &Conn{
			aid:  aid,
			done: make(chan struct{}),
			crit: make(chan outboundFrame, 4),
		}
		h.join(aid, conns[i])
	}

	h.broadcast(aid, []byte(`{"type":"AUCTION_SOLD"}`))

	for i, c := range conns {
		select {
		case f := <-c.crit:
			if f.pm == nil && f.raw == nil {
				t.Fatalf("conn %d received an empty frame (neither raw nor prepared)", i)
			}
		default:
			t.Fatalf("conn %d did not receive the broadcast frame", i)
		}
	}
}

// TestBroadcastFanoutForceClosesSlowClient verifies that a slow client whose
// CRITICAL lane is full gets force-closed by the fan-out WITHOUT blocking
// delivery to the healthy recipients — i.e. the lock-free fan-out preserves the
// backpressure contract regardless of map-iteration order.
func TestBroadcastFanoutForceClosesSlowClient(t *testing.T) {
	h := newHub()
	const aid = "auc_bp"

	good := &Conn{
		aid:  aid,
		done: make(chan struct{}),
		crit: make(chan outboundFrame, 4),
	}
	// slow: single-slot critical lane pre-filled to capacity → next enqueue overflows.
	slow := &Conn{
		aid:  aid,
		done: make(chan struct{}),
		crit: make(chan outboundFrame, 1),
	}
	slow.crit <- outboundFrame{} // fill the 1-slot critical lane

	h.join(aid, good)
	h.join(aid, slow)

	h.broadcast(aid, []byte(`{"type":"BID_ACCEPTED"}`))

	select {
	case <-good.crit:
	default:
		t.Fatal("healthy conn did not receive the broadcast (slow client blocked the lock-free fan-out?)")
	}
	select {
	case <-slow.done:
	default:
		t.Fatal("slow conn was not force-closed when its CRITICAL lane was full")
	}
}

// TestBroadcastFanoutRaceWithRehome races the lock-free fan-out against a
// cross-auction re-home (ROOM_JOIN to a different auction reuses the same *Conn
// and reassigns c.aid in handleWS). Its PURPOSE is the `-race` detector: `mover`
// keeps an UNDRAINED lane so every broadcast hits the backpressure-log path (the
// old c.aid read site) WHILE the re-homer writes mover.aid — so a regression of
// the c.aid fix would be flagged here under `go test -race`. It also exercises
// the roomEpoch snapshot-skip. It deliberately does NOT assert the absence of a
// stale frame: the post-epoch-check TOCTOU (epoch passes, conn re-homes, then the
// frame enqueues) is an accepted property of lock-free fan-out — the envelope
// carries auctionId so a re-homed client routes it correctly. Without -race this
// is a no-panic / no-deadlock smoke test. (#118)
func TestBroadcastFanoutRaceWithRehome(t *testing.T) {
	h := newHub()
	stop := make(chan struct{})
	var wg sync.WaitGroup

	// stable: drained lane → stays alive so the fan-out keeps delivering.
	stable := &Conn{aid: "A", done: make(chan struct{}), crit: make(chan outboundFrame, 256)}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			case <-stable.crit:
			}
		}
	}()
	h.join("A", stable)

	// mover: tiny UNDRAINED lane → fills immediately, so the broadcast exercises
	// the backpressure-log path concurrently with the re-homer's mover.aid write.
	mover := &Conn{aid: "A", done: make(chan struct{}), crit: make(chan outboundFrame, 1)}
	h.join("A", mover)

	wg.Add(2)
	go func() { // broadcaster: hammer room A
		defer wg.Done()
		msg := []byte(`{"type":"BID_ACCEPTED","auctionId":"A"}`)
		for {
			select {
			case <-stop:
				return
			default:
				h.broadcast("A", msg)
			}
		}
	}()
	go func() { // re-homer: flip `mover` A↔B (mirrors the ROOM_JOIN handler)
		defer wg.Done()
		for i := 0; i < 5000; i++ {
			h.leave(mover)
			mover.aid = "B"
			h.join("B", mover)
			h.leave(mover)
			mover.aid = "A"
			h.join("A", mover)
		}
		close(stop)
	}()

	wg.Wait()
}
