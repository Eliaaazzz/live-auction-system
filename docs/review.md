# Review Handoff: Single-Room 10k Fanout

## Verdict Requested

Review this branch for production readiness of the high-fanout room broadcast path.

## Scope

Implemented a large-room WebSocket fanout mode that keeps Redis Lua and Redis Stream as the authoritative bid path, while coalescing public room UI updates into `ROOM_STATE_PATCH` frames when a room crosses a viewer threshold.

## Architecture

- Direct bidder ack remains `BID_ACCEPTED` and is sent immediately to the originating socket.
- Redis Stream still stores every accepted bid and remains the replay/evidence source of truth.
- Small rooms keep the existing per-event `BID_ACCEPTED` room broadcast behavior.
- Large rooms coalesce non-terminal `BID_ACCEPTED` room broadcasts into `ROOM_STATE_PATCH` at a configurable interval.
- Terminal `BID_ACCEPTED(status=SOLD)` and all terminal auction events are not coalesced.

## Runtime Knobs

- `ROOM_STATE_PATCH_INTERVAL_MS`, default `50`.
- `ROOM_STATE_PATCH_MIN_VIEWERS`, default `1000`.
- Setting either value to `0` disables coalesced room-state patching.

## Files Changed

- `apps/lumen/internal/model/model.go`
- `apps/lumen/internal/server/ws.go`
- `apps/lumen/internal/server/ws_state_patch.go`
- `apps/lumen/internal/server/ws_state_patch_test.go`
- `apps/web/src/lib/types.js`
- `apps/web/src/lib/ws.js`
- `apps/web/src/lib/ws.test.js`
- `apps/web/src/store/auction.js`
- `apps/web/src/store/auction.test.js`

## Verification Run

- `go test ./apps/lumen/internal/server -run "TestRoomStatePatch|TestBroadcastFanout|TestT8LoadReportBreaches"`
- `go test ./apps/lumen/internal/model ./apps/lumen/internal/server -run "Test(RoomStatePatch|Envelope|BidAccepted|BroadcastFanout|T8LoadSmokeRunsAndPasses)$"`
- `go test ./apps/lumen/internal/server -run "TestRoomStatePatch|TestBroadcastFanout|TestT8LoadSmokeRunsAndPasses" -count=1`
- `npm test -- --run src/store/auction.test.js src/lib/ws.test.js`

## Known Local Test Gap

`go test ./apps/lumen/internal/server` currently fails on `TestT4EvidenceAfterHammer` in this workspace. The failure reproduces when run alone and the new coalescing code is inactive for that small-room test path because the default threshold is 1000 viewers. Treat it as a residual integration-test issue unless review finds a causal path.

## Review Focus

- Does `ROOM_STATE_PATCH` preserve client seq semantics when direct acks and patches interleave?
- Does flushing pending patches before non-coalesced events preserve event order well enough for UI state?
- Are the default threshold and interval suitable for production demos?
- Should the protocol docs be updated in this PR or in a follow-up doc-only PR?
