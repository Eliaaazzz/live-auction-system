# Review Handoff: Single-Room 10k Fanout

## Verdict Requested

Review this branch for production readiness of the high-fanout room broadcast path.

Do not mark the single-room 10k fanout claim production-ready until the live Locust gate below has actually passed against a LIVE auction on the public target.

## Current Status

- P1 code-fix commit: `e546164` (`fix(web): keep large-room patch activity hot`).
- Use the current PR head from GitHub for the latest review SHA; this handoff may receive documentation-only follow-up commits.
- Current PR body explicitly keeps the single-room 10k claim behind a real public Locust gate.
- Follow-up P1 fixes from strict review are implemented:
  - `ROOM_STATE_PATCH` preserves self-bid UX when it arrives before the same-seq direct `BID_ACCEPTED` ack.
  - Large-room `ROOM_STATE_PATCH.bidCountDelta` contributes to frontend bid activity, ticker rows, and leaderboard refresh cadence.
- Public target probe from this environment returned HTTP 200 for `/healthz`, `/metrics`, and `/`.
- Real single-room 10k Locust has not been run in this round because it still needs an existing LIVE `AUCTION_ID` or a production-safe seller/setup path.

## Scope

Implemented a large-room WebSocket fanout mode that keeps Redis Lua and Redis Stream as the authoritative bid path, while coalescing public room UI updates into `ROOM_STATE_PATCH` frames after a room crosses the configured viewer threshold.

## Architecture

- Direct bidder ack remains `BID_ACCEPTED` and is sent immediately to the originating socket.
- Redis Stream still stores every accepted bid and remains the replay/evidence source of truth.
- Small rooms keep the existing per-event `BID_ACCEPTED` room broadcast behavior.
- Large rooms coalesce non-terminal `BID_ACCEPTED` room broadcasts into `ROOM_STATE_PATCH` at a configurable interval.
- Terminal `BID_ACCEPTED(status=SOLD)` and terminal auction events are not coalesced.
- `AUCTION_EXTENDED` is folded into an already-pending large-room patch so anti-snipe does not add a separate high-fanout frame for the same bid window.

## Protocol Notes

- `schemaVersion` is now `2`; frontend and protocol docs were updated together.
- `BID_ACCEPTED` now carries optional `bidCount`, atomically incremented by Lua with the accepted bid.
- `ROOM_STATE_PATCH` carries `fromSeq`, `seq`, `bidCountDelta`, `bidCountTotal`, price/winner/status/end time, and optional `extendCount`; `bidCountTotal` is sourced from Lua `bidCount` with an old-payload fallback.
- `ROOM_JOIN.lastSeq` is now the client-applied room-state high-watermark. Reconnect catchup replays Stream-backed deltas after that high-watermark, then sends a snapshot.
- The frontend treats `ROOM_STATE_PATCH.seq` as the reconnect high-watermark and uses `bidCountTotal` to avoid double-counting when a direct bidder ack and patch share the same sequence.

## Runtime Knobs

- `ROOM_STATE_PATCH_INTERVAL_MS`, default `50`.
- `ROOM_STATE_PATCH_MIN_VIEWERS`, default `1000`.
- Setting either value to `0` disables coalesced room-state patching.

## Review-Round Closure

- Schema/versioning: bumped to v2 and documented `ROOM_STATE_PATCH`.
- Seq semantics: documented patch high-watermark semantics and added reconnect high-watermark coverage.
- Counter correctness: Lua now emits accepted-bid `bidCount`; patch includes cumulative `bidCountTotal`; frontend applies max(total) instead of blindly adding deltas after direct acks.
- Metrics: added dedicated room-state patch latency/counter metrics and load-report budget checks.
- Anti-snipe fanout: folds `AUCTION_EXTENDED` into pending patches for large rooms.
- Test gaps: `TestT4EvidenceAfterHammer` and `TestT8HammerLatencyObservation` now pass; T4 test projection is isolated from shared local persistence workers before replaying its Stream.
- Round 3 closure: direct `BID_ACCEPTED` reducer now honors Lua `bidCount`; `TestT8HammerLatencyObservation` untracks its auction before forcing it due so another harness timer cannot steal the close; coalesced load smoke forces the threshold down and asserts `roomStatePatches`, `roomStatePatchBids`, patch latency samples, `seqGap=0`, and `backpressureForceClose=0`; terminal events clear coalescer `bidTotals`.
- Round 4 closure: `ROOM_STATE_PATCH` now handles the patch-before-direct-ack interleaving for the current bidder, and `LiveRoomRoute` treats patch deltas as live bid activity so large-room observers do not lose heat, ticker, or leaderboard refresh signals.

## Live 10k Gate

The production-readiness claim remains blocked until a real single-room public run produces evidence that satisfies all of these checks:

- `direct_ack` p95 below 80 ms.
- `roomStatePatch` p95 below 150 ms.
- `seqGap=0`.
- `backpressureForceClose=0`.
- `roomStatePatches > 0`.
- `roomStatePatchBids > 0`.
- observer read errors are 0.
- sampled observers converge to the authoritative high-watermark, or catch up through `ROOM_JOIN(lastSeq)`.

## Files Changed

- `apps/lumen/internal/metrics/metrics.go`
- `apps/lumen/internal/lua/place_bid.lua`
- `apps/lumen/internal/lua/place_bid_hybrid.lua`
- `apps/lumen/internal/model/model.go`
- `apps/lumen/internal/model/model_test.go`
- `apps/lumen/internal/server/evidence_t4_test.go`
- `apps/lumen/internal/server/load.go`
- `apps/lumen/internal/server/load_test.go`
- `apps/lumen/internal/server/ws.go`
- `apps/lumen/internal/server/ws_state_patch.go`
- `apps/lumen/internal/server/ws_state_patch_test.go`
- `apps/lumen/internal/store/lua_hybrid_reveal_privacy_test.go`
- `apps/lumen/internal/store/lua_integration_test.go`
- `apps/web/README.md`
- `apps/web/docs/test-cases/T6-frontend-wire.md`
- `apps/web/src/lib/types.js`
- `apps/web/src/lib/ws.test.js`
- `apps/web/src/routes/LiveRoomRoute.jsx`
- `apps/web/src/routes/LiveRoomRoute.test.jsx`
- `apps/web/src/store/auction.js`
- `apps/web/src/store/auction.test.js`
- `docs/ws-protocol.md`
- `proto/redis-keys.md`
- `proto/ws-envelope.md`

## Verification Run

- `npm test -- --run src/store/auction.test.js src/routes/LiveRoomRoute.test.jsx`
- `npm test -- --run src/lib/ws.test.js`
- `npm test -- --run src/store/auction.test.js src/routes/LiveRoomRoute.test.jsx src/lib/ws.test.js`
- `npm run build`
- PowerShell probe: `/healthz`, `/metrics`, and `/` on `http://115.191.76.40` returned HTTP 200.
- `go test ./apps/lumen/internal/model ./apps/lumen/internal/metrics ./apps/lumen/internal/server -run "Test(RoomStatePatch|HiddenEnvelope|NewEnvelope|T8MetricsEndpointShape|T8LoadReportBreaches|BroadcastFanout|T8LoadSmokeRunsAndPasses|T8LoadSmokeExercisesRoomStatePatch|T4EvidenceAfterHammer|T8HammerLatencyObservation)$" -count=1`
- `go test ./apps/lumen/internal/server -run "TestT4EvidenceAfterHammer|TestT8HammerLatencyObservation" -count=1 -v`
- `go test ./apps/lumen/internal/server -run "TestT8HammerLatencyObservation" -count=5`
- `go test ./apps/lumen/internal/... -count=1`
- `go test ./apps/lumen/internal/server -count=1`
- `npm test -- --run src/store/auction.test.js src/lib/ws.test.js`
- `npm run build`

## Review Focus

- Does `ROOM_STATE_PATCH` preserve client state when direct acks and patches interleave?
- Is `ROOM_JOIN.lastSeq` as an applied room-state high-watermark clear enough for reconnect behavior?
- Are dedicated patch metrics and load-report checks sufficient evidence for the 10k fanout path?
- Should `ROOM_STATE_PATCH_MIN_VIEWERS=1000` and `ROOM_STATE_PATCH_INTERVAL_MS=50` remain the demo defaults?
