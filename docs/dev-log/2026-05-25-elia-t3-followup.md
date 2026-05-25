# dev-log 2026-05-25 — @Eliaaazzz — T3 follow-up (fariZzzz gap-probes → CI)

Follow-up to T3 ([#29](https://github.com/Eliaaazzz/live-auction-system/pull/29)) / the rollup ([#31](https://github.com/Eliaaazzz/live-auction-system/pull/31)). Ports @fariZzzz's #30 gap-probe test cases ([#32](https://github.com/Eliaaazzz/live-auction-system/issues/32)) from a doc into **executable CI gates**, with the small fixes the fix-dependent ones validate. Stacked on `elia/T2-T3-rollup-to-main` so it reviews on its own diff; retarget to `main` after #31 lands.

> Why a separate PR (not #31): #31 was already APPROVED + green + demo-ready. These tests/fixes go through their own review so `main` only gets reviewed code and the demo PR stays untouched.

## What changed

**Executable now (assert current behavior — no fix needed):**
- **TC-T3-105** `TestT3CancelVsHammerRaceSingleTerminal` — seller cancel vs Timer hammer dispatched concurrently at `now >= endAtMs`. Redis serializes the two scripts; the invariant: exactly one terminal write (the other → `ERR_ALREADY_TERMINAL`), final status matches the winner, one terminal event after the bid (gap-free).
- **TC-T3-103** `TestT3DoubleTimerConcurrentCloseSingleTerminal` — two Timers closing the same due auction at once → exactly one `OK_SOLD` + one `ERR_ALREADY_TERMINAL`, one terminal event. Concurrent companion to `TestT3CloseDoubleHammerSecondAlreadyTerminal`.

**Fix + test (the fix-dependent gap-probes):**
- **TC-T3-100 (P1)** — DRAFT cancel + concurrent freeze TOCTOU. `handleCancel`'s DRAFT path now uses a **status-conditional CAS** `UpdateAuctionStatusIf(... WHERE status='DRAFT')`; if a concurrent freeze already moved the row to SCHEDULED the write no-ops and we re-read + fall through to the Lua cancel path instead of clobbering MySQL(CANCELLED) over Redis(SCHEDULED). Test `TestT3CancelDraftConditionalUpdateGuardsTOCTOU` pins the CAS primitive (applies on DRAFT; no-ops on SCHEDULED, leaving it untouched).
- **TC-T3-104 (P2)** — `close_auction` `ERR_INTERNAL` (seq/stream corruption) used to re-hammer every 100ms with no operator signal. `hammerDue` is split into `closeDue`, which now **untracks on `ERR_INTERNAL`** (the 5s reconcile re-probes slowly) + emits one ERROR — bounded log volume + a human-actionable signal, loop broken. Test `TestT3CloseDueErrInternalUntracks` drives `closeDue` directly (isolated on shared Redis) with a forced seq mismatch and asserts the untrack + that no terminal was written.

**Deferred in #32 (with reason — not done blind):**
- TC-T3-102 (reconcile 5s vs sub-5s auction): the fix (TrackActive backoff) is cheap but a deterministic test needs `TrackActive`-failure injection (mockable store) — left as a doc-contract note for now.
- TC-T3-106 (`ScanStateAIDs` cost at 10K+): a perf/bench item for T8, not a unit gate.
- TC-T3-107 (restart mid-cancel): the Stream→MySQL projection property is already pinned by `TestT3CancelEventualConsistencyFromStream` (TC-T3-101); a cold-start-only variant needs exposing the persistence sweep — deferred.

## Evidence
- Local `go build ./...` / `go vet` / `gofmt -l` clean (Docker/Redis/MySQL unavailable locally → full `-race` integration run is the CI gate on this PR).
- No new deps; `go.mod`/`go.sum` unchanged.
