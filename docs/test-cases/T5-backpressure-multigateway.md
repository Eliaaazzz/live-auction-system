# T5 test cases — Backpressure Channel Split + Multi-Gateway Fanout (PR #38)

> Author: @fariZzzz (per [Workflow v2 global-scope review #15](https://github.com/Eliaaazzz/live-auction-system/issues/15)).
> Target: `elia/T5-multigateway-backpressure` at commit `fe90763` (current HEAD). Drafted v1 against `a4c31a9`; v2 reflects post-review fixes; **v3** adds 2 executable probes after pull-and-test of `fe90763`.
> Based on `main` (now T1+T2+T3+T3-followup, post #31/#33 rollups).
> Executable gap probes (TC-T5-110/111) land in **PR #44** (`fari/T5-followup-gap-tests`, stacked on #38 — mirrors #33 for T3).
> Authored **before** the substantive PR #38 review per the team's "test cases first" precedent ([#30 T3](https://github.com/Eliaaazzz/live-auction-system/pull/30) → [#35 T4](https://github.com/Eliaaazzz/live-auction-system/pull/35)).
>
> Schema: every case must carry `ID / title / preconditions / steps / input data / expected result / priority`. Cases come in two kinds:
> - **Coverage (TC-T5-001…010)** — matching the 5 existing `_test.go` cases in PR #38 (v1 = 3, v2 adds 2) plus the contract-level cases inferred from them
> - **Gap probes (TC-T5-100…111)** — boundary scenarios not covered by PR #38 but derived from the architecture (110/111 became executable in v3)
>
> Priority: **P0** system unusable / data loss · **P1** critical-path error · **P2** self-heals but poorly observable · **P3** extreme/performance
>
> Note: CRITICAL lane = `send chan []byte, cap=sendBufFrames=256` (bid acks, AUCTION_* events incl. AUCTION_EXTENDED, ROOM_SNAPSHOT, catchup); LOSSY lane = `lossy chan []byte, cap=16` (PONG; presence/chat in future). `writePump` uses **best-effort** critical-first priority (a single in-flight lossy frame is the delay bound, since Go's select is pseudo-random fairness). **Invariant**: `sendBufFrames > catchupMaxGap` (256 > 200) — pinned in `TestT5CatchupFitsInSendBuffer`.

---

## 0. Case index

### Coverage (10)

| ID | Title | Matching PR #38 test | P |
|---|---|---|---|
| TC-T5-001 | CRITICAL lane full → connection force-closed, client reconnects + re-syncs | `TestT5BackpressureCriticalDropsConn` | P0 |
| TC-T5-002 | LOSSY lane full → that frame is dropped, connection stays up | `TestT5BackpressureLossyDropsFrameKeepsConn` | P0 |
| TC-T5-003 | Multiple gateways on the same auction → one bid fans out to both clients | `TestT5MultiGatewayFanout` | P0 |
| TC-T5-004 | CRITICAL frames drain before LOSSY (writePump priority) | (implicit, not tested separately) | P1 |
| TC-T5-005 | After force-close, hub.leave is triggered by the read goroutine with no deadlock | (implicit in the broadcast comment) | P1 |
| TC-T5-006 | close() is idempotent — safe to call repeatedly (closeOnce + the send channel is never closed) | (implicit, not tested separately) | P1 |
| TC-T5-007 | Concurrent trySend + trySendLossy on the same Conn: no panic / race | **✅ landed as executable** `TestT5ConcurrentCloseVsSendFloodIsRaceClean` (PR #44 — see TC-T5-110, which is stronger: a concurrent close() runs alongside) | P0 (race) |
| TC-T5-008 | trySend on an already force-closed Conn → no panic and no enqueue (`fe90763` adds a leading done-check) | `TestT5TrySendAfterCloseDoesNotEnqueue` (added in v2) | P0 |
| TC-T5-011 | Filling the critical lane (cap=256) with a 200-frame catchup → no force-close, no drop | `TestT5CatchupFitsInSendBuffer` (added in v2; invariant `sendBufFrames > catchupMaxGap`) | P0 |
| TC-T5-009 | The ws.go `eventsUpToSnapshot` filter still works (the T2 PR #31 fix was not broken by T5) | `TestT2HiddenCatchupDoesNotReplayPastSnapshotSeq` | P0 (regression) |
| TC-T5-010 | hub.broadcast calling trySend while holding the RLock → no deadlock, even when trySend triggers close | (implicit, not tested separately) | P0 |

### Gap probes (12) — status mapping (some fixed from v2 on; v3 adds 2 executable probes in PR #44)

| ID | Title | v3 status (`fe90763`) | P |
|---|---|---|---|
| TC-T5-100 | A single slow client really does not block the others (n-1 fast + 1 frozen client, measuring broadcast latency) | Still open — the quantitative validation of T5's core value, needs a follow-up | P1 |
| TC-T5-101 | When trySend inside hub.broadcast triggers close(), the Conn lingers in hub.rooms | **✅ FIXED in `fe90763`** — `trySend`/`trySendLossy` gained a leading non-blocking `<-c.done` check, so post-close frames are dropped instead of enqueued. Pinned by `TestT5TrySendAfterCloseDoesNotEnqueue` | P1 (resolved) |
| TC-T5-102 | A flood of LOSSY frames plus 1 critical frame → is critical really prioritized? (writePump select fairness) | **✅ DOC TIGHTENED in `fe90763`** — the `writePump` comment and `ws-envelope.md §Backpressure` now say "best-effort priority" and state explicitly that "a critical frame can be delayed by one in-flight lossy write (Go select pseudo-random fairness)". Strict priority is still out of scope | P1 (doc-resolved) |
| TC-T5-103 | bufferedAmount 1MB/4MB threshold (V9 §0 ⑧) — not implemented yet, the PR body defers it to T8 | Still deferred to T8 | P2 |
| TC-T5-104 | multi-gateway under load (200-event catchup < 1s concurrently) | Still deferred to T8 | P2 |
| TC-T5-105 | When gateway A dies, are its conns in hub.rooms cleaned up? | Still open — the process-crash scenario needs a chaos test | P1 |
| TC-T5-106 | trySend still enqueues after done is closed | **✅ FIXED in `fe90763`** — same patch as TC-T5-101; the leading done-check blocks the enqueue | P2 (resolved) |
| TC-T5-107 | A 200-frame catchup plus a fanout burst can exceed the critical cap | **✅ FIXED in `fe90763`** — `sendBufFrames=256` replaces the original cap=64; the invariant `sendBufFrames > catchupMaxGap` is pinned in `TestT5CatchupFitsInSendBuffer`. **Was a P1 correctness bug; now closed.** The residual headroom (`256-200=56` frames) under concurrent fanout is quantified as TC-T5-111 (a T8 load item, not correctness) | P1 (resolved) |
| TC-T5-108 | Lane classification of the AUCTION_EXTENDED frame forwarded over PubSub | **✅ DOC FIXED in `fe90763`** — `ws-envelope.md` now says explicitly "`AUCTION_*` events incl. `AUCTION_EXTENDED`" in the critical lane | P3 (resolved) |
| TC-T5-109 | Whether the "deferred to read goroutine" hub.leave path after a force-close reclaims fast enough under a reconnect storm | Still open — a T9 chaos-drill topic | P3 |
| TC-T5-110 | A concurrent close() racing a trySend/trySendLossy flood → race-clean and converges to closed | **✅ EXECUTABLE in PR #44** — `TestT5ConcurrentCloseVsSendFloodIsRaceClean`, 16×500 concurrent senders plus close()×2; verifies that the residual TOCTOU of the leading done-check and the "channels never closed" invariant are safe under `-race`. PASSes locally | P0 (race) |
| TC-T5-111 | Catchup headroom boundary: beyond `sendBufFrames-catchupMaxGap` frames, catchup still force-closes | **✅ EXECUTABLE in PR #44** — `TestT5CatchupHeadroomBoundary`: prefill=headroom survives, headroom+1 force-closes. This is the residual of TC-T5-107 and exactly the item @Eliaaazzz's CR asked to relocate to T8 load. PASSes locally | P2 (T8 load) |

**Summary**: v1 raised 10 gap probes; v2 `fe90763` closed **5 of them** (101, 102 doc, 106, 107, 108). The remaining P1s are TC-T5-100 (quantitative slow-client SLO) and TC-T5-105 (stale conn after a gateway crash); T8-deferred (103, 104); T9-deferred (109).

---

## 1. Coverage cases

### TC-T5-001 — CRITICAL lane full → force-close

- **Preconditions**: `Conn{send: chan(cap=2), lossy: chan(cap=2), done: chan}`
- **Steps**:
  1. `c.trySend([]byte("a"))` → enqueued on send
  2. `c.trySend([]byte("b"))` → enqueued on send (cap=2 now full)
  3. `c.trySend([]byte("c"))` → over cap
  4. Check whether `c.done` is closed
- **Expected result**: the third trySend triggers close(); `<-c.done` returns immediately (non-blocking)
- **Why it matters**: a slow client must not drag down the whole room, but a critical event must not be silently dropped either — force-close is the correct trade-off
- **Priority**: P0

### TC-T5-002 — LOSSY lane full → drop one frame, keep the connection

- **Preconditions**: `Conn{send: chan(cap=2), lossy: chan(cap=1), done: chan}`
- **Steps**:
  1. `c.trySendLossy([]byte("a"))` → enqueued on lossy (cap=1 now full)
  2. `c.trySendLossy([]byte("b"))` → over cap, dropped
  3. Check that `c.done` is still not closed and `len(c.lossy) == 1`
- **Expected result**: the connection stays up and only the second lossy frame is lost
- **Why it matters**: heartbeat / presence are unimportant, losing one is fine, and it should never cost the client its connection
- **Priority**: P0

### TC-T5-003 — multi-gateway fanout

- **Preconditions**: Redis is up and a LIVE auction exists
- **Steps**:
  1. Start hubA + hubB (each subscribing to Pub/Sub)
  2. cA joins hubA, cB joins hubB (same aid)
  3. PlaceBid once
  4. Wait for both cA and cB to receive `BID_ACCEPTED` (4s deadline)
- **Expected result**: both conns receive the frame — Pub/Sub + Stream are the carriers of cross-gateway fanout, so no shared hub is needed
- **Why it matters**: the heart of T5 horizontal scale — gateways can scale out with no single point
- **Priority**: P0

### TC-T5-004 — writePump CRITICAL-first priority

- **Preconditions**: writePump is running on the Conn, 1 critical frame pending plus a flood of 100 lossy frames
- **Steps**:
  1. Simultaneously call c.trySend(critical) and c.trySendLossy ×100
  2. Measure when the critical frame reaches the socket versus the 100 lossy frames
- **Expected result**: the critical frame should reach the socket before the 100 lossy frames (priority works)
- **Why it matters**: stops a lossy flood from pushing critical frames back
- **Current implementation**: writePump uses a "select with default" pattern — a non-blocking check of critical first, and only if critical is empty does it select on lossy. Theoretically correct, but needs verification
- **Priority**: P1
- **Tested**: ❌

### TC-T5-005 — after a force-close, hub.leave is triggered by the read goroutine

- **Preconditions**: the Conn is in hub.rooms and trySend triggers close()
- **Steps**: 1. force-close the conn  2. check whether hub.rooms performed the leave
- **Expected**: close() closes the socket → the read goroutine errors out and exits → handleWS defers s.hub.leave(c) → leave. **Not immediately**
- **Open question**: in the window between close and leave, a new hub.broadcast will try to trySend to a conn whose socket is already closed — writing to the channel is fine (the channel is not closed), but writePump has already returned (done is closed), so the frame is never consumed. The next broadcast triggers trySend → channel full → close() again (already closed, a no-op via closeOnce). Eventually leave happens. So it self-heals, but there is a window where dead frames are enqueued.
- **Why it matters**: this is documented design and a test should pin the behaviour of that window
- **Priority**: P1
- **Tested**: ❌

### TC-T5-006 — close() is idempotent

- **Preconditions**: Conn{done: chan, closeOnce}
- **Steps**: c.close(); c.close(); c.close()
- **Expected**: done is closed exactly once, with no panic
- **Priority**: P1
- **Tested**: ❌ (closeOnce is used explicitly in the code, but the unit test is missing)

### TC-T5-007 — concurrent trySend + trySendLossy + close() race

- **Preconditions**: a Conn with N goroutines concurrently calling trySend / trySendLossy / close
- **Steps**: run for 100ms under `-race`
- **Expected**: no panic and no race-detector report
- **Why it matters**: in the real system the Pub/Sub fanout goroutine, writePump, and the read goroutine can all touch it concurrently
- **Priority**: P0 (race safety)
- **Tested**: ❌

### TC-T5-008 — trySend on a force-closed Conn does not panic

- **Preconditions**: closeOnce.Do has already run on the Conn
- **Steps**: call trySend / trySendLossy several more times
- **Expected**: no panic (the send channel is never closed, it just has no consumer → fills up → triggers close again, which is a no-op)
- **Why it matters**: a design invariant — the docs state explicitly that "the send channel is never closed, to avoid panic-on-send-to-closed"
- **Priority**: P0
- **Tested**: ❌

### TC-T5-009 — the eventsUpToSnapshot filter was not broken by T5 (regression)

- **Preconditions**: the T2 PR #31 `eventsUpToSnapshot` fix is still in place
- **Steps**: the existing `TestT2HiddenCatchupDoesNotReplayPastSnapshotSeq`
- **Expected**: still PASSes
- **Why it matters**: a regression check — T5 did not touch the dispatch handler, but it deserves a sanity check
- **Priority**: P0 (regression)
- **Tested**: ✅ (inherited from the T2 tests)

### TC-T5-010 — hub.broadcast calling trySend inside the RLock triggers close without deadlocking

- **Preconditions**: the hub holds the RLock when trySend fills up → close()
- **Steps**: several conns in the same room, one with a full buffer and another idle
- **Expected**: the broadcast completes, close goes through closeOnce → the done channel closes → the read goroutine sees the socket close and exits → the deferred leave runs → leave takes the Lock only after the RLock is released
- **Why it matters**: the `Hub.broadcast` comment states explicitly that "close() defers the hub.leave to the read goroutine, so it can't deadlock under this RLock". A test should confirm it
- **Priority**: P0 (deadlock = system stall)
- **Tested**: ❌

---

## 2. Gap-probe cases

### TC-T5-100 — a slow client really does not block the others (quantitative)

- **Preconditions**: 1 "frozen" Conn (never consumes send) plus N healthy Conns
- **Steps**:
  1. Start N=10 normal + 1 frozen, all in the same room
  2. Broadcast 100 frames
  3. Measure when a normal Conn receives the 100th frame
- **Expected**: normal Conns finish within < 100ms, the frozen Conn is force-closed, and the room size returns to N
- **Why it matters**: this is the core SLO claim of the T5 backpressure design — it needs numbers, not a unit test
- **Priority**: P1
- **Tested**: ❌ (single-frame force-close is tested, but not the quantitative multi-client case)

### TC-T5-101 — the window between force-close and hub.rooms cleanup ✅ FIXED in `fe90763`

- **v1 scenario (against `a4c31a9`)**: `Conn.close()` does not call `hub.leave`, so leave depends on the read goroutine's defer. Between close and leave, a broadcast still trySends to a dead conn → frames pile up in the send buffer and are never consumed
- **v2 fix**: both `trySend` and `trySendLossy` gained a leading non-blocking `<-c.done` check, so post-close frames are dropped instead of enqueued. Pinned by the new test `TestT5TrySendAfterCloseDoesNotEnqueue`: after close, 100 trySend + 100 trySendLossy calls leave both buffers at len=0
- **Status**: RESOLVED

(The original v1 analysis, kept for comparison:)

- **Preconditions**: the Conn is closed but hub.leave has not fired yet
- **Steps**:
  1. trySend triggers close
  2. Immediately hub.broadcast on the same aid (before the read goroutine is rescheduled)
  3. Check whether trySend piles up on the dead conn (the channel is still open)
- **Expected**: trySend writes to the channel once, the next broadcast fills it → close again (no-op) → the frames end up stuck in the send buffer and are never consumed
- **Risk**: memory accumulation. One conn with 64-byte frames × a 64-slot buffer = 4KB, negligible. The real leak is the entry in the hub.rooms map (2 fields: a 64-cap channel + a 16-cap lossy channel + done + closeOnce + a few strings)
- **Suggestion**: close() should call hub.leave(self) itself rather than depending on the read goroutine, or trySend should return without enqueuing once it sees done closed
- **Priority**: P1
- **Tested**: ❌

### TC-T5-102 — writePump priority is not fair ✅ DOC TIGHTENED in `fe90763`

- **v1 analysis**: if a lone critical frame arrives while the lossy buffer also has something pending, Go's select is pseudo-random, so the critical frame is delayed by at most one lossy frame
- **v2 fix**: the docs/comments changed from "drained with priority" to "**best-effort priority**", with an explicit bound: "a pending critical frame pre-empts a pending lossy one in the leading non-blocking poll; under Go's pseudo-random select fairness a critical frame can be delayed by at most one in-flight lossy write" (`ws.go` writePump comment + `proto/ws-envelope.md §Backpressure`). Strict priority (an additional non-blocking critical poll after each lossy write) stays deferred because it is unnecessary at v0 scale
- **Status**: the docs match the implementation and do not overclaim. RESOLVED at the doc level

(The original v1 analysis, kept for comparison:)

- **Scenario**: writePump's first select is critical-first (it only watches c.done and c.send and falls through on default). The second select is a three-way c.done / c.send / c.lossy (random)
- **Problem**: if the critical buffer is usually empty while lossy keeps flooding in, writePump is already waiting on lossy in the second select when a critical frame arrives, and the runtime picks randomly
- **The math**: when a lone critical frame arrives with a lossy frame also pending, the Go runtime picks at random → 50% — this is not truly "critical first"
- **Mitigation**: after the default, writePump loops back to the top and re-enters the first select, so a critical frame is delayed by at most 1 lossy frame. Acceptable — but the PR comment saying "critical-first" slightly overclaims
- **Expected (suggestion)**: add a quantitative test — 1 critical + 1000 lossy arriving concurrently, and check that critical lands within the first 10 frames
- **Priority**: P1
- **Tested**: ❌

### TC-T5-103 — bufferedAmount 1MB/4MB is not implemented

- **The PR body admits**: "bufferedAmount 1MB/4MB thresholds (RFC §0 ⑧) ... T8 load-tested items"
- **Currently**: there is no bufferedAmount monitoring or forced disconnect
- **Risk**: a 64-cap channel with 64-byte frames ≈ 4KB per conn — far under the RFC's 1MB threshold, but a full channel closes the connection, so what actually takes effect is the channel cap, not a byte threshold
- **Suggestion**: the docs should state clearly that "PR #38 v2 uses a channel cap of **256** as the backpressure boundary, not a byte threshold. If large frames (>1KB) are supported later, a byte-based threshold must replace it"
- **Priority**: P2
- **Tested**: ❌ (deferred to T8)

### TC-T5-104 — multi-gateway under load

- **Scenario**: 2 gateways with 100 conns each, 1 bid → 200-way fanout
- **Expected (SLO)**: all 200 conns receive BID_ACCEPTED within < 200ms
- **Currently**: TC-T5-003 only tests 2 conns with no load
- **Priority**: P2 (T8 perf)
- **Tested**: ❌

### TC-T5-105 — stale conn cleanup on a gateway crash

- **Scenario**: gatewayA's process is SIGKILLed and every conn in its hub dies
- **Current implementation**: when the process dies its hub memory dies with it, so the problem does not arise (each gateway has its own hub)
- **However**: if the gateway dies partially (the write goroutine panics while read survives), hub.rooms keeps stale conns
- **Expected**: the read goroutine is bound to see the socket error and exit first → the deferred leave runs → cleanup
- **Priority**: P1
- **Tested**: ❌ (the process-crash scenario needs a chaos test, not a unit test)

### TC-T5-106 — trySend still enqueues after done is closed ✅ FIXED in `fe90763`

- Same patch as TC-T5-101 (a leading non-blocking `<-c.done` check in `trySend`/`trySendLossy`)
- Post-close frames are now dropped rather than enqueued; pinned by `TestT5TrySendAfterCloseDoesNotEnqueue`
- RESOLVED

(The original v1 analysis, kept for comparison:)

- **Preconditions**: c.close() has run (done is closed, send is still open)
- **Test**: trySend([]byte("late"))
- **Expected**: with the current implementation it enters the send channel and stays in the buffer permanently. The next broadcast adds another, until the cap is reached → close again (no-op)
- **Fix**: add a done check before the default in trySend: `select { case <-c.done: return; case c.send <- b: ; default: c.close() }`
- **Priority**: P2 (memory impact is tiny, but cleanup should be deterministic)
- **Tested**: ❌

### TC-T5-107 — 200-frame catchup vs the critical lane cap ✅ FIXED in `fe90763`

- **v1 scenario (against `a4c31a9`, cap=64)**: a client with lastSeq=0 on an auction that already has 200 events gets all 200 frames pushed at once (all through the CRITICAL lane). 200 frames > cap 64 → trySend inevitably trips a force-close, the client never sees ROOM_SNAPSHOT, and reconnect enters an infinite loop
- **Local verification (v1)**: a probe running `make(chan, 64)` plus 200 trySends with no drain triggered the force-close on exactly the 65th call ✓
- **v2 fix (`fe90763`)**: introduced the constant `sendBufFrames = 256` and used it for `Conn.send`. The **invariant** `sendBufFrames > catchupMaxGap` is pinned in the new test `TestT5CatchupFitsInSendBuffer`: a 200-frame replay produces no force-close and no drop. A compile-test-style `if sendBufFrames <= catchupMaxGap { t.Fatalf(...) }` stops a future refactor changing one constant without the other
- **Status**: the P1 correctness bug is RESOLVED; at T8 perf time we can consider paced catchup for large-chain auctions (>200 events), but that is not a correctness concern
- **v3 residual (quantified, TC-T5-111)**: `TestT5CatchupFitsInSendBuffer` proves a **cold buffer** absorbs catchupMaxGap. In a real flow the lane is not cold — `ROOM_SNAPSHOT` plus concurrent fanout already occupy slots — so the real headroom is only `sendBufFrames-catchupMaxGap = 56` frames. After pulling #38 I pinned that boundary with `TestT5CatchupHeadroomBoundary`: prefill 56 + replay 200 survives at cap; prefill 57 + replay 200 → the last frame force-closes (the intended fail-safe under genuine overload). This is a **T8 load concern, not P1 correctness** — exactly the item @Eliaaazzz's CR asked to relocate

### TC-T5-108 — AUCTION_EXTENDED rides the CRITICAL lane ✅ DOC FIXED in `fe90763`

- **v1 status**: the code path `c.push() → trySend → CRITICAL` does put it on the critical lane, but `ws-envelope.md` said "`AUCTION_*` terminals", which only covers SOLD/NO_BID/CANCELLED — the classification of AUCTION_EXTENDED was ambiguous
- **v2 fix**: `proto/ws-envelope.md §Backpressure` now says "`AUCTION_*` events incl. `AUCTION_EXTENDED`", stating explicitly that AUCTION_EXTENDED is on the critical lane (it carries endAtMs, which the client must receive to update its timer)
- Status: RESOLVED

### TC-T5-109 — close-leave-rejoin speed under a reconnect storm

- **Scenario**: 1000 conns, a broadcast fills them → 1000 closes → 1000 reconnects
- **Expected**: the system stabilizes within < 5s
- **Priority**: P3 (T9 chaos drill)
- **Tested**: ❌

### TC-T5-110 — a concurrent close() racing a send flood must be race-clean ✅ EXECUTABLE (PR #44)

> This is a new executable probe in v3. Methodology: pull #38 @ `fe90763` and attack the code paths the fix introduced, rather than re-running elia's existing tests.

- **Preconditions**: `Conn{send: chan(cap=sendBufFrames), lossy: chan(cap=16), done: chan}`, with a drain goroutine standing in for writePump (so senders that win the race do not all wedge on a full buffer)
- **Steps**:
  1. Start 16 sender goroutines, each doing 500 `trySend` + `trySendLossy` calls
  2. At the same time start 1 closer goroutine calling `c.close()` twice (verifying `closeOnce` idempotency with no double-close panic)
  3. After joining everything, check whether `c.done` is closed
- **Input data**: senders=16, perSender=500
- **Expected result**:
  - No panic and no race-detector report under `-race`
  - The residual TOCTOU (leading done-check passes → close fires → the enqueue lands) is bounded by design and does not cause a panic
  - The "`send`/`lossy` channels are never closed" invariant holds — any regression that closes the channels or drops `closeOnce` will panic-on-send-to-closed or race right here
  - The final state has `c.done` closed (converged)
- **Why it matters**: the executable and stronger version of TC-T5-007 (it adds a concurrent close); a race-safety regression guard for the fe90763 fix
- **Local result**: ✅ PASS under `-race`
- **Priority**: P0 (race safety)

### TC-T5-111 — catchup headroom boundary (the T8 residual of TC-T5-107) ✅ EXECUTABLE (PR #44)

- **Preconditions**: `headroom := sendBufFrames - catchupMaxGap` (= 256-200 = 56)
- **Steps**:
  1. **at_headroom_survives**: prefill `headroom` frames (simulating ROOM_SNAPSHOT + concurrent fanout occupying slots), then replay `catchupMaxGap` frames → check there is no force-close and `len(send)==sendBufFrames`
  2. **over_headroom_force_closes**: prefill `headroom+1` frames, then replay `catchupMaxGap` → check `c.done` is closed (the last replayed frame triggers the force-close)
- **Input data**: parameterized by deriving from the constants rather than hard-coding, so if `sendBufFrames`/`catchupMaxGap` change later the boundary follows automatically
- **Expected result**:
  - prefill ≤ headroom: catchup never force-closes (`TestT5CatchupFitsInSendBuffer` is the prefill=0 special case)
  - prefill > headroom: catchup does force-close — the **intended fail-safe** under genuine overload, not a bug
- **Why it matters**: it quantifies the residual of TC-T5-107. The fix moved catchup force-close from "any catchup trips it" (v1 cap=64 < 200) down to "only when the lane already holds >56 frames" — the latter is a T8 load boundary, not P1 correctness. @Eliaaazzz's CR explicitly asked for this item to be relocated to T8 load/perf
- **Local result**: ✅ PASS (both subtests)
- **Priority**: P2 (T8 load characterization)

---

## 3. Execution plan

- **Coverage (TC-T5-001..011)**:
  - **v1: 3 implemented** (TC-T5-001/002/003)
  - **v2 `fe90763`: +2** (TC-T5-008 `TestT5TrySendAfterCloseDoesNotEnqueue`, TC-T5-011 `TestT5CatchupFitsInSendBuffer`)
  - **v3 PR #44: TC-T5-007 landed** — `TestT5ConcurrentCloseVsSendFloodIsRaceClean` (executable and stronger)
  - 4 still recommended — TC-T5-004 (quantitative writePump priority), TC-T5-005 (close-vs-leave window timing), TC-T5-006 (a standalone close idempotency test), TC-T5-010 (broadcast-triggered close inside the RLock does not deadlock)
- **Gap probes (TC-T5-100..111)**:
  - **✅ RESOLVED in `fe90763`**: TC-T5-101 (close-leave window via the leading done-check), TC-T5-102 (priority wording → "best-effort"), TC-T5-106 (post-close drop, same patch as 101), TC-T5-107 (catchup>cap via sendBufFrames=256 + the invariant test), TC-T5-108 (AUCTION_EXTENDED doc classification)
  - **✅ EXECUTABLE in PR #44** (stacked on #38; I pulled fe90763 and verified the fix myself): TC-T5-110 (concurrent close is race-clean), TC-T5-111 (catchup headroom boundary = the T8 residual of 107)
  - **Still open — P1, suggested for a T5 follow-up**: TC-T5-100 (quantitative slow-client SLO), TC-T5-105 (stale conn after a gateway crash)
  - **Deferred to T8 perf**: TC-T5-103 (bufferedAmount), TC-T5-104 (multi-gateway under load), TC-T5-111 (load-scale validation of headroom under concurrent fanout)
  - **Deferred to T9 chaos**: TC-T5-109 (reconnect storm)

## 4. Review history

- v1 (2026-05-25, @fariZzzz) — first draft against commit `a4c31a9`, flagging 3 P1s (107 cap, 101 close-leave, 102 priority doc) plus 1 P3 (108 doc)
- v2 (2026-05-25, @fariZzzz) — realigned to `fe90763`: 5 gap probes resolved (101/102/106/107/108); 2 coverage cases added (TC-T5-008/011 matching `TestT5TrySendAfterCloseDoesNotEnqueue` + `TestT5CatchupFitsInSendBuffer`); the invariant `sendBufFrames > catchupMaxGap` pinned in a test. Eliaaazzz's PR #39 CR asked for the doc to reflect the current head rather than the v1 head — this update does that
- v3 (2026-05-25, @fariZzzz) — independent re-verification of `fe90763`: pulled #38, `go test -race ./...` all green, `TestT5MultiGatewayFanout` passing against real Redis/MySQL. Added 2 executable probes attacking the fix itself (not re-runs): **TC-T5-110** `TestT5ConcurrentCloseVsSendFloodIsRaceClean` (concurrent close vs flood is race-clean) and **TC-T5-111** `TestT5CatchupHeadroomBoundary` (catchup headroom boundary = the T8 residual of TC-T5-107, exactly the item @Eliaaazzz's CR asked to relocate to load/perf). The executable versions land in PR #44 (stacked on #38). Conclusion: the fix is solid and both P1s are properly closed
