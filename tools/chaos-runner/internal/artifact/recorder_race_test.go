package artifact

// PR #24 CR P1-3 hidden test: Recorder.UninjectedAt is read by the bidder
// goroutine inside RecordBid (mutex-held) while orchestrator was writing it
// directly. SetUninjectedAt now routes through the same mutex; this test
// trips `-race` if anyone reverts to direct field assignment.
//
// PR #24 CR P1-2 hidden test (same file because it shares the harness):
// AcceptedDuringInjection counts only OK_ACCEPTED that arrive between
// SetInjectedAt and SetUninjectedAt, so the LatencyEnvelope can prove
// "bidding continued *during* the fault" rather than aggregating across
// recovery accepts.

import (
	"sync"
	"testing"
	"time"
)

func TestRecorderSettersConcurrentSafeUnderRace(t *testing.T) {
	r := NewRecorder("ai", "auc_demo")
	r.SetInjectedAt(time.Now())

	// One goroutine flips UninjectedAt mid-stream; another fires bids.
	// With direct field assignment this would race (`-race` flag).
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				r.SetUninjectedAt(time.Now())
			}
		}
	}()
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				r.RecordBid(time.Now(), "OK_ACCEPTED", time.Millisecond, "")
			}
		}
	}()
	time.Sleep(50 * time.Millisecond)
	close(stop)
	wg.Wait()
	// If we reach here under `-race` it means no data race fired.
}

func TestAcceptedDuringInjectionWindow(t *testing.T) {
	r := NewRecorder("ai", "auc_demo")
	inject := time.Date(2026, 5, 25, 12, 0, 0, 0, time.UTC)
	uninject := inject.Add(5 * time.Second)
	r.SetInjectedAt(inject)

	// One accept BEFORE inject (shouldn't count toward during-window)
	r.RecordBid(inject.Add(-time.Second), "OK_ACCEPTED", time.Millisecond, "")
	// Three accepts DURING the injection window
	r.RecordBid(inject.Add(1*time.Second), "OK_ACCEPTED", time.Millisecond, "")
	r.RecordBid(inject.Add(2*time.Second), "OK_ACCEPTED", time.Millisecond, "")
	r.RecordBid(inject.Add(3*time.Second), "OK_ACCEPTED", time.Millisecond, "")

	r.SetUninjectedAt(uninject)
	// Two accepts AFTER uninject (recovery flurry — shouldn't count)
	r.RecordBid(uninject.Add(100*time.Millisecond), "OK_ACCEPTED", time.Millisecond, "")
	r.RecordBid(uninject.Add(200*time.Millisecond), "OK_ACCEPTED", time.Millisecond, "")

	if r.AcceptedCount != 6 {
		t.Fatalf("AcceptedCount=%d want 6", r.AcceptedCount)
	}
	if r.AcceptedDuringInjection != 3 {
		t.Fatalf("AcceptedDuringInjection=%d want 3 (PR #24 CR P1-2)", r.AcceptedDuringInjection)
	}
}
