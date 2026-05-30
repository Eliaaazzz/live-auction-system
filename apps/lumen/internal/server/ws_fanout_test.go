package server

import (
	"fmt"
	"testing"

	"github.com/gorilla/websocket"
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
					aid:      aid,
					done:     make(chan struct{}),
					send:     make(chan []byte, 1),
					prepared: make(chan *websocket.PreparedMessage, b.N+1),
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

// TestBroadcastFanoutDeliversToAll verifies the lock-free fan-out enqueues the
// prepared frame to every recipient.
func TestBroadcastFanoutDeliversToAll(t *testing.T) {
	h := newHub()
	const aid = "auc_t"
	const n = 50
	conns := make([]*Conn, n)
	for i := 0; i < n; i++ {
		conns[i] = &Conn{
			aid:      aid,
			done:     make(chan struct{}),
			prepared: make(chan *websocket.PreparedMessage, 4),
			send:     make(chan []byte, 4),
		}
		h.join(aid, conns[i])
	}

	h.broadcast(aid, []byte(`{"type":"AUCTION_SOLD"}`))

	for i, c := range conns {
		select {
		case pm := <-c.prepared:
			if pm == nil {
				t.Fatalf("conn %d received a nil prepared frame", i)
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
		aid:      aid,
		done:     make(chan struct{}),
		prepared: make(chan *websocket.PreparedMessage, 4),
		send:     make(chan []byte, 4),
	}
	// slow: single-slot prepared lane pre-filled to capacity → next enqueue overflows.
	slow := &Conn{
		aid:      aid,
		done:     make(chan struct{}),
		prepared: make(chan *websocket.PreparedMessage, 1),
		send:     make(chan []byte, 1),
	}
	slow.prepared <- nil

	h.join(aid, good)
	h.join(aid, slow)

	h.broadcast(aid, []byte(`{"type":"BID_ACCEPTED"}`))

	select {
	case <-good.prepared:
	default:
		t.Fatal("healthy conn did not receive the broadcast (slow client blocked the lock-free fan-out?)")
	}
	select {
	case <-slow.done:
	default:
		t.Fatal("slow conn was not force-closed when its CRITICAL lane was full")
	}
}
