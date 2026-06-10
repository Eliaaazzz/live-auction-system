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

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/metrics"
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
	go hubA.subscribe(ctx, st, nil, nil, roomStatePatchConfig{})
	go hubB.subscribe(ctx, st, nil, nil, roomStatePatchConfig{})
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

// With room-state patching enabled, BID_ACCEPTED fanout is coalesced into
// ROOM_STATE_PATCH frames once the room is above the viewer threshold.
func TestT5RoomStatePatchCoalescesBidAccepted(t *testing.T) {
	m := metrics.New()
	h := newHub()
	st := fullStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	aid := fmt.Sprintf("test_t5_room_state_patch_%d", time.Now().UnixNano())
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

	// Enable patch mode for all rooms with at least one connected client, and flush
	// after 2 frames at most.
	go h.subscribe(ctx, st, nil, m, roomStatePatchConfig{
		minViewers: 1,
		maxEvents:  2,
	})

	c := &Conn{send: make(chan []byte, 16), lossy: make(chan []byte, 4), done: make(chan struct{}), aid: aid}
	h.join(aid, c)

	if code, _, _, err := st.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1"); err != nil || code != model.CodeOKAccepted {
		t.Fatalf("first bid: %s %v", code, err)
	}
	if code, _, _, err := st.PlaceBid(ctx, aid, "u2", "cb2", "12000", ""); err != nil || code != model.CodeOKAccepted {
		t.Fatalf("second bid: %s %v", code, err)
	}

	var patch model.Envelope
	deadline := time.After(4 * time.Second)
	select {
	case b := <-c.send:
		if err := json.Unmarshal(b, &patch); err != nil {
			t.Fatalf("unmarshal patch=%v", err)
		}
	case <-deadline:
		t.Fatal("timed out waiting for ROOM_STATE_PATCH")
	}

	if patch.Type != model.TypeRoomStatePatch {
		t.Fatalf("expect ROOM_STATE_PATCH, got %s", patch.Type)
	}

	var p model.RoomStatePatchData
	if err := json.Unmarshal(patch.Data, &p); err != nil {
		t.Fatalf("unmarshal ROOM_STATE_PATCH data=%v", err)
	}

	if p.Seq != 2 {
		t.Fatalf("patch seq=%d want 2", p.Seq)
	}
	if p.BidCountDelta != 2 {
		t.Fatalf("patch bidCountDelta=%d want 2", p.BidCountDelta)
	}
	if p.WinnerID != "u2" {
		t.Fatalf("patch winner=%s want u2", p.WinnerID)
	}
	if p.WinnerDisplayName != "u2" {
		t.Fatalf("patch winnerDisplayName=%s want u2", p.WinnerDisplayName)
	}

	if m.RoomStatePatchEmitted.Load() != 1 {
		t.Fatalf("roomStatePatchEmitted=%d want 1", m.RoomStatePatchEmitted.Load())
	}
	if m.RoomStatePatchBids.Load() != 2 {
		t.Fatalf("roomStatePatchBids=%d want 2", m.RoomStatePatchBids.Load())
	}
	if m.RoomStatePatchSkippedPublic.Load() != 2 {
		t.Fatalf("roomStatePatchSkippedPublic=%d want 2", m.RoomStatePatchSkippedPublic.Load())
	}

	select {
	case b := <-c.send:
		var next model.Envelope
		if err := json.Unmarshal(b, &next); err != nil {
			t.Fatalf("unexpected next frame=%v", err)
		}
		if next.Type == model.TypeBidAccepted {
			t.Fatalf("coalesced mode should not emit BID_ACCEPTED directly")
		}
	default:
		// good: no immediate extra frame under this controlled sequence.
	}
}

func TestT5RoomStatePatchAdaptiveNotUsedForSmallRoom(t *testing.T) {
	m := metrics.New()
	h := newHub()
	st := fullStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	aid := fmt.Sprintf("test_t5_room_state_patch_adaptive_small_%d", time.Now().UnixNano())
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

	go h.subscribe(ctx, st, nil, m, roomStatePatchConfig{
		minViewers:      2,
		maxEvents:       2,
		adaptiveEnabled: true,
		adaptiveMinBids: 1,
	})

	c := &Conn{send: make(chan []byte, 16), lossy: make(chan []byte, 4), done: make(chan struct{}), aid: aid}
	h.join(aid, c)

	if code, _, _, err := st.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1"); err != nil || code != model.CodeOKAccepted {
		t.Fatalf("first bid: %s %v", code, err)
	}
	if code, _, _, err := st.PlaceBid(ctx, aid, "u2", "cb2", "12000", "U2"); err != nil || code != model.CodeOKAccepted {
		t.Fatalf("second bid: %s %v", code, err)
	}

	assertConnReceives(t, c, model.TypeBidAccepted, 4*time.Second)
	assertConnReceives(t, c, model.TypeBidAccepted, 4*time.Second)
	select {
	case b := <-c.send:
		var env model.Envelope
		if err := json.Unmarshal(b, &env); err == nil && env.Type == model.TypeRoomStatePatch {
			t.Fatalf("did not expect ROOM_STATE_PATCH in small room")
		}
	case <-time.After(250 * time.Millisecond):
		// good: no additional frame
	}

	if m.RoomStatePatchEmitted.Load() != 0 {
		t.Fatalf("roomStatePatchEmitted=%d want 0", m.RoomStatePatchEmitted.Load())
	}
	if m.RoomStatePatchBids.Load() != 0 {
		t.Fatalf("roomStatePatchBids=%d want 0", m.RoomStatePatchBids.Load())
	}
	if m.RoomStatePatchSkippedPublic.Load() != 0 {
		t.Fatalf("roomStatePatchSkippedPublic=%d want 0", m.RoomStatePatchSkippedPublic.Load())
	}
}

func TestT5RoomStatePatchAdaptiveEnablesAfterRoomSizeSurge(t *testing.T) {
	m := metrics.New()
	h := newHub()
	st := fullStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	aid := fmt.Sprintf("test_t5_room_state_patch_adaptive_surge_%d", time.Now().UnixNano())
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

	go h.subscribe(ctx, st, nil, m, roomStatePatchConfig{
		minViewers:      2,
		maxEvents:       2,
		adaptiveEnabled: true,
		adaptiveMinBids: 1,
	})

	c1 := &Conn{send: make(chan []byte, 16), lossy: make(chan []byte, 4), done: make(chan struct{}), aid: aid}
	c2 := &Conn{send: make(chan []byte, 16), lossy: make(chan []byte, 4), done: make(chan struct{}), aid: aid}
	h.join(aid, c1)

	if code, _, _, err := st.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1"); err != nil || code != model.CodeOKAccepted {
		t.Fatalf("first bid: %s %v", code, err)
	}
	first := readEnvelopeType(t, c1, model.TypeBidAccepted, 4*time.Second)
	if first.Seq != 1 {
		t.Fatalf("first event seq=%d want 1", first.Seq)
	}

	h.join(aid, c2)
	if code, _, _, err := st.PlaceBid(ctx, aid, "u2", "cb2", "12000", "U2"); err != nil || code != model.CodeOKAccepted {
		t.Fatalf("surge bid1: %s %v", code, err)
	}
	if code, _, _, err := st.PlaceBid(ctx, aid, "u3", "cb3", "13000", "U3"); err != nil || code != model.CodeOKAccepted {
		t.Fatalf("surge bid2: %s %v", code, err)
	}

	patch := readEnvelopeType(t, c1, model.TypeRoomStatePatch, 4*time.Second)
	var p model.RoomStatePatchData
	if err := json.Unmarshal(patch.Data, &p); err != nil {
		t.Fatalf("unmarshal ROOM_STATE_PATCH data=%v", err)
	}
	if p.Seq != 3 {
		t.Fatalf("patch seq=%d want 3", p.Seq)
	}
	if p.BidCountDelta != 2 {
		t.Fatalf("patch bidCountDelta=%d want 2", p.BidCountDelta)
	}
	if p.WinnerID != "u3" {
		t.Fatalf("patch winner=%s want u3", p.WinnerID)
	}
	_ = readEnvelopeType(t, c2, model.TypeRoomStatePatch, 4*time.Second)

	if m.RoomStatePatchEmitted.Load() != 1 {
		t.Fatalf("roomStatePatchEmitted=%d want 1", m.RoomStatePatchEmitted.Load())
	}
	if m.RoomStatePatchBids.Load() != 2 {
		t.Fatalf("roomStatePatchBids=%d want 2", m.RoomStatePatchBids.Load())
	}
	if m.RoomStatePatchSkippedPublic.Load() != 2 {
		t.Fatalf("roomStatePatchSkippedPublic=%d want 2", m.RoomStatePatchSkippedPublic.Load())
	}
}

func TestT5RoomStatePatchAdaptiveResetAfterRoomShrinks(t *testing.T) {
	m := metrics.New()
	h := newHub()
	st := fullStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	aid := fmt.Sprintf("test_t5_room_state_patch_adaptive_shrink_reset_%d", time.Now().UnixNano())
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

	go h.subscribe(ctx, st, nil, m, roomStatePatchConfig{
		minViewers:      2,
		maxEvents:       1,
		adaptiveEnabled: true,
		adaptiveMinBids: 3,
	})

	c1 := &Conn{send: make(chan []byte, 16), lossy: make(chan []byte, 4), done: make(chan struct{}), aid: aid}
	c2 := &Conn{send: make(chan []byte, 16), lossy: make(chan []byte, 4), done: make(chan struct{}), aid: aid}
	h.join(aid, c1)
	h.join(aid, c2)

	placeBid := func(userID, bidderID, amount, name string) {
		if code, _, _, err := st.PlaceBid(ctx, aid, userID, bidderID, amount, name); err != nil || code != model.CodeOKAccepted {
			t.Fatalf("bid (%s): %s %v", userID, code, err)
		}
	}

	// Build up adaptive counter history for this room while it is already large.
	placeBid("u1", "cb1", "11000", "U1")
	assertConnReceives(t, c1, model.TypeBidAccepted, 4*time.Second)
	placeBid("u2", "cb2", "12000", "U2")
	assertConnReceives(t, c1, model.TypeBidAccepted, 4*time.Second)

	// Drop below threshold: adaptive coalescing state should clear and not resume
	// with stale counters when the room grows again.
	h.leave(c2)
	placeBid("u3", "cb3", "13000", "U3")
	assertConnReceives(t, c1, model.TypeBidAccepted, 4*time.Second)

	h.join(aid, c2)
	placeBid("u4", "cb4", "14000", "U4")
	assertConnReceives(t, c1, model.TypeBidAccepted, 4*time.Second)
	placeBid("u5", "cb5", "15000", "U5")
	assertConnReceives(t, c1, model.TypeBidAccepted, 4*time.Second)
	// This third post-shrink bid should cross adaptiveMinBids=3 and emit the first
	// ROOM_STATE_PATCH for this room in the post-shrink period.
	placeBid("u6", "cb6", "16000", "U6")
	patch := readEnvelopeType(t, c1, model.TypeRoomStatePatch, 4*time.Second)
	var p model.RoomStatePatchData
	if err := json.Unmarshal(patch.Data, &p); err != nil {
		t.Fatalf("unmarshal ROOM_STATE_PATCH data=%v", err)
	}
	if p.Seq != 6 {
		t.Fatalf("patch seq=%d want 6", p.Seq)
	}
	if p.BidCountDelta != 1 {
		t.Fatalf("patch bidCountDelta=%d want 1", p.BidCountDelta)
	}

	if m.RoomStatePatchEmitted.Load() != 1 {
		t.Fatalf("roomStatePatchEmitted=%d want 1", m.RoomStatePatchEmitted.Load())
	}
	if m.RoomStatePatchBids.Load() != 1 {
		t.Fatalf("roomStatePatchBids=%d want 1", m.RoomStatePatchBids.Load())
	}
	if m.RoomStatePatchSkippedPublic.Load() != 1 {
		t.Fatalf("roomStatePatchSkippedPublic=%d want 1", m.RoomStatePatchSkippedPublic.Load())
	}
}

func TestT5RoomStatePatchAdaptiveTerminalFlush(t *testing.T) {
	m := metrics.New()
	h := newHub()
	st := fullStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	aid := fmt.Sprintf("test_t5_room_state_patch_adaptive_terminal_%d", time.Now().UnixNano())
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

	go h.subscribe(ctx, st, nil, m, roomStatePatchConfig{
		minViewers:      1,
		maxEvents:       10,
		adaptiveEnabled: true,
		adaptiveMinBids: 1,
	})

	c := &Conn{send: make(chan []byte, 16), lossy: make(chan []byte, 4), done: make(chan struct{}), aid: aid}
	h.join(aid, c)

	if code, _, _, err := st.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1"); err != nil || code != model.CodeOKAccepted {
		t.Fatalf("first bid: %s %v", code, err)
	}
	// No patch should be emitted immediately at this point (it is coalescible and
	// will wait for either maxEvents or a terminal frame).
	select {
	case b := <-c.send:
		var env model.Envelope
		if err := json.Unmarshal(b, &env); err == nil && env.Type == model.TypeRoomStatePatch {
			t.Fatalf("did not expect immediate patch emission before terminal event")
		}
	case <-time.After(250 * time.Millisecond):
		// expected: patch sits in aggregator.
	}

	if code, err := st.CancelAuction(ctx, aid, "seller_t5"); err != nil || code != model.CodeOKCancelled {
		t.Fatalf("cancel: %s %v", code, err)
	}

	patch := readEnvelopeType(t, c, model.TypeRoomStatePatch, 4*time.Second)
	var p model.RoomStatePatchData
	if err := json.Unmarshal(patch.Data, &p); err != nil {
		t.Fatalf("unmarshal ROOM_STATE_PATCH data=%v", err)
	}
	if p.BidCountDelta != 1 {
		t.Fatalf("patch bidCountDelta=%d want 1", p.BidCountDelta)
	}

	terminal := readEnvelopeType(t, c, model.TypeAuctionCancelled, 4*time.Second)
	if terminal.Seq == 0 {
		t.Fatalf("expected terminal frame after patch")
	}
	if m.RoomStatePatchEmitted.Load() != 1 {
		t.Fatalf("roomStatePatchEmitted=%d want 1", m.RoomStatePatchEmitted.Load())
	}
	if m.RoomStatePatchBids.Load() != 1 {
		t.Fatalf("roomStatePatchBids=%d want 1", m.RoomStatePatchBids.Load())
	}
	if m.RoomStatePatchSkippedPublic.Load() != 1 {
		t.Fatalf("roomStatePatchSkippedPublic=%d want 1", m.RoomStatePatchSkippedPublic.Load())
	}
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

func readEnvelopeType(t *testing.T, c *Conn, typ string, d time.Duration) model.Envelope {
	t.Helper()
	deadline := time.After(d)
	for {
		select {
		case b := <-c.send:
			var env model.Envelope
			if err := json.Unmarshal(b, &env); err != nil {
				t.Fatalf("unmarshal frame=%v", err)
			}
			if env.Type == typ {
				return env
			}
		case <-deadline:
			t.Fatalf("conn (room=%s) did not receive %s within %s", c.aid, typ, d)
		}
	}
}
