# T3 test cases — Timer Hammer + Seller Cancel (PR #29)

> Author: @fariZzzz (infra/AI/QA lens, blocking authority on CI/evidence gates per [#15 Workflow v2](https://github.com/Eliaaazzz/live-auction-system/issues/15)).
> Target: `elia/T3-hammer-cancel` at commit `24a2151`.
> Base-chain status: **PR #29 still stacks on `elia/T2-atomic-bid-core`** (main HEAD is `a5ee566`, T1-only). Cases run against the T3 branch which carries the full chain locally; CI/merge gates are blocked on the leader's rollup PR.
>
> Schema (per @fariZzzz's 5/25 directive): every case must carry `ID / title / preconditions / steps / input data / expected result / priority`. Cases come in two kinds:
> - **Coverage (TC-T3-001…015)** — matching the 14 existing `_test.go` cases in PR #29; the author also uses them as an executable checklist during review
> - **Gap probes (TC-T3-100…107)** — boundary scenarios PR #29 does not currently cover but that follow from the architecture; this review argues each must either get a test or an explanation of why it is safe
>
> Priority: **P0** system unusable / asset loss / split state · **P1** critical-path functional error · **P2** self-heals but poorly observable · **P3** extreme/rare
>
> Note: all money fields are `cents` (string-at-boundary, int64-internal); `endAtMs` is Unix ms; `Redis TIME` is the authoritative clock inside Lua; `seq` is a monotonic `HINCRBY` on the state machine, strictly aligned with the Stream entry `<seq>-0`.

---

## 0. Case index

### Coverage (15)

| ID | Title | Matching PR #29 test | P |
|---|---|---|---|
| TC-T3-001 | Timer hammer LIVE → SOLD, correct winnerId, no gaps in the Stream | `TestCloseAuctionSold` | P0 |
| TC-T3-002 | Timer hammer on a LIVE auction with no bids → NO_BID | `TestCloseAuctionNoBid` | P0 |
| TC-T3-003 | Closing before expiry → ERR_NOT_DUE returns the current endAtMs and the state is unchanged | `TestCloseAuctionNotDue` | P0 |
| TC-T3-004 | Closing an already-terminal state → ERR_ALREADY_TERMINAL | `TestCloseAuctionAlreadyTerminal` | P1 |
| TC-T3-005 | §4.1 hammer-race oracle (sequential): the late bid loses to close | `TestT3HammerRaceOraclePlaceBidLosesToClose` | P0 |
| TC-T3-006 | §4.1 hammer-race oracle (concurrent): under `-race`, two goroutines and the late bid never wins | `TestT3HammerRaceConcurrentLateBidNeverWins` | P0 |
| TC-T3-007 | Seller cancels a LIVE auction → CANCELLED, later bids rejected | `TestCancelAuctionLive` | P0 |
| TC-T3-008 | Seller cancels a SCHEDULED auction → CANCELLED, AUCTION_CANCELLED@1-0 | `TestCancelAuctionScheduled` | P1 |
| TC-T3-009 | A non-seller cancels → ERR_NOT_ALLOWED, state unchanged | `TestCancelAuctionNotOwner` | P0 |
| TC-T3-010 | Cancelling an already-terminal state → ERR_ALREADY_TERMINAL | `TestCancelAuctionAlreadyTerminal` | P1 |
| TC-T3-011 | Cancel must fail closed when sellerId is an empty string | `TestT3CancelFailClosedOnEmptySeller` | P0 |
| TC-T3-012 | Closing in the SCHEDULED state is a no-op with no Stream write | `TestT3CloseOnScheduledIsNoOp` | P1 |
| TC-T3-013 | Cancelling a LIVE auction that has a top bid → CANCELLED (not SOLD) | `TestT3CancelLiveWithBidsGoesCancelledNotSold` | P0 |
| TC-T3-014 | stream/state seq mismatch → the preflight rejects it, no dirty write | `TestT3CloseSeqStreamMismatchNoDirtyWrite` | P0 |
| TC-T3-015 | Wrong key type → ERR_INTERNAL, both close and cancel refuse | `TestT3CloseCancelKeyTypeGuard` | P1 |
| TC-T3-016 | A second hammer → ERR_ALREADY_TERMINAL with seq/stream unchanged | `TestT3CloseDoubleHammerSecondAlreadyTerminal` | P0 |
| TC-T3-017 | Reconcile self-heal: a LIVE auction that fell out of the index is re-tracked | `TestT3TimerReconcileRetracksLostLiveAuction` | P0 |
| TC-T3-018 | E2E: the Timer hammers after a 1.5s cycle, broadcasts AUCTION_SOLD, MySQL shows SOLD | `TestT3TimerHammerEndToEnd` | P0 |
| TC-T3-019 | E2E: cancelling a LIVE auction over REST → broadcasts AUCTION_CANCELLED + MySQL CANCELLED | `TestT3CancelLiveEndToEnd` | P0 |
| TC-T3-020 | E2E: cancelling a DRAFT touches MySQL only, a non-seller gets 403, a repeat cancel gets 409 | `TestT3CancelDraftAndForbidden` | P1 |

### Gap probes (8) — not covered by the existing cases; this review argues for adding them

| ID | Title | Risk | P |
|---|---|---|---|
| TC-T3-100 | Whether cancelling concurrently with freeze on a DRAFT splits MySQL/Redis state | TOCTOU, seller loss | P1 |
| TC-T3-101 | cancel.lua succeeds but `UpdateAuctionStatus` fails → the client sees a 500; is persistence eventually consistent? | Does the documented self-heal actually happen | P1 |
| TC-T3-102 | The reconcile interval (5s) exceeds the auction durationMs (<5s) and TrackActive already failed at start | A short auction misses its hammer window | P2 |
| TC-T3-103 | Two Timer instances (`--mode=all` + `--mode=timer`) closing the same auction concurrently → behaviour | Documented as harmless, needs e2e verification | P2 |
| TC-T3-104 | The Timer retries forever when close.lua returns `ERR_INTERNAL{'seq_stream_mismatch'}` | Log flood with no convergence | P2 |
| TC-T3-105 | Cancel racing the timer hammer (concurrent OK_CANCELLED vs OK_SOLD, which one wins) | The terminal state decides the outcome | P1 |
| TC-T3-106 | The SCAN cost of reconcile's `ScanStateAIDs` with 10K LIVE auctions | A T8 perf hazard | P2 |
| TC-T3-107 | Restarting mid-cancel (the stream has AUCTION_CANCELLED but MySQL is still LIVE) → the initial persistence sweep should reconcile it | Correctness of the stream-first design | P1 |

---

## 1. Coverage cases (based on what PR #29 already implements)

### TC-T3-001 — Timer hammer LIVE → SOLD, gap-free Stream

- **Preconditions**
  - Redis + MySQL are up and the Lua scripts have been `SCRIPT LOAD`ed
  - A LIVE auction `aid` exists with a 60s duration
  - `seq=0` and the Stream is empty
- **Steps**
  1. The seller freezes rules and starts the auction
  2. Buyer `u1` bids `11000` (`startPrice=10000 + increment=1000`)
  3. The test force-writes `state.endAtMs=1` to simulate expiry
  4. Call `CloseAuction(ctx, aid)`
  5. Read the snapshot and `ReadEventsAfter(ctx, aid, "")`
- **Input data**
  - `Rules{StartPrice:10000, Increment:1000, Cap:0, Duration:60s}`
  - `clientBidId=cb1, amount=11000, userId=u1`
- **Expected result**
  - `CloseAuction` returns `OK_SOLD` with a nil error
  - `snap.Status==SOLD, snap.WinnerID=="u1", snap.CurrentPriceCents=="11000"`
  - The Stream has 2 entries: `[BID_ACCEPTED@1-0, AUCTION_SOLD@2-0]`, with seq strictly increasing 1 → 2
  - Any subsequent PlaceBid returns `ERR_NOT_LIVE`
- **Priority**: P0

### TC-T3-002 — Timer hammer on a LIVE auction with no bids → NO_BID

- **Preconditions**: a LIVE auction with no bids, `seq=0`
- **Steps**: the test force-writes `endAtMs=1` and calls `CloseAuction`
- **Input data**: no bid input
- **Expected result**: returns `OK_NO_BID`; status becomes `NO_BID`; the Stream has `[AUCTION_NO_BID@1-0]`
- **Priority**: P0

### TC-T3-003 — Closing before expiry → ERR_NOT_DUE

- **Preconditions**: a LIVE auction with `endAtMs ≈ now + 60s`
- **Steps**: without touching endAtMs, call `CloseAuction` directly
- **Expected result**: returns `ERR_NOT_DUE` with a second return value of `endAtMs > 0` (so the Timer can refresh the ZSET score with it); status is still `LIVE`; no new Stream entry
- **Priority**: P0

### TC-T3-004 — Closing a terminal state → ERR_ALREADY_TERMINAL

- **Preconditions**: a LIVE auction with cap=50000, where a buyer bids 50000 directly to trigger a cap-hit SOLD (the T2 path)
- **Steps**: write `endAtMs=1` and call `CloseAuction`
- **Expected result**: `ERR_ALREADY_TERMINAL` with no HSET/XADD/PUBLISH at all
- **Priority**: P1

### TC-T3-005 — §4.1 hammer-race oracle (sequential)

- **Preconditions**: a LIVE auction with an existing valid bid `u1@11000`
- **Steps**:
  1. Write `endAtMs=1` to simulate expiry
  2. **In order**: first PlaceBid(`u2, 12000`), then CloseAuction
- **Expected result**:
  - PlaceBid returns `ERR_AFTER_END` with seq=0 (no write)
  - CloseAuction returns `OK_SOLD` and the winner is still `u1@11000`
  - Stream: `[BID_ACCEPTED@1, AUCTION_SOLD@2]`, with no entry for `u2`
- **Priority**: P0 (pinned oracle)

### TC-T3-006 — §4.1 hammer-race oracle (concurrent, under `-race`)

- **Preconditions**: same as 005, but PlaceBid and CloseAuction start simultaneously from two goroutines (released by a start channel)
- **Expected result**:
  - No matter which script Redis's single thread runs first, the late bid's code ∈ {`ERR_AFTER_END`, `ERR_NOT_LIVE`} (never `OK_ACCEPTED`)
  - Close always returns `OK_SOLD`
  - The final snapshot and Stream match 005
- **Priority**: P0

### TC-T3-007 — Seller cancels a LIVE auction → CANCELLED

- **Preconditions**: a LIVE auction with owner=`sellerTestID`
- **Steps**: `CancelAuction(ctx, aid, sellerTestID)`
- **Expected result**: `OK_CANCELLED`; status=`CANCELLED`; Stream `[AUCTION_CANCELLED@1-0]`; subsequent PlaceBid → `ERR_NOT_LIVE`
- **Priority**: P0

### TC-T3-008 — Seller cancels a SCHEDULED auction

- **Preconditions**: an auction frozen but not started
- **Expected result**: `OK_CANCELLED` with a single Stream entry `AUCTION_CANCELLED@1-0` (freeze does not consume a seq)
- **Priority**: P1

### TC-T3-009 — A non-seller cancels

- **Preconditions**: a LIVE auction with callerId=`not_the_seller`
- **Expected result**: `ERR_NOT_ALLOWED`, status unchanged, no Stream write
- **Priority**: P0

### TC-T3-010 — Cancelling an already-terminal auction

- **Preconditions**: it has already been cancelled once (CANCELLED)
- **Expected result**: the second call returns `ERR_ALREADY_TERMINAL` with no Stream write
- **Priority**: P1

### TC-T3-011 — Empty-string sellerId → fail closed (a CRITICAL counter-example)

- **Preconditions**: a LIVE auction with a **manual HSET sellerId=""** to simulate corrupted state
- **Steps**: `CancelAuction(ctx, aid, sellerTestID)`
- **Expected result**: returns `ERR_NOT_ALLOWED` (it must fail closed and must not let the call through); status is still LIVE
- **History**: the old Lua wrote `if sellerId ~= '' and callerId ~= sellerId`, so an empty sellerId skipped the check entirely → anyone could cancel. The new Lua fixes it with `if not sellerId or sellerId == '' or callerId ~= sellerId`
- **Priority**: P0

### TC-T3-012 — Closing a SCHEDULED auction (the Timer mis-delivery scenario)

- **Preconditions**: frozen but not started (status=SCHEDULED)
- **Steps**: call CloseAuction(ctx, aid)
- **Expected result**: `ERR_ALREADY_TERMINAL` (SCHEDULED is not terminal, but Lua uses this code to say "not LIVE, the Timer need not retry"); status is still SCHEDULED; Stream len=0
- **Priority**: P1

### TC-T3-013 — Cancel is not a hammer: cancelling a LIVE auction with a winner still goes to CANCELLED

- **Preconditions**: a LIVE auction with an existing bid `u1@11000`
- **Steps**: the seller cancels
- **Expected result**: `OK_CANCELLED` (**not OK_SOLD — the buyer does not get the item**); the last Stream event is `AUCTION_CANCELLED`; later bids return `ERR_NOT_LIVE`
- **Priority**: P0 (critical product semantics)

### TC-T3-014 — A seq mismatch preflight must not dirty-write

- **Preconditions**: LIVE, no bids (seq=0)
- **Steps**:
  1. The test force-writes a bogus Stream entry `1-0` (`stream seq=1`, `state seq=0` → desync)
  2. Write `endAtMs=1`
  3. Call CloseAuction
- **Expected result**: `ERR_INTERNAL{'seq_stream_mismatch'}`; **status is still LIVE and seq is still 0** (the HINCRBY must not have run)
- **Why it matters**: Lua has no rollback, so the preflight is the only protection
- **Priority**: P0

### TC-T3-015 — Wrong key type (type guard)

- **Preconditions**: the test writes a String type with `SET stateKey(aid) "corrupt"`
- **Steps**: call close and cancel once each
- **Expected result**: both return `ERR_INTERNAL{'key_type'}` and neither touches the corrupted key
- **Priority**: P1

### TC-T3-016 — Double hammer

- **Preconditions**: LIVE, `u1@11000`
- **Steps**:
  1. Write `endAtMs=1`
  2. Call CloseAuction → `OK_SOLD`
  3. Call CloseAuction again
- **Expected result**: the second call returns `ERR_ALREADY_TERMINAL`; seq does not move (`snap2.Seq == snap1.Seq`); Stream len=2 (BID_ACCEPTED + one AUCTION_SOLD, no duplicate)
- **Priority**: P0 (double Timer firing / multi-instance concurrency)

### TC-T3-017 — Reconcile self-heals a lost LIVE auction (CRITICAL)

- **Preconditions**: freeze + start a LIVE auction `live_aid` (TrackActive succeeded); separately create a freeze-only `sched_aid`
- **Steps**:
  1. The test calls `UntrackActive(ctx, live_aid)` to simulate the end state of a failed TrackActive
  2. Call `reconcileActive(ctx, st)` directly
  3. Query `DueAuctions` with a huge score to see whether `live_aid` is back in the ZSET
- **Expected result**:
  - `live_aid` is present in the ZSET (reconcile re-tracked it)
  - `sched_aid` is **not** in the ZSET (non-LIVE states are not tracked)
- **Why it matters**: this is the CRITICAL self-heal added during PR #29's self-review — in the older implementation without this reconcile, a failed TrackActive meant the auction would never be hammered by anyone
- **Priority**: P0

### TC-T3-018 — E2E Timer hammer, full chain

- **Preconditions**: the in-process harness is up (Redis + MySQL + hub + persistence + timer)
- **Steps**:
  1. seller devLogin + createProduct + createAuction (`durationMs=1500`)
  2. freeze + start
  3. buyer devLogin, dial WS, ROOM_JOIN
  4. Send `BID_PLACE{cb=cbT3, amount=11000}`
  5. Wait for `BID_ACCEPTED`
  6. Wait for the Timer to fire → receive `AUCTION_SOLD`
  7. Poll GET /api/auctions/{aid} until status=SOLD
- **Input data**: `rules{StartPrice:10000, Increment:1000, Cap:1000000, Duration:60, ExtendWindow:0}` (important: `ExtendWindow=0` stops anti-snipe from extending endAtMs)
- **Expected result**:
  - BID_ACCEPTED arrives within 5s
  - AUCTION_SOLD arrives within 5s (the Timer scans every 100ms and fires after 1.5s)
  - MySQL status becomes SOLD within 5s
- **Priority**: P0 (E2E, covering broadcast + persistence projection)

### TC-T3-019 — E2E cancel a LIVE auction over REST

- **Preconditions**: same as 018 but duration=60s and no bids
- **Steps**:
  1. seller freeze + start
  2. buyer dials WS
  3. seller POST /api/auctions/{aid}/cancel
  4. buyer waits for `AUCTION_CANCELLED`
  5. Poll MySQL for status=CANCELLED
- **Expected result**: REST returns OK_CANCELLED; the buyer receives AUCTION_CANCELLED within 5s; MySQL becomes CANCELLED within 5s
- **Priority**: P0

### TC-T3-020 — E2E DRAFT cancel + non-seller + repeat

- **Preconditions**: a DRAFT auction (created but not frozen)
- **Steps**:
  1. Another seller cancels → expect 403
  2. The owning seller cancels → expect OK_CANCELLED (a MySQL-only flip)
  3. Poll MySQL for status=CANCELLED
  4. The owner cancels again → expect 409 ERR_ALREADY_TERMINAL
- **Expected result**: status codes and wire codes match exactly
- **Priority**: P1

---

## 2. Gap-probe cases (this review argues for adding them)

### TC-T3-100 — DRAFT cancel concurrent with freeze → split MySQL/Redis?

- **Preconditions**: a freshly created DRAFT auction `aid` with owner=A
- **Steps**:
  1. Start two goroutines: G1 = `POST /freeze` (runs freeze_rules.lua and writes SCHEDULED state to Redis), G2 = `POST /cancel`
  2. Release them simultaneously
  3. Compare Redis state.status with MySQL auctions.status
- **Possible interleavings**:
  - **(a)** G2's cancel reads MySQL first → DRAFT → takes the MySQL-only branch → MySQL CANCELLED. **Then** G1's freeze writes SCHEDULED to Redis. Final: **MySQL=CANCELLED, Redis state.status=SCHEDULED — split state**
  - **(b)** G1 finishes first → MySQL SCHEDULED → G2 takes the Lua branch and cancels → OK
- **Expected result (my position)**:
  - Under any interleaving, the final Redis and MySQL states must agree
  - With the current implementation, interleaving (a) does split — I suggest `handleCancel` use SELECT…FOR UPDATE, or re-read the latest state, before taking the DRAFT branch
- **Reproduction difficulty**: it needs the same seller to trigger freeze+cancel within milliseconds; extremely rare in practice, but the TOCTOU is real
- **Priority**: P1

### TC-T3-101 — Eventual consistency when cancel.lua succeeds but the MySQL update fails

- **Preconditions**: a LIVE auction; mock or inject a MySQL failure (e.g. take the database down while `UPDATE auctions SET status=...` runs)
- **Steps**:
  1. seller POST /cancel
  2. cancel.lua succeeds → Redis CANCELLED + Stream AUCTION_CANCELLED + publish
  3. Assume UntrackActive succeeds
  4. UpdateAuctionStatus fails → the handler returns 500 to the client
  5. **Bring MySQL back up** and wait for the persistence sweep (2s tick)
  6. Query MySQL `auctions.status`
- **Expected result**: the persistence worker projects the AUCTION_CANCELLED event into MySQL CANCELLED. **Eventually consistent**
- **Why it matters**: in the dev-log Eliaaazzz argues that "INSERT IGNORE is idempotent and the cursor only advances once both succeed, so the projection is eventually consistent" — a test should actually prove it
- **Priority**: P1

### TC-T3-102 — The window for short auctions (<5s) plus a failed TrackActive

- **Preconditions**: an auction with durationMs=2000; mock `TrackActive` to fail the first time (inject a ZADD error)
- **Steps**:
  1. freeze + start (start returns OK_LIVE, TrackActive fails, start still returns 200)
  2. No bids, wait for natural expiry (~2s)
  3. Meanwhile: the Timer's 100ms scan cannot see this auction (it is not in the index)
  4. Reconcile only runs at 5s → re-adds it to the index → hammers immediately (now > endAtMs)
- **Expected result (my position)**: the auction will eventually hammer (NO_BID) but **3-5s late** (beyond the auction's own window). This should be documented as acceptable
- **Why it matters**: the 5s reconcile interval is an SLO, and the docs should say "when TrackActive fails, the hammer is delayed by at most one reconcile interval"; otherwise users will assume "the auction ends on time"
- **Priority**: P2

### TC-T3-103 — Two Timers closing the same auction concurrently

- **Preconditions**: run two lumen processes (`--mode=all` plus an extra `--mode=timer`), both on the same Redis
- **Steps**:
  1. Create a LIVE auction and set `endAtMs=1` so it is immediately due
  2. Get both Timers to see the auction in the same scan cycle (within the same 1ms)
  3. Observe the Stream and the state
- **Expected result**:
  - One Timer gets OK_SOLD/NO_BID and the other gets ERR_ALREADY_TERMINAL → both untrack
  - The Stream has exactly one terminal event
  - Both Timers' untrack ZREM calls are idempotent
- **Why it matters**: the dev-log claims "Redis serializes Lua scripts so this is harmless" — that needs e2e verification, not just an argument
- **Priority**: P2

### TC-T3-104 — The Timer retries forever on ERR_INTERNAL

- **Preconditions**: a LIVE auction with an artificially induced `seq_stream_mismatch` (the test writes a dirty Stream entry)
- **Steps**:
  1. close.lua returns ERR_INTERNAL
  2. Look at the `switch` in timer.go::hammerDue (it only covers OKSold/OKNoBid/ErrAlreadyTerminal/ErrNotDue)
  3. Watch the Timer over the next 5 scan ticks (500ms)
- **Expected result**: **the Timer calls close.lua every 100ms, gets ERR_INTERNAL each time, and neither untracks nor backs off.** A log flood with no convergence path
- **Suggested fix**:
  - Count ERR_INTERNALs and untrack plus emit an alarm after N of them
  - Or add jittered backoff
- **Priority**: P2 (it spews logs during a production incident but does not corrupt data)

### TC-T3-105 — Cancel racing the timer hammer

- **Preconditions**: a LIVE auction with `u1@11000` and endAtMs about to pass
- **Steps**:
  1. At the endAtMs instant, fire concurrently (from separate goroutines): G1 = the seller's cancel over REST, G2 = the Timer's scan + close
  2. Check the final state
- **Expected result (under any interleaving)**:
  - The final state ∈ {`SOLD`, `CANCELLED`}
  - The Stream has exactly one terminal event (`AUCTION_SOLD` or `AUCTION_CANCELLED`)
  - The loser gets `ERR_ALREADY_TERMINAL` from Lua
  - The MySQL projection agrees with Redis state.status
- **Why it matters**: at the product level, "does cancel or hammer win" changes the seller's outcome (SOLD means payment, CANCELLED means none) — so "whoever reaches Redis first wins" needs to be documented as accepted design
- **Priority**: P1

### TC-T3-106 — The cost of the reconcile scan at high LIVE-auction density

- **Preconditions**: inject 10K LIVE auction state hashes into Redis
- **Steps**:
  1. Call `reconcileActive(ctx, st)`
  2. Measure wall time and the Redis command count
- **Expected result (the budget I propose)**: p95 < 200ms (with a 5s reconcile interval, that is < 4% duty cycle)
- **Why it matters**: `ScanStateAIDs` does a SCAN with COUNT=200 and calls `Snapshot` (HGETALL) for each aid. 10K auctions ≈ 50 SCANs + 10K HGETALLs → potentially hundreds of ms on single-threaded Redis. A T8 perf risk
- **Priority**: P2 (must be verified at T8)

### TC-T3-107 — Does persistence reconcile MySQL after a restart mid-cancel?

- **Preconditions**: a LIVE auction; trigger a cancel and then **immediately** SIGKILL the lumen process, before the persistence worker projects it
- **Steps**:
  1. seller cancel → cancel.lua succeeds, the Stream has AUCTION_CANCELLED@2-0 (or 1-0), MySQL is **still LIVE** (persistence has not run)
  2. SIGKILL lumen
  3. Restart lumen
  4. Wait for the initial persistence sweep
  5. Check the MySQL status
- **Expected result**: after the restart MySQL becomes CANCELLED within ~2s (the initial sweep replays the whole Stream and projects via terminalStatus())
- **Why it matters**: this is the key invariant of the stream-first design — losing a Pub/Sub message must not lose state. The dev-log argues it; a test should confirm it
- **Priority**: P1

---

## 3. Execution plan

- **Coverage (TC-T3-001..020)**: this PR already implements 14 `_test.go` cases; run `go test -race -count=1 ./apps/lumen/internal/store/... ./apps/lumen/internal/server/...`
- **Gap probes (TC-T3-100..107)**:
  - 101, 105, 107 should land in a follow-up test PR (high-value regression tests for the stream-first self-heal semantics)
  - 100 should be added alongside a rewrite of handleCancel (with SELECT FOR UPDATE or retry-on-conflict)
  - 102, 103, 104, 106 are documented as known gaps to revisit at T5/T8

## 4. Review history

- v1 (2026-05-25, @fariZzzz) — first draft against commit `24a2151`, with the base chain still stranded on T2
