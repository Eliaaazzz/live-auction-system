package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/auth"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/metrics"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

// maxWSFrameBytes bounds an inbound WS frame (§8 WS hardening). Client messages
// are a few hundred bytes; 32 KiB is generous headroom without inviting abuse.
const maxWSFrameBytes = 32 * 1024

// maxClientBidIDLen bounds the client-supplied idempotency key. It becomes a
// Redis hash field name in the dedupe Hash, so cap it well below the frame limit.
const maxClientBidIDLen = 128

// catchupMaxGap is the largest ROOM_JOIN lastSeq delta replayed from the Stream;
// past it the client gets a snapshot instead (cheaper than a huge replay).
const catchupMaxGap = 200

// sendBufFrames sizes the per-conn CRITICAL lane. It MUST exceed catchupMaxGap
// so a full Stream replay into the buffer never trips the trySend force-close
// before writePump can drain — the catchup case is exactly the one where the
// client may be slow (just-reconnected, possibly high-RTT), and force-closing
// it would re-enter the reconnect loop the catchup is meant to break.
//
// V10k Tier A: bumped 256 → 1024 to absorb a 500+ bid/s broadcast burst at 10k
// connected. At 256 frames a single broadcast at 500/s with a 0.5 s writePump
// stall would force-close; 1024 gives 2 s headroom. Per-conn memory cost is
// `1024 × 8B (slice header) ≈ 8 KiB` channel buffer; at 10k conn = 80 MiB
// resident — well within budget on any deploy box.
const sendBufFrames = 1024

// fastRejectExpiryMarginMs is the safety margin between the gateway's wall
// clock and the cached endAtMs below which the V10k Tier C fast-reject defers
// to Lua (codex pass-2 Q2). Lua's Redis TIME is authoritative; if the gateway
// clock is up to `fastRejectExpiryMarginMs` behind Redis, deferring keeps the
// fast-path from returning ERR_TOO_LOW where Lua would correctly return
// ERR_AFTER_END. 1000ms covers normal container clock drift (NTP step + jitter);
// raise it on platforms with looser clock sync.
const fastRejectExpiryMarginMs int64 = 1000
const schemaMismatchCloseCode = 4001

// fanoutSweepInterval is the backstop cadence for Stream-driven broadcast (a lost
// Pub/Sub wakeup can't permanently stall the room).
const fanoutSweepInterval = 2 * time.Second

// pongWait is the deadline on an inbound PONG; if the client doesn't reply
// within the window the server reads time-out and the read goroutine exits
// (defer hub.leave + close fire promptly). Without this the OS-level TCP
// timeout runs ~2h on Linux, which leaks one read + one writePump goroutine
// AND keeps the conn in hub.rooms for every silently-dead mobile/NAT/sleep
// client. 60s matches the gorilla/websocket example default — long enough
// to absorb a normal mobile NAT hop, short enough for prompt cleanup.
//
// pongWait/pingPeriod are vars (not consts) so tests can drive sub-second
// reaping without waiting 60s of wall-clock; production reads them once at
// connection time. Mutate only via setKeepaliveForTest under t.Cleanup —
// production callers MUST NOT change these. keepaliveMu guards test-time
// mutation against connection-time snapshots.
var (
	keepaliveMu sync.RWMutex
	pongWait    = 60 * time.Second
	pingPeriod  = (pongWait * 9) / 10
)

func keepaliveSnapshot() (time.Duration, time.Duration) {
	keepaliveMu.RLock()
	defer keepaliveMu.RUnlock()
	return pongWait, pingPeriod
}

// writeWait bounds writePump's per-frame data and PING writes. The typed
// CLOSE frame uses the tighter closeFrameWait below — see flushClose.
const writeWait = 10 * time.Second

// closeFrameWait bounds the typed-CLOSE WriteControl emitted from flushClose.
// Kept tight (vs. writeWait) so writePump's exit path can't park for 10s on a
// hung socket — the close frame is best-effort: if it can't land in this
// window, the immediately-following ws.Close() races to RST and the client
// surfaces a generic read error instead of a typed code 4000. The frame is
// ~12 bytes so this is generous on any healthy socket.
const closeFrameWait = 1 * time.Second

// closeCodeBackpressureDrop is the application-level close code emitted when
// trySend force-closes a slow client. WS spec reserves 4000-4999 for app use
// (RFC 6455 §7.4.2). Distinguishes a server-initiated backpressure drop from
// a raw network failure so a thin client can back off + ROOM_SNAPSHOT instead
// of tight-looping into another force-close.
const closeCodeBackpressureDrop = 4000

// maxOutboundFrameBytes bounds the size of any server-emitted WS frame.
// Today's frames are small (BID_ACCEPTED ~200B, ROOM_SNAPSHOT ~150B); the
// bound is defensive against a future contributor pushing a large event
// payload (e.g. an evidence-card timeline push) — get a logged fail-fast
// rather than weird socket behavior.
const maxOutboundFrameBytes = 32 * 1024

// streamIDForSeq returns the XRANGE-exclusive lower bound for "events after seq".
func streamIDForSeq(seq int64) string { return fmt.Sprintf("%d-0", seq) }

func eventsUpToSnapshot(events []store.StreamEvent, snapshotSeq int64) []store.StreamEvent {
	out := make([]store.StreamEvent, 0, len(events))
	for _, e := range events {
		if e.Seq <= snapshotSeq {
			out = append(out, e)
		}
	}
	return out
}

// Hub tracks room membership and fans out broadcasts. The bid path is decoupled
// from the broadcast path via Redis Pub/Sub (subscribe), so adding gateways at
// T5 needs no re-plumbing.
//
// V10k Tier C (gateway-side pre-aggregation): roomState caches per-auction
// `currentPriceCents` + `endAtMs`, updated eventually-consistently from
// BID_ACCEPTED broadcasts the hub fans out (or ROOM_SNAPSHOT on JOIN). Used
// by dispatchWS BID_PLACE to fast-reject bids the gateway already knows are
// too low, sparing the Lua hot path from doomed adjudications. Safe by design
// because the cache only ever ratchets UP (max of seen amounts); a stale cache
// can NEVER wrongly accept a bid that Lua would reject (Lua remains authoritative).
type Hub struct {
	mu    sync.RWMutex
	rooms map[string]map[*Conn]struct{}
	state map[string]*roomState
}

// roomState is the gateway-side eventually-consistent room snapshot for the
// fast-reject filter. Updated under hub.mu (write lock) from subscribe's
// broadcast path; read under hub.mu (RLock) by the BID_PLACE handler.
//
// `priceCents` is a string to avoid float precision loss at MAX_MONEY (`> 2^53`),
// matching the wire shape. The numeric comparison done in the BID_PLACE path
// parses via strconv.ParseInt so a malformed broadcast (shouldn't happen — Lua
// echoes canonical strings) falls through to Lua for authoritative rejection.
//
// `terminal` is set true under the SAME write-lock acquisition that captures the
// last accepted price for a cap-hit BID_ACCEPTED(status=SOLD) or an explicit
// AUCTION_SOLD/NO_BID/CANCELLED event. Fast-reject MUST check this flag and fall
// through to Lua (which returns ERR_NOT_LIVE on terminal status) — codex pass-2
// review Q1: closes the race between cap-hit cache populate and the subsequent
// terminal drop. With a single write-lock around price-update + terminal-mark,
// any reader either sees (price=X, terminal=false) or (price=X, terminal=true);
// the in-between never escapes.
type roomState struct {
	priceCents string // monotonically non-decreasing; "" until first observed event
	endAtMs    int64  // 0 until first observed snapshot/event; used to skip filter past hammer time
	terminal   bool   // true after AUCTION_SOLD/NO_BID/CANCELLED or cap-hit BID_ACCEPTED(SOLD)
	mode       string // auction mode (issue #114), cached from ROOM_SNAPSHOT.rules.mode; "" == ENGLISH
}

func newHub() *Hub {
	return &Hub{
		rooms: make(map[string]map[*Conn]struct{}),
		state: make(map[string]*roomState),
	}
}

func (h *Hub) join(aid string, c *Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.rooms[aid] == nil {
		h.rooms[aid] = make(map[*Conn]struct{})
	}
	h.rooms[aid][c] = struct{}{}
	c.roomEpoch.Add(1) // invalidate any in-flight broadcast snapshot of this conn (#118)
}

func (h *Hub) leave(c *Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if c.aid != "" && h.rooms[c.aid] != nil {
		delete(h.rooms[c.aid], c)
		c.roomEpoch.Add(1) // invalidate any in-flight broadcast snapshot of this conn (#118)
		// Drop the room entry once it's empty so roomAIDs() / the fanout sweep
		// don't keep scheduling work for zero-client rooms. Broadcasts to an
		// empty room were already no-ops; this is read-side bookkeeping that
		// also bounds map growth as auctions cycle through their lifetimes.
		if len(h.rooms[c.aid]) == 0 {
			delete(h.rooms, c.aid)
		}
	}
}

// viewerCount returns the number of connections currently in a room (参与人数).
func (h *Hub) viewerCount(aid string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.rooms[aid])
}

// bcastTarget pairs a recipient with the room epoch observed at snapshot time so
// the lock-free fan-out can skip a conn that left/rejoined since the snapshot.
type bcastTarget struct {
	c     *Conn
	epoch uint64
}

// connSnapPool reuses the per-broadcast recipient snapshot so fan-out at 10k
// recipients doesn't allocate a fresh []bcastTarget per event. A *[]bcastTarget
// is pooled (not the slice) to avoid boxing the slice header into the interface.
var connSnapPool = sync.Pool{New: func() any { s := make([]bcastTarget, 0, 256); return &s }}

func (h *Hub) broadcast(aid string, msg []byte) {
	// V10k Tier B: pre-encode the WS text frame ONCE for the whole room. Each
	// recipient's writePump ships the prepared frame without re-encoding the
	// header — gorilla docs benchmark this at 30-40% gateway CPU reduction
	// when N>1000. Fall back to raw bytes if PreparedMessage construction
	// fails (it only fails on > 64 MiB payloads — our envelopes are < 1 KiB,
	// so the fallback is defense-in-depth, not an expected path) OR if a Conn
	// was hand-crafted without the `prepared` channel (unit tests).
	pm, perr := websocket.NewPreparedMessage(websocket.TextMessage, msg)
	if perr != nil {
		log.Printf("ws prepared-message %s: %v (falling back to raw bytes)", aid, perr)
	}
	// Snapshot the recipient set under a brief RLock, then fan out WITHOUT the
	// lock held. Holding hub.mu across the whole fan-out (the per-conn channel
	// send AND a slow client's force-close) serialized every broadcast against
	// join/leave/updateRoomState — at 10k recipients that O(N) lock-hold is the
	// contention bottleneck. Bounding the hold to an O(N) pointer copy lets
	// joins/leaves + the fast-reject cache update proceed between fan-outs.
	//
	// Correctness: broadcasts are serial (single subscribe goroutine) and each
	// Conn has one channel, so per-conn ordering is preserved. trySend* /
	// closeWithCode are non-blocking + idempotent (closeOnce), so a Conn that
	// leaves between snapshot and send is safe (its leading done-check drops the
	// send). A Conn that joins after the snapshot misses this one event and
	// re-syncs via ROOM_SNAPSHOT on JOIN — identical to the prior under-lock
	// semantics. The pooled snapshot keeps fan-out allocation-free after warmup.
	bufp := connSnapPool.Get().(*[]bcastTarget)
	buf := (*bufp)[:0]
	h.mu.RLock()
	for c := range h.rooms[aid] {
		buf = append(buf, bcastTarget{c: c, epoch: c.roomEpoch.Load()})
	}
	h.mu.RUnlock()

	for _, t := range buf {
		// Skip a conn that left or rejoined a different auction since the
		// snapshot — its roomEpoch bumped, so it is no longer the member we
		// captured. Prevents delivering THIS room's frame to a re-homed conn.
		// (trySend*/closeWithCode are non-blocking + idempotent, so the send is
		// safe even if the conn is mid-teardown.)
		if t.c.roomEpoch.Load() != t.epoch {
			continue
		}
		// critical room events: enqueue or force-close the slow client (it
		// reconnects + re-snapshots) rather than silently lose the event. Use the
		// pre-encoded frame when it built AND the conn has a real socket; fall
		// back to raw bytes if PreparedMessage construction failed OR the conn was
		// hand-built without a socket (unit tests inspect the raw envelope; a
		// PreparedMessage is an opaque pre-encoded frame they can't decode). ws is
		// set once at creation and never reassigned, so this lock-free read is
		// race-free (unlike c.aid). Both paths land on the same ordered `crit` lane.
		if perr == nil && t.c.ws != nil {
			t.c.trySendPrepared(aid, pm)
		} else {
			t.c.trySendRaw(aid, msg)
		}
	}

	// Clear references + return the buffer to the pool so the pooled backing
	// array doesn't pin Conns (and their socket buffers) between broadcasts.
	for i := range buf {
		buf[i] = bcastTarget{}
	}
	*bufp = buf[:0]
	connSnapPool.Put(bufp)
}

// updateRoomState ratchets the gateway-side price/endAtMs cache from observed
// BID_ACCEPTED / AUCTION_SOLD / ROOM_SNAPSHOT events. Strictly monotonic on
// `priceCents` (compare numerically, keep the larger; if input is malformed,
// keep current). `endAtMs` mirrors the latest event so the fast-reject filter
// can defer past hammer time.
//
// Called from subscribe.fanout (under no lock — fanout is single-goroutine);
// this takes the hub write-lock briefly. Safe under heavy fanout because the
// write is O(1) per event (not per recipient) — recipients still see the same
// broadcast bytes whether the cache update happened or not.
func (h *Hub) updateRoomState(aid, priceCents string, endAtMs int64) {
	if aid == "" {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	rs := h.state[aid]
	if rs == nil {
		rs = &roomState{}
		h.state[aid] = rs
	}
	// Monotonic ratchet on price: parse + keep max. ParseInt error → leave
	// current (don't downgrade based on garbage).
	if priceCents != "" {
		newN, err1 := strconv.ParseInt(priceCents, 10, 64)
		curN, err2 := strconv.ParseInt(rs.priceCents, 10, 64)
		if err1 == nil && (rs.priceCents == "" || (err2 == nil && newN > curN)) {
			rs.priceCents = priceCents
		}
	}
	if endAtMs > rs.endAtMs {
		rs.endAtMs = endAtMs
	}
}

// roomStateSnap returns the gateway-side eventually-consistent room state for
// the fast-reject filter. Returns "" / 0 if no event has been observed yet
// (initial join window) — caller's responsibility is to fall through to Lua
// when the cache is cold (`priceCents == ""` → skip filter).
//
// Cheap read under RLock; caller copies the small value-typed roomState so the
// lock can be dropped immediately.
func (h *Hub) roomStateSnap(aid string) roomState {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if rs, ok := h.state[aid]; ok {
		return *rs
	}
	return roomState{}
}

// setMode caches the auction mode (issue #114) for a room from the ROOM_SNAPSHOT
// the gateway sends at join, so the BID_PLACE hot path can route sealed bids to
// the sealed engine (and skip the English fast-reject) without a per-bid lookup.
// A no-op for the empty/ENGLISH default.
func (h *Hub) setMode(aid, mode string) {
	if mode == "" || mode == model.ModeEnglish {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	rs := h.state[aid]
	if rs == nil {
		rs = &roomState{}
		h.state[aid] = rs
	}
	rs.mode = mode
}

// dropRoomState clears the cache for a terminal auction (SOLD/NO_BID/CANCELLED).
// Reduces map churn over long process lifetimes and makes the next auction
// reusing the same id (impossible by current id-gen, but defensive) start
// fresh. Called from subscribe.fanout when a terminal event is observed.
func (h *Hub) dropRoomState(aid string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.state, aid)
}

// markTerminalAndUpdate atomically updates the price (if non-empty) AND sets
// `terminal=true` under ONE write-lock acquisition. Used by the cap-hit path
// (BID_ACCEPTED with status="SOLD") so a concurrent BID_PLACE handler that
// reads the cache cannot observe the populated price WITHOUT also seeing
// terminal=true. Closes the codex pass-2 Q1 race between the v1 fix's
// populate-then-drop call pair.
//
// After this call, the cache entry exists with terminal=true. dropRoomState
// is called separately AFTER the terminal-flag set (or by the subsequent
// AUCTION_SOLD event handler) to eventually free the map entry. Any
// BID_PLACE arriving during the (populated+terminal, drop) window sees
// terminal=true and falls through to Lua → ERR_NOT_LIVE. Correct semantics.
func (h *Hub) markTerminalAndUpdate(aid, priceCents string, endAtMs int64) {
	if aid == "" {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	rs := h.state[aid]
	if rs == nil {
		rs = &roomState{}
		h.state[aid] = rs
	}
	if priceCents != "" {
		newN, err1 := strconv.ParseInt(priceCents, 10, 64)
		curN, err2 := strconv.ParseInt(rs.priceCents, 10, 64)
		if err1 == nil && (rs.priceCents == "" || (err2 == nil && newN > curN)) {
			rs.priceCents = priceCents
		}
	}
	if endAtMs > rs.endAtMs {
		rs.endAtMs = endAtMs
	}
	rs.terminal = true
}

// roomAIDs snapshots the auction ids with at least one connection.
func (h *Hub) roomAIDs() []string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	aids := make([]string, 0, len(h.rooms))
	for aid := range h.rooms {
		aids = append(aids, aid)
	}
	return aids
}

// subscribe drives room broadcast from the **canonical Redis Stream**. Pub/Sub is
// only a wakeup hint (RFC v2: non-authoritative) — on a hint, or on a periodic
// backstop tick, the gateway reads the Stream from the room's last-broadcast seq
// and fans out those events. A forged/stale Pub/Sub message not backed by the
// Stream therefore can never reach clients. Runs for the lifetime of ctx in a
// single goroutine (lastSeq needs no lock).
// T8 instrumentation: each fanout records broadcast latency (now - payload
// serverTimeMs, the Lua-authoritative Redis TIME at adjudication) and detects
// seq gaps against the prior lastSeq. Stream length is sampled on the backstop
// ticker so the gauge tracks the peak even under bursty traffic. auctioneer/m may
// be nil in unit tests that wire paths without those dependencies.
func (h *Hub) subscribe(ctx context.Context, st *store.Store, auctioneer *AuctioneerHooks, m *metrics.Registry) {
	ps := st.Redis().PSubscribe(ctx, store.PubPattern)
	defer func() { _ = ps.Close() }()
	ch := ps.Channel() // create once; go-redis starts a delivery goroutine here

	lastSeq := make(map[string]int64)
	fanout := func(aid string) {
		events, _, err := st.ReadEventsAfter(ctx, aid, streamIDForSeq(lastSeq[aid]))
		if err != nil {
			log.Printf("fanout read %s: %v", aid, err)
			return
		}
		for _, e := range events {
			// T8 §4.1 seq-gap detector: under healthy operation lastSeq advances by
			// exactly 1 per event (Lua-monotonic, no parallel writer). A jump > 1
			// after a successful read is a correctness break — record the magnitude
			// (not just "did it happen") so the load report can quantify the gap.
			// lastSeq==0 with a non-1 start means we joined a pre-existing stream
			// → not a gap (mid-room subscriber, no missed event).
			if m != nil && lastSeq[aid] > 0 && e.Seq > lastSeq[aid]+1 {
				m.SeqGap.Add(e.Seq - lastSeq[aid] - 1)
			}
			env := model.Envelope{
				Type: e.Type, AuctionID: aid, Seq: e.Seq,
				ServerTimeMs: time.Now().UnixMilli(), Data: json.RawMessage(e.Payload),
			}
			b, err := json.Marshal(env)
			if err != nil {
				// Corrupt Stream payload (e.g. a non-UTF-8 byte from a future
				// contributor's event type that breaks json.RawMessage round-trip):
				// surface in the log and SKIP the broadcast rather than fan out a
				// zero-byte / nil frame to every client in the room. The next sweep
				// re-reads the same Stream window so a transient marshal error gets
				// another chance; a persistent one shows up as a tight log loop.
				log.Printf("fanout marshal %s seq=%d type=%s: %v", aid, e.Seq, e.Type, err)
				continue
			}
			h.broadcast(aid, b)
			// V10k Tier C: ratchet the gateway-side roomState cache from this
			// observed event so dispatchWS BID_PLACE can fast-reject without a
			// Lua round-trip. Drop the cache on terminal events. Done AFTER
			// broadcast so a marshal-error skip above doesn't half-update state
			// (the `continue` jumps back to the next event without reaching here).
			updateRoomStateFromEvent(h, aid, e)
			if m != nil {
				// Broadcast latency = wall-clock now - payload.serverTimeMs (Lua TIME
				// at adjudication). Use a typed unmarshal of the small "serverTimeMs"
				// field rather than parse the full payload — the event payloads share
				// this field across BID_ACCEPTED / AUCTION_EXTENDED / AUCTION_SOLD /
				// AUCTION_NO_BID / AUCTION_CANCELLED. Failing to unmarshal (e.g. an
				// older event that predates the field) silently skips the observation,
				// which is the correct behaviour: no fake zero in p50.
				if ts := eventServerTimeMs(e.Payload); ts > 0 {
					m.BroadcastLatency.Observe(time.Since(time.UnixMilli(ts)))
				}
			}
			lastSeq[aid] = e.Seq
			// T7 §4.2: feed the auctioneer trigger detectors. nil-safe
			// for legacy paths (test harness, alt-mode startup) that
			// don't initialize the hooks. Bid path NEVER awaits these
			// (each method dispatches via `go a.fire(...)` internally).
			if auctioneer != nil {
				dispatchAuctioneer(ctx, auctioneer, aid, st, e)
			}
		}
	}

	// Stream-length sampler: XLEN is O(1) Redis-side but each call costs an RTT,
	// so we sample on the backstop ticker (every 2 s) NOT on every Pub/Sub hint
	// — at 500 bids/s the per-event sampling would mean ~500 XLEN RTTs/s. The
	// gauge tracks the peak (ObserveStreamLen is monotonic), so a 2 s cadence
	// is sufficient resolution to catch a backlog buildup without burning Redis.
	sampleStreamLens := func() {
		if m == nil {
			return
		}
		for _, aid := range h.roomAIDs() {
			if n, err := st.StreamLen(ctx, aid); err == nil {
				m.ObserveStreamLen(n)
			}
		}
	}

	ticker := time.NewTicker(fanoutSweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			for _, aid := range h.roomAIDs() { // backstop: independent of Pub/Sub delivery
				fanout(aid)
			}
			sampleStreamLens()
		case msg, ok := <-ch:
			if !ok {
				return
			}
			if aid := store.AIDFromPubChannel(msg.Channel); aid != "" {
				fanout(aid) // wakeup hint: read + broadcast the authoritative Stream
			}
		}
	}
}

// updateRoomStateFromEvent parses a Stream event payload and ratchets the hub's
// gateway-side roomState cache (V10k Tier C). The Lua-authored payloads share a
// consistent shape across BID_ACCEPTED / AUCTION_EXTENDED / AUCTION_SOLD /
// AUCTION_NO_BID / AUCTION_CANCELLED.
//
// Terminal events go through markTerminalAndUpdate (single write-lock that sets
// both the final-price ratchet AND `terminal=true`) so a concurrent BID_PLACE
// handler cannot observe a populated price without the terminal flag — closes
// the codex pass-2 race window.
//
// A malformed payload is silently skipped; the cache stays at its last good
// value and Lua remains authoritative.
func updateRoomStateFromEvent(h *Hub, aid string, e store.StreamEvent) {
	switch e.Type {
	case model.TypeAuctionSold:
		// Capture final price + mark terminal under ONE write-lock; the
		// subsequent dropRoomState frees the entry once no reader needs it.
		var p model.AuctionSoldData
		if err := json.Unmarshal([]byte(e.Payload), &p); err == nil {
			h.markTerminalAndUpdate(aid, p.AmountCents, 0)
		} else {
			h.markTerminalAndUpdate(aid, "", 0)
		}
		h.dropRoomState(aid)
	case model.TypeAuctionNoBid, model.TypeAuctionCancelled:
		// No final price to capture; mark terminal so any in-flight reader
		// sees terminal=true before the drop, then free the entry.
		h.markTerminalAndUpdate(aid, "", 0)
		h.dropRoomState(aid)
	case model.TypeBidAccepted:
		var p model.BidAcceptedData
		if err := json.Unmarshal([]byte(e.Payload), &p); err != nil {
			return
		}
		// Codex pass-2 Q1: cap-hit BID_ACCEPTED carries status=SOLD. Setting
		// price + terminal atomically (one write lock) closes the race where a
		// concurrent BID_PLACE could read the populated cache before the
		// subsequent dropRoomState fired. After this call: cache exists with
		// terminal=true → fast-reject path sees terminal and defers to Lua's
		// ERR_NOT_LIVE. The subsequent dropRoomState (or the AUCTION_SOLD event
		// that lands next in the same Lua atomic execution) frees the entry.
		if p.Status == model.StateSold {
			h.markTerminalAndUpdate(aid, p.AmountCents, p.EndAtMs)
			h.dropRoomState(aid)
			return
		}
		h.updateRoomState(aid, p.AmountCents, p.EndAtMs)
	case model.TypeAuctionExtended:
		var p model.AuctionExtendedData
		if err := json.Unmarshal([]byte(e.Payload), &p); err != nil {
			return
		}
		// AuctionExtended doesn't carry a fresh amountCents — pass "" to skip
		// the price ratchet, only update endAtMs.
		h.updateRoomState(aid, "", p.EndAtMs)
	case model.TypeAuctionRevealed:
		// PR #117 review (hardening): sealed close emits AUCTION_REVEALED then
		// AUCTION_SOLD with adjacent seqs. close_auction_sealed.lua already sets
		// state.status=SOLD BEFORE the REVEALED event, so Lua rejects any further
		// BID_PLACE as ERR_NOT_LIVE; but the gateway's roomState.terminal flag is
		// not flipped until AUCTION_SOLD arrives. Marking terminal here too
		// closes that brief REVEALED→SOLD fast-reject window without changing
		// Lua's authority. Carry the revealed amount as the final cache value.
		var p model.AuctionRevealedData
		if err := json.Unmarshal([]byte(e.Payload), &p); err == nil {
			h.markTerminalAndUpdate(aid, p.AmountCents, 0)
		} else {
			h.markTerminalAndUpdate(aid, "", 0)
		}
	}
}

// eventServerTimeMs extracts the optional "serverTimeMs" field from a Lua-authored
// payload (cjson output). All hot-path payloads include it (model.BidAcceptedData
// etc.); returns 0 on any decode/missing-field condition so the caller can skip
// the observation without poisoning percentiles.
func eventServerTimeMs(payload string) int64 {
	var probe struct {
		ServerTimeMs int64 `json:"serverTimeMs"`
	}
	if err := json.Unmarshal([]byte(payload), &probe); err != nil {
		return 0
	}
	return probe.ServerTimeMs
}

// outboundFrame is one queued frame on the critical lane: either raw
// pre-marshalled bytes (a direct ack / rejection / snapshot / catchup, or a
// broadcast fallback) OR a gorilla PreparedMessage (a pre-encoded broadcast,
// shared across recipients). Exactly one field is set. Carrying both on ONE
// FIFO lane keeps sequenced frames in wire order (see Conn.crit).
type outboundFrame struct {
	raw []byte
	pm  *websocket.PreparedMessage
}

// Conn is one WS client connection with a serialized write pump and a two-lane
// backpressure split (T5):
//   - `crit`  — CRITICAL frames (bid acks, BID_REJECTED, AUCTION_* terminals,
//     ROOM_SNAPSHOT, catchup, room broadcasts). Must be delivered, IN ORDER; if
//     the buffer fills, the connection is force-closed so the client reconnects
//     and re-syncs (never a silent loss). One ordered lane (carrying raw OR
//     prepared frames) so a fan-out broadcast can't reorder ahead of a queued
//     ack/snapshot or vice-versa.
//   - `lossy` — BEST-EFFORT frames (PONG heartbeat; future presence/chat). Dropped
//     individually when full, without tearing down the connection.
//
// Shutdown is signalled by closing `done` (once); the send channels are never
// closed, so concurrent senders (direct ack + Pub/Sub broadcast) can't panic on a
// closed channel.
type Conn struct {
	ws *websocket.Conn
	// wbuf is the flush-on-demand coalescing write buffer sitting UNDER ws:
	// gorilla writes every frame through it, and writePump flushes it once per
	// drained batch so a fan-out burst becomes a single TCP write (see
	// ws_coalesce.go). nil for hand-built unit-test Conns (no real socket) — all
	// flush sites are nil-guarded.
	wbuf *bufferedConn
	// crit is the SINGLE ordered critical lane: every must-deliver frame —
	// direct bid acks, BID_REJECTED, ROOM_SNAPSHOT, ROOM_JOIN catchup, AND room
	// broadcasts — flows through it in FIFO enqueue order, so the wire order is
	// the correct order (catchup → snapshot → later broadcasts; an ack never
	// overtakes the older broadcasts queued before it). It carries an
	// outboundFrame union so a broadcast can ride as a gorilla PreparedMessage
	// (V10k Tier B: the frame header is pre-encoded ONCE per event and shared by
	// all recipients — ~30-40% gateway CPU saved at 10k fanout) while one-off
	// frames ride as raw bytes. Full lane → force-close (client reconnects +
	// re-syncs). A single lane (vs the old send+prepared split) is what keeps
	// sequenced frames from reordering across lanes (codex review).
	crit  chan outboundFrame
	lossy chan []byte // best-effort lane (PONG heartbeat): drop the frame if full
	done  chan struct{}
	// ROOM_JOIN barrier: while a conn is initializing (catchup + ROOM_SNAPSHOT),
	// `joining` is true and the fan-out buffers room broadcasts into `pending`
	// (under pendMu) instead of `crit`; once init is enqueued, spliceAndGoLive
	// drains pending into crit IN ARRIVAL ORDER and clears joining. This stops a
	// live broadcast from overtaking the conn's catchup/snapshot on the wire
	// (which the client would drop, then ROOM_SNAPSHOT would regress lastSeq —
	// codex review HIGH). The flag is INVERTED (default false = not joining =
	// deliver straight to crit) so the steady-state fast path is a single atomic
	// load — the lock-free fan-out (#118) is unchanged outside the join window —
	// AND a hand-built conn (tests) delivers normally without extra setup. Only a
	// conn mid-join takes pendMu.
	joining     atomic.Bool
	pendMu      sync.Mutex
	pending     []outboundFrame
	closeOnce   sync.Once
	userID      string
	displayName string // human nickname, resolved at connect (falls back to userID)
	aid         string
	// roomEpoch bumps on every hub.join/leave (membership change) for this conn.
	// Hub.broadcast snapshots it with each recipient and re-checks it before the
	// lock-free send, so a conn that left or rejoined a DIFFERENT auction between
	// snapshot and send is skipped (never delivered this room's frame). Atomic so
	// the lock-free fan-out reads it without hub.mu. (#118)
	roomEpoch atomic.Uint64
	// metrics is the process-wide T8 registry. Nil-safe (every Observe call
	// checks for nil) so unit tests can construct a Conn without wiring it.
	metrics *metrics.Registry

	// closeCode / closeReason are set under closeOnce BEFORE close(done) and
	// then read by writePump's defer (flushClose) AFTER it receives done. The
	// close(done) → <-c.done synchronizes-with edge in Go's memory model makes
	// the write→read race-free without a mutex. Writers MUST go through
	// closeWithCode; readers MUST only access these in flushClose.
	closeCode   int
	closeReason string
	pingPeriod  time.Duration
}

// close tears the connection down exactly once: signal writePump via done and
// close the socket (which unblocks the read loop). Nil-safe for unit-test Conns.
// Callers that need to signal an application-level reason (e.g. backpressure
// drop) use closeWithCode instead so the client can distinguish a typed close
// from a raw socket failure.
func (c *Conn) close() {
	c.closeWithCode(0, "")
}

// closeWithCode tears down the connection, recording an optional typed WS
// close reason (e.g. application code 4000 BACKPRESSURE_DROP) for writePump
// to emit on its way out. code == 0 means "no typed close frame" — used by
// close() and the read/write error paths where the reason is "socket gone".
// closeOnce guarantees one teardown across concurrent callers.
//
// MUST be non-blocking: this is invoked from the broadcast fan-out goroutine
// (lock-free since #118) and the direct-send paths. The actual CLOSE-frame
// WriteControl + ws.Close() are deferred to writePump's flushClose
// (single-writer goroutine), so a congested socket can't stall the fan-out —
// see flushClose for the bounded deadline. Fairy PR #48 review: a
// writeWait-deadlined WriteControl here would have blocked the fan-out for up
// to 10s when the socket was full.
func (c *Conn) closeWithCode(code int, reason string) {
	c.closeOnce.Do(func() {
		c.closeCode = code
		c.closeReason = reason
		if c.done != nil {
			close(c.done)
		}
	})
}

// enqueueCritical puts one frame on the ordered critical lane, or — if the lane
// is full — force-closes the connection (client reconnects and re-syncs via
// catchup/ROOM_SNAPSHOT) rather than silently losing a critical event. Non-
// blocking, so one slow client never stalls the broadcast to the rest of the
// room. `aid` labels the force-close log (passed in, not read from the mutable
// c.aid, because the lock-free fan-out (#118) would otherwise race a concurrent
// ROOM_JOIN re-home).
//
// The leading non-blocking done-check drops post-close sends instead of letting
// them accumulate in the buffer: hub.leave runs in the read goroutine's defer,
// so there's a window after close() where the conn still sits in hub.rooms and
// would otherwise receive (un-drained) broadcast frames.
//
// T8 instrumentation: the BackpressureDrop counter is incremented on each
// force-close so the load report ties slow-client trims to ack-p95 spikes
// (V9 §4.3: "force-close of the slow client counts as a high sample, NOT
// 剔除"). metrics may be nil if the conn was created without a registry (tests).
func (c *Conn) enqueueCritical(f outboundFrame, aid string) {
	select {
	case <-c.done:
		return
	default:
	}
	select {
	case c.crit <- f:
	default:
		log.Printf("ws backpressure: force-closing slow client (room=%s user=%s)", aid, c.userID)
		if c.metrics != nil {
			c.metrics.BackpressureDrop.Inc()
		}
		// Emit a typed close (code 4000 BACKPRESSURE_DROP) so the client can
		// distinguish this from a raw network failure and back off its
		// reconnect intelligently instead of tight-looping into another drop.
		c.closeWithCode(closeCodeBackpressureDrop, "backpressure")
	}
}

// enqueueBroadcast routes a fan-out frame: straight to the critical lane when the
// conn is NOT joining, or into the per-conn pending buffer while it IS joining, so
// a live room event can't overtake the conn's ROOM_JOIN catchup/snapshot on the
// wire (which the client would drop, then ROOM_SNAPSHOT would regress lastSeq —
// codex review HIGH). Fast path: a single atomic `joining` load + the normal
// enqueue, leaving the lock-free fan-out (#118) unchanged for the steady state.
// Slow path (mid-join only) takes pendMu and re-checks joining (double-checked
// locking: spliceAndGoLive may clear it + drain pending while we wait for the
// lock, so the re-check routes a just-missed broadcast to crit rather than a
// pending slice that's already been spliced).
func (c *Conn) enqueueBroadcast(f outboundFrame, aid string) {
	if !c.joining.Load() {
		c.enqueueCritical(f, aid)
		return
	}
	select {
	case <-c.done:
		return
	default:
	}
	c.pendMu.Lock()
	if !c.joining.Load() {
		c.pendMu.Unlock()
		c.enqueueCritical(f, aid)
		return
	}
	if len(c.pending) >= sendBufFrames {
		// Join is dragging under a broadcast flood — treat like a full critical
		// lane: force-close (client reconnects + re-syncs). Bounds pending memory.
		c.pendMu.Unlock()
		log.Printf("ws backpressure: force-closing slow client (room=%s user=%s, join-pending full)", aid, c.userID)
		if c.metrics != nil {
			c.metrics.BackpressureDrop.Inc()
		}
		c.closeWithCode(closeCodeBackpressureDrop, "backpressure")
		return
	}
	c.pending = append(c.pending, f)
	c.pendMu.Unlock()
}

// beginJoinBarrier puts the conn into buffering mode for a (re-)JOIN: subsequent
// fan-out broadcasts queue into pending until spliceAndGoLive runs. Call BEFORE
// hub.join so the very first broadcast after membership is buffered, not raced
// onto crit ahead of the init frames. Resets pending for a re-home re-JOIN.
func (c *Conn) beginJoinBarrier() {
	c.pendMu.Lock()
	c.joining.Store(true)
	c.pending = c.pending[:0]
	c.pendMu.Unlock()
}

// spliceAndGoLive flushes the broadcasts buffered during a join into the critical
// lane (preserving fan-out arrival order, i.e. seq order) AFTER the init frames
// already enqueued there, then clears `joining` — all under pendMu so a
// concurrent enqueueBroadcast can't interleave a newer broadcast between the
// buffered frames and the live stream. Runs on every ROOM_JOIN exit path (via
// defer) so the conn never stays stuck buffering, even on a snapshot error.
func (c *Conn) spliceAndGoLive() {
	c.pendMu.Lock()
	defer c.pendMu.Unlock()
	for _, f := range c.pending {
		c.enqueueCritical(f, c.aid)
	}
	c.pending = nil
	c.joining.Store(false)
}

// trySend enqueues a one-off CRITICAL raw frame (direct bid ack, BID_REJECTED,
// ROOM_SNAPSHOT, ROOM_JOIN catchup). Goes straight to crit (these are init/direct
// frames, never buffered). Uses the connection's own aid (the direct paths run on
// the read goroutine, where c.aid is stable).
func (c *Conn) trySend(b []byte) { c.enqueueCritical(outboundFrame{raw: b}, c.aid) }

// trySendPrepared enqueues a CRITICAL pre-encoded broadcast frame for fan-out.
// The gorilla PreparedMessage caches the frame header so writePump ships it
// without re-encoding per recipient — at 10k recipients × 500 bid/s a
// measurable gateway CPU win (V10k Tier B). `aid` is the broadcast room (not
// the mutable c.aid) because the fan-out runs lock-free (#118).
func (c *Conn) trySendPrepared(aid string, pm *websocket.PreparedMessage) {
	c.enqueueBroadcast(outboundFrame{pm: pm}, aid)
}

// trySendRaw is the raw-bytes twin of trySendPrepared, used by Hub.broadcast as
// the (defense-in-depth) fallback when PreparedMessage construction failed or a
// unit-test conn was hand-built. Same ordered critical lane + backpressure. (#118)
func (c *Conn) trySendRaw(aid string, b []byte) {
	c.enqueueBroadcast(outboundFrame{raw: b}, aid)
}

// trySendLossy enqueues a BEST-EFFORT frame, dropping it (and keeping the connection)
// when the lossy buffer is full — so a slow client is never force-closed over a
// replaceable frame like a heartbeat. Same post-close drop as trySend.
func (c *Conn) trySendLossy(b []byte) {
	select {
	case <-c.done:
		return
	default:
	}
	select {
	case c.lossy <- b:
	default: // drop the frame; the connection survives
	}
}

// writePump serializes all socket writes, draining the CRITICAL lane with
// best-effort priority over the lossy lane: a pending critical frame always
// pre-empts a pending lossy frame in the leading non-blocking poll, so a lossy
// flood can delay a critical frame by at most one in-flight lossy write (Go's
// select is pseudo-random when multiple cases are ready, but the loop tops back
// to the critical-first poll on every iteration). Also drives server-initiated
// PINGs on `pingPeriod` so a silently-dead client trips the read deadline (set
// by handleWS and refreshed in the PONG handler) and is reaped promptly.
func (c *Conn) writePump() {
	pingPeriod := c.pingPeriod
	if pingPeriod <= 0 {
		_, pingPeriod = keepaliveSnapshot()
	}
	ping := time.NewTicker(pingPeriod)
	defer ping.Stop()
	defer c.flushClose() // flush the batch, emit typed CLOSE (if any), close socket
	for {
		// Critical-first: a queued critical frame pre-empts lossy/ping. `crit` is
		// a SINGLE FIFO lane, so acks, BID_REJECTED, ROOM_SNAPSHOT, catchup, and
		// room broadcasts all leave in enqueue order — no cross-lane reordering
		// (e.g. a fresh broadcast can't overtake a just-queued snapshot, and the
		// duplicate direct ack can't overtake the older broadcasts queued before
		// it). The leading non-blocking poll keeps crit ahead of lossy; the inner
		// select blocks on everything once crit is momentarily empty.
		ok := true
		select {
		case <-c.done:
			return
		case f := <-c.crit:
			ok = c.writeFrame(f)
		default:
			select {
			case <-c.done:
				return
			case f := <-c.crit:
				ok = c.writeFrame(f)
			case msg := <-c.lossy:
				ok = c.write(msg)
			case <-ping.C:
				ok = c.writePing()
			}
		}
		if !ok {
			return
		}
		// Coalesce: write every frame ALREADY queued into the buffer, then flush
		// ONCE — collapsing a fan-out burst into a single TCP write. coalesceDrain
		// never waits to accumulate, so this adds zero latency: only frames the
		// senders already enqueued are batched.
		if !c.coalesceDrain() {
			return
		}
		if !c.flush() {
			return
		}
		// Service a DUE keepalive PING even when `crit` is still non-empty. The
		// critical-first poll above can keep choosing `crit` under a sustained
		// (not-yet-full) backlog and never reach the blocking select's ping.C, so
		// without this an observer that only RECEIVES (never sends inbound frames,
		// so nothing else refreshes its server-side read deadline) could be reaped
		// by that deadline past pongWait despite a healthy socket (codex review).
		// A control PING interleaves safely with data frames and does not affect
		// sequenced data ordering. Non-blocking: 99.99% of iterations hit default.
		select {
		case <-ping.C:
			if !c.writePing() || !c.flush() {
				return
			}
		default:
		}
	}
}

// writeFrame ships one critical frame: a pre-encoded gorilla PreparedMessage
// when set (the Tier-B broadcast fast path), else raw bytes. Returns false (conn
// torn down) on a socket error so writePump exits.
func (c *Conn) writeFrame(f outboundFrame) bool {
	if f.pm != nil {
		return c.writePrepared(f.pm)
	}
	return c.write(f.raw)
}

// maxDrainFrames bounds ONE coalesced batch. Paired with the per-frame done
// check in coalesceDrain, it stops a force-closed slow client from pinning
// writePump while we keep draining frames into a connection already marked
// closed: without these bounds a trickle-reader can hold each buffer-full
// auto-flush just under writeWait, so draining a full ~2000-frame backlog could
// pin the goroutine for minutes AFTER the backpressure force-close fired (codex
// review HIGH). 256 frames still collapses a fan-out burst into very few socket
// writes (the 8 KiB buffer auto-flushes ~every 32 envelopes) — orders of
// magnitude fewer syscalls than one-per-frame — while returning to writePump's
// top (done + ping + critical-first poll) promptly.
const maxDrainFrames = 256

// coalesceDrain writes frames ALREADY queued into the coalescing buffer without
// blocking, so a fan-out burst collapses into one flush. writePump is the SOLE
// receiver of these channels, so len() is a safe lower bound (senders only add)
// and each `<-` is guaranteed not to block. It drains the single critical lane
// (crit) — acks, rejections, snapshots, catchup, and broadcasts interleaved
// EXACTLY as enqueued, so nothing reorders — before the best-effort lossy lane.
// crit consuming the maxDrainFrames budget before lossy is intended: lossy is
// best-effort (PONG heartbeat) and must yield to critical traffic; there is no
// critical-frame starvation because crit is ONE FIFO lane (all critical types
// share it fairly in arrival order).
//
// Two bounds keep a closing/slow conn from pinning writePump (codex review HIGH):
//   - a per-frame non-blocking `done` check, so a backpressure / schema / read
//     close stops the drain promptly — flushClose then ships only the already-
//     buffered tail (≤ one in-flight write), instead of grinding the whole
//     backlog out to a trickle-reader over many writeWait windows; and
//   - maxDrainFrames, so even absent a close the loop returns to writePump's top
//     (done + ping) regularly under a sustained flood.
//
// Returns false if a write failed OR the conn is closing → writePump exits to
// flushClose (which flushes the buffered tail under closeFrameWait).
func (c *Conn) coalesceDrain() bool {
	drained := 0
	for n := len(c.crit); n > 0 && drained < maxDrainFrames; n-- {
		select {
		case <-c.done:
			return false
		default:
		}
		if !c.writeFrame(<-c.crit) {
			return false
		}
		drained++
	}
	for n := len(c.lossy); n > 0 && drained < maxDrainFrames; n-- {
		select {
		case <-c.done:
			return false
		default:
		}
		if !c.write(<-c.lossy) {
			return false
		}
		drained++
	}
	return true
}

// flush drains the coalesced batch to the socket as a single write. Returns
// false (and tears the conn down) on a socket error so writePump exits. Nil-safe
// for hand-built unit-test Conns that have no buffered wrapper.
func (c *Conn) flush() bool {
	if c.wbuf == nil {
		return true
	}
	// flushWithDeadline sets writeWait AND flushes atomically, so a concurrent
	// control-frame SetWriteDeadline (read goroutine) can't re-arm this write's
	// deadline mid-flight — the batch flush is hard-bounded by writeWait.
	if err := c.wbuf.flushWithDeadline(time.Now().Add(writeWait)); err != nil {
		c.close()
		return false
	}
	return true
}

// writePing emits a server-initiated PING (best-effort keepalive). The frame is
// buffered like any other write; the following flush ships it. A stuck socket
// trips the bounded write deadline; the client's PONG resets the server read
// deadline (no PONG within pongWait → ReadMessage in handleWS errors → cleanup).
// Returns false on error so writePump exits; nil-safe for unit-test Conns.
func (c *Conn) writePing() bool {
	if c.ws == nil {
		return true
	}
	_ = c.ws.SetWriteDeadline(time.Now().Add(writeWait))
	if err := c.ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeWait)); err != nil {
		c.close()
		return false
	}
	return true
}

// writePrepared ships a gorilla.PreparedMessage to the socket. Same write
// deadline as `write(msg []byte)`; on error closes the conn so writePump
// exits. Unlike `write`, there's no oversize guard — PreparedMessage size
// is bounded by the producer (broadcasts encode `model.Envelope`s ≤ ~1 KiB
// each, well below maxOutboundFrameBytes).
func (c *Conn) writePrepared(pm *websocket.PreparedMessage) bool {
	if c.ws == nil || pm == nil {
		return true // nothing to write; allow loop continuation
	}
	_ = c.ws.SetWriteDeadline(time.Now().Add(writeWait))
	if err := c.ws.WritePreparedMessage(pm); err != nil {
		c.close()
		return false
	}
	return true
}

// flushClose runs on writePump's exit path: it emits the typed CLOSE frame
// (when closeWithCode set a non-zero code) and closes the socket. Running
// here — not in closeWithCode — keeps the CLOSE-frame WriteControl off the
// broadcast goroutine and out of hub.RLock, so a congested socket can stall
// at most this single conn's writePump (bounded by closeFrameWait) instead
// of the whole room's fanout. Safe to read c.closeCode/c.closeReason without
// a lock: closeWithCode writes them under closeOnce *before* close(done),
// and we only get here after writePump observes done — the channel close
// is the synchronizes-with edge.
func (c *Conn) flushClose() {
	if c.ws == nil {
		return
	}
	if code := c.closeCode; code > 0 {
		_ = c.ws.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(code, c.closeReason),
			time.Now().Add(closeFrameWait),
		)
	}
	// Flush whatever is buffered before we RST the socket: the typed CLOSE frame
	// just written above, plus any frame still sitting in the coalescing buffer
	// (e.g. a schema-mismatch CLOSE the read goroutine routed through closeWithCode,
	// or the ≤256-frame tail coalesceDrain left when it aborted on done). Without
	// this, coalesced bytes — including that close frame — are lost on ws.Close()
	// and the client sees a bare connection reset instead of the code. Bound the
	// flush with an explicit deadline: the per-frame deadline from the last drained
	// write may have expired (or never been set on a code==0 close), so a dead peer
	// must not be able to hang teardown here.
	if c.wbuf != nil {
		_ = c.wbuf.flushWithDeadline(time.Now().Add(closeFrameWait))
	}
	_ = c.ws.Close()
}

// write sends one frame with a bounded deadline; on error (or oversize frame)
// it closes the conn and reports false so writePump exits. The outbound size
// bound is defensive — today's frames are small; the check fails-fast for a
// future contributor who adds a fat event type rather than producing weird
// socket behavior.
func (c *Conn) write(msg []byte) bool {
	if len(msg) > maxOutboundFrameBytes {
		log.Printf("ws outbound frame oversized (len=%d > %d room=%s user=%s)", len(msg), maxOutboundFrameBytes, c.aid, c.userID)
		c.close()
		return false
	}
	_ = c.ws.SetWriteDeadline(time.Now().Add(writeWait))
	if err := c.ws.WriteMessage(websocket.TextMessage, msg); err != nil {
		c.close()
		return false
	}
	return true
}

func (c *Conn) push(env model.Envelope) {
	b, err := json.Marshal(env)
	if err != nil {
		return
	}
	c.trySend(b)
}

// pushLossy marshals + enqueues a best-effort frame (heartbeat).
func (c *Conn) pushLossy(env model.Envelope) {
	b, err := json.Marshal(env)
	if err != nil {
		return
	}
	c.trySendLossy(b)
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	upgrader := websocket.Upgrader{
		CheckOrigin: func(req *http.Request) bool {
			return auth.OriginAllowed(req.Header.Get("Origin"), s.cfg.FrontendOrigin)
		},
	}
	userID, err := auth.Verify(s.cfg.JWTSecret, r.URL.Query().Get("token"))
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	// Wrap the ResponseWriter so the net.Conn gorilla hijacks is our
	// flush-on-demand bufferedConn (write coalescing — see ws_coalesce.go).
	var wbuf *bufferedConn
	ws, err := upgrader.Upgrade(&coalescingUpgradeWriter{ResponseWriter: w, out: &wbuf}, r, nil)
	if err != nil {
		return // upgrader already wrote the error
	}
	// gorilla wrote the 101 Switching Protocols response into the coalescing
	// buffer (it writes the handshake via netConn.Write, now buffered). Flush it
	// NOW — before writePump starts — so the client completes the handshake
	// immediately; otherwise it would sit unsent until writePump drains its first
	// frame (up to a full pingPeriod away), hanging the connection. Safe to flush
	// here without the buffer mutex: no writePump or read-side control write
	// exists yet (ReadMessage is not called until below).
	if wbuf != nil {
		// Bound the handshake flush. The Upgrader uses HandshakeTimeout=0 (no
		// deadline), and the actual 101 socket write now happens HERE — not
		// inside Upgrade's netConn.Write — so without a deadline a slow/non-
		// reading peer could hang this handler goroutine on the flush.
		// flushWithDeadline sets writeWait + flushes atomically; writePump's
		// later batch flushes each re-set their own deadline, so no clear needed.
		if err := wbuf.flushWithDeadline(time.Now().Add(writeWait)); err != nil {
			_ = ws.Close()
			return
		}
	}
	// §8 WS hardening: bound inbound frame size. Client messages (BID_PLACE,
	// ROOM_JOIN, PING) are tiny; a multi-KB frame is abuse. Gorilla closes the
	// connection with 1009 when the limit is exceeded.
	ws.SetReadLimit(maxWSFrameBytes)
	connPongWait, connPingPeriod := keepaliveSnapshot()
	// WS keepalive: a read deadline + PONG handler refresh (paired with the
	// PING ticker in writePump). Without this a silently-dead client (cable
	// unplugged, NAT timeout, OS sleep) blocks ws.ReadMessage() for the OS-
	// level TCP timeout (~2h on Linux) and leaks the read + writePump
	// goroutines for the lifetime of that window. The handler refreshes the
	// deadline on every PONG so a healthy client never trips it.
	_ = ws.SetReadDeadline(time.Now().Add(connPongWait))
	ws.SetPongHandler(func(string) error {
		_ = ws.SetReadDeadline(time.Now().Add(connPongWait))
		return nil
	})
	// Custom PING handler: reply PONG AND flush it immediately. gorilla's default
	// handler replies via WriteControl on THIS read goroutine, which only writes
	// into the coalescing buffer — and only writePump flushes that buffer. An idle
	// writePump would leave the PONG unsent until its next frame or PING tick (up
	// to pingPeriod away), tripping the read-timeout of a client that pings the
	// server. WriteControl sets the socket write deadline; the flush ships the
	// PONG now. (CLOSE echoes don't need this: they end the read loop, so
	// flushClose flushes them at teardown. PING does NOT end the loop.) The flush
	// is mutex-guarded against writePump's concurrent writes/flush (see bufferedConn).
	ws.SetPingHandler(func(appData string) error {
		err := ws.WriteControl(websocket.PongMessage, []byte(appData), time.Now().Add(writeWait))
		if err == nil && wbuf != nil {
			err = wbuf.flushWithDeadline(time.Now().Add(writeWait))
		}
		if err == websocket.ErrCloseSent {
			return nil
		}
		return err
	})
	// Resolve the human nickname once at connect so bids broadcast a display name,
	// not the opaque user id. Falls back to the id if the lookup fails/empty.
	display := userID
	if nick, err := s.st.UserNickname(r.Context(), userID); err == nil && nick != "" {
		display = nick
	}
	c := &Conn{
		ws:     ws,
		wbuf:   wbuf,
		crit:   make(chan outboundFrame, sendBufFrames),
		lossy:  make(chan []byte, 16),
		done:   make(chan struct{}),
		userID: userID, displayName: display,
		metrics: s.metrics, pingPeriod: connPingPeriod,
	}
	if s.metrics != nil {
		s.metrics.ActiveConns.Add(1)
	}
	go c.writePump()
	defer func() {
		s.hub.leave(c)
		c.close()
		if s.metrics != nil {
			s.metrics.ActiveConns.Add(-1)
		}
	}()

	for {
		_, raw, err := ws.ReadMessage()
		if err != nil {
			return
		}
		var frame struct {
			model.Envelope
			SchemaVersion int `json:"schemaVersion"`
		}
		if err := json.Unmarshal(raw, &frame); err != nil {
			continue
		}
		if frame.SchemaVersion != model.SchemaVersion {
			// Route the typed protocol CLOSE through writePump (closeWithCode →
			// flushClose) rather than writing it inline here. writePump is then the
			// SOLE message-writer: emitting a frame from this read goroutine while
			// writePump may be mid-WriteMessage would trip gorilla's concurrent-
			// message-write panic guard (conn.go c.isWriting). The CLOSE control
			// frame flushClose emits carries the same code 4001, so the client still
			// observes a typed CloseError. Returning unblocks the deferred cleanup;
			// writePump flushes the close frame and closes the socket.
			c.closeWithCode(schemaMismatchCloseCode, "schema mismatch")
			return
		}
		s.dispatchWS(r.Context(), c, frame.Envelope)
	}
}

func (s *Server) dispatchWS(ctx context.Context, c *Conn, env model.Envelope) {
	switch env.Type {
	case model.TypePing:
		// heartbeat is best-effort: a dropped PONG must not force-close a busy client.
		c.pushLossy(model.Envelope{Type: model.TypePong, ServerTimeMs: time.Now().UnixMilli()})

	case model.TypeRoomJoin:
		var d model.RoomJoinData
		_ = json.Unmarshal(env.Data, &d)
		if d.AuctionID == "" {
			return
		}
		// Leave any previously joined room first, otherwise a re-JOIN to a
		// different auction would leave a stale reference in the old room's map
		// (memory leak + send-on-closed-channel panic on later broadcast).
		if c.aid != "" {
			s.hub.leave(c)
		}
		c.aid = d.AuctionID
		// ROOM_JOIN barrier: buffer live room broadcasts (begin) until the catchup
		// + ROOM_SNAPSHOT below are enqueued, then splice them in after (defer), so
		// a live event can't overtake the init frames on the wire and make the
		// client drop/regress them (codex review HIGH). The defer runs on EVERY
		// exit path (incl. the snapshot-error return) so the conn never stays stuck
		// buffering. beginJoinBarrier MUST precede hub.join so the first post-join
		// broadcast is buffered, not raced onto crit.
		c.beginJoinBarrier()
		s.hub.join(d.AuctionID, c)
		defer c.spliceAndGoLive()
		// T8 catchup latency (V9 §4.2: 200 events < 1s p95). Only Observe when
		// catchup actually runs (lastSeq > 0 and we read at least one event) so the
		// histogram isn't polluted by trivial joins. Capture t0 before the snapshot
		// read so the snapshot RTT is part of the budget too (the client can't apply
		// catchup events without it).
		t0 := time.Now()
		snap, err := s.st.Snapshot(ctx, d.AuctionID)
		if err != nil {
			log.Printf("snapshot %s: %v", d.AuctionID, err)
			return
		}
		// Catchup: replay the missed Stream events (seq > lastSeq) before the
		// snapshot when the gap is small. An up-to-date client (lastSeq >= seq) or
		// a gap > catchupMaxGap falls back to the snapshot only (proto: gap > 200 →
		// snapshot). lastSeq 0 with a small backlog replays the whole short history.
		// Catchup reads the authoritative Stream, not Pub/Sub.
		catchupRan := false
		if snap.Seq > d.LastSeq && snap.Seq-d.LastSeq <= catchupMaxGap {
			if events, _, err := s.st.ReadEventsAfter(ctx, d.AuctionID, streamIDForSeq(d.LastSeq)); err == nil {
				for _, e := range eventsUpToSnapshot(events, snap.Seq) {
					c.push(model.Envelope{
						Type: e.Type, AuctionID: d.AuctionID, Seq: e.Seq,
						ServerTimeMs: time.Now().UnixMilli(), Data: json.RawMessage(e.Payload),
					})
					catchupRan = true
				}
			}
		}
		snap.ViewerCount = s.hub.viewerCount(d.AuctionID) // 参与人数 at join time (incl. self)
		if snap.Rules != nil {
			s.hub.setMode(d.AuctionID, snap.Rules.Mode) // cache mode for the BID_PLACE hot path
		}
		if out, err := model.NewEnvelope(model.TypeRoomSnapshot, d.AuctionID, snap.Seq, snap); err == nil {
			c.push(out)
		}
		// catchupRan == we replayed ≥1 Stream event into the snapshot. That's the
		// "user is paying catchup latency" case the §4.2 1-s budget targets — both
		// a reconnect with lastSeq > 0 AND a cold-join into an active room (lastSeq=0,
		// short history) need to land inside the budget. Earlier guard had
		// `d.LastSeq > 0` which silently dropped cold-joins, making the SLO
		// unverifiable in the load harness (observers join with lastSeq=0).
		if catchupRan && c.metrics != nil {
			c.metrics.CatchupLatency.Observe(time.Since(t0))
		}

	case model.TypeBidPlace:
		handlerStart := time.Now() // P8: full handler span (decode → ack push)
		var d model.BidPlaceData
		_ = json.Unmarshal(env.Data, &d)
		// §8: strictly validate AND canonicalize the amount BEFORE the Lua call. A
		// non-numeric/non-positive amount is a malformed message (ERR_BAD_INPUT),
		// not a business "too low" (ERR_TOO_LOW). place_bid.lua echoes ARGV[3]
		// verbatim into the ack/Stream/broadcast, so canonicalize here ("0123" /
		// "+123" -> "123") to keep money-as-string canonical on the wire. Range
		// checks vs increment/cap need auction state and stay in place_bid.lua.
		// T8 ack latency captures the full server-side BID_PLACE processing cost,
		// including the V10k Tier C fast-reject path (started here so the metric
		// reflects user-visible cost regardless of which branch handled the bid).
		ackStart := time.Now()
		amount, ok := canonicalAmount(d.AmountCents)
		if c.aid == "" || d.ClientBidID == "" || len(d.ClientBidID) > maxClientBidIDLen || !ok {
			c.push(rejected(c.aid, model.CodeErrBadInput))
			if c.metrics != nil {
				c.metrics.AckLatency.Observe(time.Since(ackStart))
				c.metrics.BidsRejected.Inc()
			}
			return
		}
		// V10k Tier C: gateway-side fast-reject. The hub's roomState cache holds
		// the latest BID_ACCEPTED amount we fanned out for this auction. If the
		// incoming bid is <= that cached price AND the bid is NOT a duplicate
		// retry AND the auction hasn't passed endAtMs, Lua would reject it as
		// ERR_TOO_LOW (place_bid.lua step 4). Returning the rejection here saves
		// one EVALSHA round-trip per doomed bid.
		//
		// Codex review fixes — three semantic guards mirror Lua's check order:
		//  1. DUPLICATE preservation (place_bid.lua step 1): a retry with a
		//     previously-accepted (aid, userID, clientBidID) MUST replay the
		//     original ack, not return ERR_TOO_LOW. Check the Redis dedupe Hash
		//     before fast-rejecting; if present, fall through so Lua replays.
		//  2. ERR_AFTER_END (place_bid.lua step 3): a bid arriving past endAtMs
		//     MUST return ERR_AFTER_END, not ERR_TOO_LOW. Check the cached
		//     endAtMs; if the gateway's clock sees it as past, fall through to
		//     Lua (Lua's Redis TIME is authoritative for the actual decision).
		//  3. Cap-hit SOLD: handled in updateRoomStateFromEvent — a BID_ACCEPTED
		//     with `status: SOLD` drops the cache immediately, so the next bid
		//     after a cap-hit always falls through to Lua (which returns
		//     ERR_NOT_LIVE on a terminal auction).
		//
		// Correctness invariant (after the three guards): the cache only
		// ratchets up, so cache ≤ Lua actual current price. A bid ≤ cache is
		// also ≤ Lua actual, and the guards ensure we only fast-reject when
		// Lua's response would specifically be ERR_TOO_LOW. No bid that Lua
		// would accept (or return DUPLICATE/ERR_AFTER_END/ERR_NOT_LIVE for) is
		// wrongly handled as ERR_TOO_LOW.
		rsTop := s.hub.roomStateSnap(c.aid)
		// Sealed modes (issue #114) skip the V10k Tier C fast-reject below: it
		// compares the bid against the cached BROADCAST price, which sealed modes
		// never publish, so it would mis-handle sealed bids. Sealed defers
		// entirely to the authoritative sealed Lua.
		sealed := model.UsesSealedEngine(rsTop.mode)
		// HYBRID_REVEAL still runs the English adjudication path, so the
		// fast-reject stays SOUND: the broadcast carries the 2nd-highest amount,
		// which is always <= the true currentPrice, so any bid <= cached is also
		// <= actual (Lua would return ERR_TOO_LOW). Fast-reject just gets less
		// effective for hybrid; correctness is preserved.
		hybrid := model.UsesHybridEngine(rsTop.mode)
		if rs := rsTop; !sealed && rs.priceCents != "" && !rs.terminal {
			// Guard 0 (codex pass-2 Q1): rs.terminal is set under the same
			// write lock as the price ratchet for cap-hit / AUCTION_SOLD /
			// NO_BID / CANCELLED. Any reader observing a populated cache also
			// sees terminal=true and defers to Lua's ERR_NOT_LIVE here.
			if cached, errC := strconv.ParseInt(rs.priceCents, 10, 64); errC == nil {
				bidN, errB := strconv.ParseInt(amount, 10, 64)
				if errB == nil && bidN <= cached {
					// Guard 2 (codex pass-2 Q2 — clock-skew safety): defer to
					// Lua's ERR_AFTER_END when the gateway's wall clock is
					// within `fastRejectExpiryMarginMs` of the cached endAtMs.
					nowMs := time.Now().UnixMilli()
					inWindow := rs.endAtMs == 0 || nowMs+fastRejectExpiryMarginMs < rs.endAtMs
					if inWindow {
						// Guards 1+3+4+5 (codex pass-4): pipelined Redis precheck
						// of every Lua guard that runs BEFORE the amount-too-low
						// check in place_bid.lua. ONE round-trip pulls:
						//   - status: must be LIVE (else ERR_NOT_LIVE)
						//   - paused: must be false (else ERR_AUCTION_PAUSED)
						//   - sellerId == userID: forbidden (else ERR_NOT_ALLOWED
						//     "seller_self_bid", anti-shill-bidding)
						//   - dedupe HEXISTS clientBidID: must be absent (else
						//     DUPLICATE-replay)
						// Only when ALL four are clear does Lua proceed to the
						// ERR_TOO_LOW check; only then is fast-reject safe.
						// Errors → fall through to Lua ("unsure → defer to the
						// authoritative source"; Redis-down surfaces as
						// ERR_AUCTION_PAUSED via bidErrCode on the Lua path).
						fp, perr := s.st.FastPathPrecheck(ctx, c.aid, c.userID, d.ClientBidID)
						if perr == nil && fp.IsLive && !fp.IsPaused && !fp.IsSellerSelfBid && !fp.IsDupe {
							c.push(rejected(c.aid, model.CodeErrTooLow))
							if c.metrics != nil {
								c.metrics.AckLatency.Observe(time.Since(ackStart))
								c.metrics.BidsRejectedFastPath.Inc()
								c.metrics.BidsRejected.Inc()
							}
							return
						}
						// perr != nil OR any guard violated → fall through to Lua
					}
					// inWindow == false → within skew margin of endAtMs → Lua decides
				}
			}
		}
		// T8 ack latency: includes envelope decode (caller), canonicalAmount, Lua
		// dispatch, payload unmarshal, and the trySend (non-blocking enqueue). It is
		// the full server-side processing time for one BID_PLACE — the user-visible
		// "click → toast" budget. Script_time is the same call's narrow EVALSHA
		// portion (Lua exec + Redis RTT), measured separately so a hot-path Lua
		// regression separates from a Go-side regression.
		// TODO(T3, [全员 approve]): per-connection inbound bid rate limit + wire code
		// ERR_RATE_LIMITED (§8). Deferred: the new code is an all-member-approve
		// contract change and dedupe already makes retries cheap. At T2 scale (single
		// gateway/Redis) the blast radius is bounded; revisit before multi-gateway T5.
		scriptStart := time.Now()
		var code, payload string
		var err error
		if sealed {
			// Sealed bid: amount recorded privately; the returned payload is the
			// bidder's OWN ack (pushed only to their socket below). The room sees
			// only the redacted SEALED_BID_RECEIVED stream event.
			code, _, payload, err = s.st.PlaceBidSealed(ctx, c.aid, c.userID, d.ClientBidID, amount, c.displayName)
		} else if hybrid {
			// Hybrid-reveal bid: English adjudication, but the Stream broadcast
			// carries the PRIOR leader's amount + identity (so the room sees the
			// runner-up). The returned payload is the bidder's full ack.
			code, _, payload, err = s.st.PlaceBidHybrid(ctx, c.aid, c.userID, d.ClientBidID, amount, c.displayName)
		} else {
			code, _, payload, err = s.st.PlaceBid(ctx, c.aid, c.userID, d.ClientBidID, amount, c.displayName)
		}
		scriptDur := time.Since(scriptStart)
		if c.metrics != nil {
			c.metrics.ScriptTime.Observe(scriptDur)
		}
		// P8: the BID_PLACE handler's own synchronous work must stay ≤5ms. Observe
		// it as (full handler) − (PlaceBid/Redis span) so the network RTT (already
		// covered by AckLatency p95<80ms) can't mask a Go-side regression. Observed
		// inline at each exit branch rather than via a defer-closure — the per-bid
		// hot path stays allocation-free (see metrics.Histogram.Time docs).
		if err != nil {
			log.Printf("place_bid %s: %v", c.aid, err)
			c.push(rejected(c.aid, bidErrCode(err)))
			if c.metrics != nil {
				c.metrics.BidsRejected.Inc()
				c.metrics.HandlerOverhead.Observe(time.Since(handlerStart) - scriptDur)
			}
			return
		}
		switch code {
		case model.CodeOKAccepted, model.CodeOKExtended, model.CodeOKSold, model.CodeDuplicate:
			// Ack the originating socket directly, in addition to the Pub/Sub room
			// broadcast the subscriber fans out to observers. trySend enqueues or, if
			// the buffer is full, drops the connection so the client reconnects and
			// re-syncs (never silently loses a critical ack). The client also gets
			// the broadcast copy and dedupes by seq. OK_EXTENDED/OK_SOLD ack the bid
			// here; their AUCTION_EXTENDED / AUCTION_SOLD reaches the room via Pub/Sub.
			c.push(bidAccepted(c.aid, payload))
			if c.metrics != nil {
				c.metrics.AckLatency.Observe(time.Since(ackStart))
				// DUPLICATE is not a fresh accept (proto/error-codes.md: it replays the
				// original ack and is intentionally not flagged as an error), so it
				// doesn't bump BidsAccepted. The retry already counted on first land.
				if code != model.CodeDuplicate {
					c.metrics.BidsAccepted.Inc()
				}
			}
		default:
			c.push(rejected(c.aid, code))
			if c.metrics != nil {
				c.metrics.AckLatency.Observe(time.Since(ackStart))
				c.metrics.BidsRejected.Inc()
			}
		}
		if c.metrics != nil {
			// P8 handler overhead for the non-error paths (accept / reject):
			// full handler span minus the Redis PlaceBid span.
			c.metrics.HandlerOverhead.Observe(time.Since(handlerStart) - scriptDur)
		}
	}
}

func rejected(aid, code string) model.Envelope {
	env, _ := model.NewEnvelope(model.TypeBidRejected, aid, 0, model.BidRejectedData{Code: code})
	return env
}

// canonicalAmount validates that s is a positive base-10 integer fitting int64
// (cents) and returns its canonical decimal form, so "0123" / "+123" -> "123".
// ok=false ⇒ malformed (ERR_BAD_INPUT). Range checks vs increment/cap are the
// Lua hot path's job. Canonicalizing here keeps the money-as-string boundary
// canonical, since place_bid.lua echoes the amount string verbatim.
func canonicalAmount(s string) (string, bool) {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 || n > int64(model.MaxMoneyCents) {
		return "", false
	}
	return strconv.FormatInt(n, 10), true
}

func bidAccepted(aid, payload string) model.Envelope {
	var bad model.BidAcceptedData
	_ = json.Unmarshal([]byte(payload), &bad)
	env, _ := model.NewEnvelope(model.TypeBidAccepted, aid, bad.Seq, bad)
	return env
}

// bidErrCode honours the frozen boundary "Redis down -> ERR_AUCTION_PAUSED": a
// NOSCRIPT (flushed script cache) is a genuine internal/dispatcher fault, but
// any other EVALSHA transport error means Redis is effectively unavailable.
func bidErrCode(err error) string {
	if strings.Contains(strings.ToUpper(err.Error()), "NOSCRIPT") {
		return model.CodeErrInternal
	}
	return model.CodeErrPaused
}
