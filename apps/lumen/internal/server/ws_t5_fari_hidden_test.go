package server

// T5 hidden probes by @fariZzzz — written to CHALLENGE the fe90763 fix
// (sendBufFrames=256 + leading done-check), not just re-run elia's tests.
// Methodology per team workflow: pull the PR, write edge cases that the fix's
// new code paths could break, run under -race.
//
// Two things the fix introduced that the existing T5 tests do NOT cover:
//   1. The leading done-check is best-effort (TOCTOU between the check and the
//      enqueue), and `send`/`lossy` are deliberately never closed. So close()
//      racing a flood of concurrent trySend/trySendLossy must stay race-clean
//      and converge to closed — never panic on a closed channel.
//   2. TestT5CatchupFitsInSendBuffer proves a *cold* buffer absorbs a full
//      catchupMaxGap replay. But in the live flow the buffer is not cold:
//      ROOM_SNAPSHOT + concurrent room fanout occupy slots before/while catchup
//      replays. The real guarantee is only `sendBufFrames - catchupMaxGap`
//      frames of headroom. These probes pin that exact boundary.

import (
	"sync"
	"testing"
)

// TC-T5-108 — close() racing a concurrent trySend/trySendLossy flood must be
// race-clean and converge to closed. Exercises the residual TOCTOU in the
// leading done-check (check passes, then close() fires, then enqueue) plus the
// "channels are never closed" invariant under -race. A regression that closed
// the send channels, or dropped closeOnce, would panic or race here.
func TestT5ConcurrentCloseVsSendFloodIsRaceClean(t *testing.T) {
	const senders = 16
	const perSender = 500
	c := &Conn{send: make(chan []byte, sendBufFrames), lossy: make(chan []byte, 16), done: make(chan struct{})}

	// A draining reader stands in for writePump so senders that win the race
	// before close() don't all wedge on a full buffer (we're probing the
	// close race, not the force-close path).
	drainDone := make(chan struct{})
	go func() {
		for {
			select {
			case <-c.send:
			case <-c.lossy:
			case <-drainDone:
				return
			}
		}
	}()

	var wg sync.WaitGroup
	wg.Add(senders + 1)
	for i := 0; i < senders; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < perSender; j++ {
				c.trySend([]byte("crit"))
				c.trySendLossy([]byte("lossy"))
			}
		}()
	}
	// Concurrent closer racing the flood.
	go func() {
		defer wg.Done()
		c.close()
		c.close() // closeOnce must make the second a no-op (no double-close panic)
	}()

	wg.Wait()
	close(drainDone)

	select {
	case <-c.done: // converged to closed, as required
	default:
		t.Fatal("conn must be closed after the flood + close() race")
	}
}

// TC-T5-109 — pins the EXACT catchup headroom. The no-force-close guarantee for
// a full catchupMaxGap replay holds only when at most `sendBufFrames-catchupMaxGap`
// frames already occupy the critical lane (ROOM_SNAPSHOT + concurrent fanout).
// At headroom the conn survives; at headroom+1 the replay's last push force-closes.
// This is the quantitative version of the residual @fariZzzz flagged: catchup is
// "fits in a COLD buffer", not "fits regardless of concurrent fanout" (a T8 load
// concern, not a P1 correctness bug — force-closing under genuine overload is the
// intended fail-safe).
func TestT5CatchupHeadroomBoundary(t *testing.T) {
	headroom := sendBufFrames - catchupMaxGap

	// At headroom: prefill exactly fills the gap, replay tops the buffer to cap,
	// no push exceeds cap → no force-close.
	t.Run("at_headroom_survives", func(t *testing.T) {
		c := &Conn{send: make(chan []byte, sendBufFrames), lossy: make(chan []byte, 4), done: make(chan struct{})}
		for i := 0; i < headroom; i++ {
			c.trySend([]byte("prefill"))
		}
		for i := 0; i < catchupMaxGap; i++ {
			c.trySend([]byte("catchup"))
		}
		select {
		case <-c.done:
			t.Fatalf("prefill=%d + catchup=%d == cap=%d must NOT force-close", headroom, catchupMaxGap, sendBufFrames)
		default:
		}
		if got := len(c.send); got != sendBufFrames {
			t.Fatalf("buffered=%d want %d (buffer full, no drops)", got, sendBufFrames)
		}
	})

	// At headroom+1: the replay's final push exceeds cap → force-close. Documents
	// that catchup survival is NOT unconditional under concurrent fanout.
	t.Run("over_headroom_force_closes", func(t *testing.T) {
		c := &Conn{send: make(chan []byte, sendBufFrames), lossy: make(chan []byte, 4), done: make(chan struct{})}
		for i := 0; i < headroom+1; i++ {
			c.trySend([]byte("prefill"))
		}
		for i := 0; i < catchupMaxGap; i++ {
			c.trySend([]byte("catchup"))
		}
		select {
		case <-c.done: // force-closed, as expected (fail-safe under overload)
		default:
			t.Fatalf("prefill=%d + catchup=%d > cap=%d must force-close", headroom+1, catchupMaxGap, sendBufFrames)
		}
	})
}
