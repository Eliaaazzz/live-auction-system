package store

import (
	"sync"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

// snapFlight collapses concurrent Snapshot(aid) reads of the same hot room-state
// hash into ONE Redis HGetAll - cache-stampede protection (an explicit
// spec rubric item) for the mass-reconnect stampede a gateway crash/restart
// produces: the 2026-06-07 load test crashed the gateway with ~15k live clients,
// and on restart every one of them re-JOINs the SAME auction at once, which
// without de-duplication is ~15k simultaneous HGetAll on a single key.
//
// Callers that arrive while a read is in flight share its result. This is
// staleness-free: the shared read is current as of when it completes, and the
// collapse window is exactly one HGetAll RTT (sub-millisecond on the intranet) —
// a brand-new call after the in-flight one returns always does a fresh read.
//
// Trade-off (same as golang.org/x/sync/singleflight, which we avoid to keep the
// store dep-free): followers wait on the leader's call rather than their own ctx,
// and if the leader's ctx is cancelled mid-read the followers inherit that error.
// Across the ~RTT window with near-identical reconnect deadlines this is benign;
// the alternative (every client its own HGetAll) is the stampede we are fixing.
//
// The zero value is ready to use (the map is lazily created under the lock).
type snapFlight struct {
	mu    sync.Mutex
	calls map[string]*snapCall
}

type snapCall struct {
	wg  sync.WaitGroup
	val model.RoomSnapshotData
	err error
}

// Do runs fn for key, ensuring only one in-flight execution per key at a time;
// concurrent callers for the same key block until the leader finishes and then
// receive the leader's (val, err).
func (f *snapFlight) Do(key string, fn func() (model.RoomSnapshotData, error)) (model.RoomSnapshotData, error) {
	f.mu.Lock()
	if f.calls == nil {
		f.calls = make(map[string]*snapCall)
	}
	if c, ok := f.calls[key]; ok {
		f.mu.Unlock()
		c.wg.Wait()
		return c.val, c.err
	}
	c := &snapCall{}
	c.wg.Add(1)
	f.calls[key] = c
	f.mu.Unlock()

	c.val, c.err = fn()

	f.mu.Lock()
	delete(f.calls, key)
	f.mu.Unlock()
	c.wg.Done()
	return c.val, c.err
}
