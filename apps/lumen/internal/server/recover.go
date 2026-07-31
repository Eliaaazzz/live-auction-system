package server

import (
	"context"
	"log"
	"runtime/debug"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/metrics"
)

// goSupervisedBackoff is the pause before restarting a background worker that
// returned or panicked while its context was still live. A var (not const) so
// tests can shrink it.
var goSupervisedBackoff = 500 * time.Millisecond

// recoverGoroutine is the deferred panic firewall for a background goroutine
// (spec deep-review: stability / failure fallback). A panic in a worker we spawn -
// subscribe / persistence / timer / AI dispatch — would otherwise crash the
// WHOLE gateway: net/http recovers panics in REQUEST handlers, but not in
// goroutines started outside the request lifecycle. This recovers, logs the
// panic + stack, and (when metrics are wired) increments goroutinePanics so the
// survival is observable/alertable. Use as `defer recoverGoroutine(name, m)`.
// Returns true if a panic was recovered (for callers that want to branch).
func recoverGoroutine(name string, m *metrics.Registry) bool {
	if r := recover(); r != nil {
		if m != nil {
			m.GoroutinePanics.Inc()
		}
		log.Printf("lumen: PANIC recovered in background goroutine %q: %v\n%s", name, r, debug.Stack())
		return true
	}
	return false
}

// goSupervised runs fn(ctx) in a goroutine that SURVIVES panics: on a panic (or an
// unexpected early return) while ctx is still live, it logs/counts via
// recoverGoroutine and restarts after goSupervisedBackoff. Long-lived workers
// (subscribe/persistence/timer) must never take the process down with them — one
// malformed Stream payload should degrade one worker, not crash the gateway. The
// loop exits cleanly once ctx is cancelled (graceful shutdown).
func goSupervised(ctx context.Context, name string, m *metrics.Registry, fn func(context.Context)) {
	go func() {
		for ctx.Err() == nil {
			func() {
				defer recoverGoroutine(name, m)
				fn(ctx)
			}()
			if ctx.Err() != nil {
				return
			}
			// fn returned or panicked while ctx is still live → restart after a
			// short backoff (avoids a hot crash-loop on a persistent fault).
			select {
			case <-ctx.Done():
				return
			case <-time.After(goSupervisedBackoff):
			}
		}
	}()
}
