package server

import (
	"fmt"
	"sync/atomic"
	"testing"
)

// BenchmarkBroadcastFanoutWithRoomChurn measures the lock-free broadcast path
// while one connection repeatedly leaves and rejoins the room. The steady-state
// benchmark in ws_fanout_test.go isolates raw fan-out cost; this companion
// benchmark adds the join/leave RLock-vs-Lock contention that appears during
// reconnect storms and auction-room rehomes.
func BenchmarkBroadcastFanoutWithRoomChurn(b *testing.B) {
	msg := []byte(`{"schemaVersion":1,"type":"BID_ACCEPTED","auctionId":"auc_churn","seq":1,"data":{"amountCents":"100000","userId":"u"}}`)
	for _, n := range []int{100, 1000, 10000} {
		b.Run(fmt.Sprintf("N=%d", n), func(b *testing.B) {
			h := newHub()
			const aid = "auc_churn"
			const otherAID = "auc_churn_other"

			for i := 0; i < n; i++ {
				h.join(aid, &Conn{
					aid:  aid,
					done: make(chan struct{}),
					crit: make(chan outboundFrame, b.N+1),
				})
			}

			churn := &Conn{
				aid:  aid,
				done: make(chan struct{}),
				crit: make(chan outboundFrame, b.N+1),
			}
			h.join(aid, churn)

			var stop atomic.Bool
			churnDone := make(chan struct{})
			go func() {
				defer close(churnDone)
				for !stop.Load() {
					h.leave(churn)
					churn.aid = otherAID
					h.join(otherAID, churn)
					h.leave(churn)
					churn.aid = aid
					h.join(aid, churn)
				}
			}()
			b.Cleanup(func() {
				stop.Store(true)
				<-churnDone
			})

			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				h.broadcast(aid, msg)
			}
		})
	}
}
