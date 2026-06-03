# WebSocket Protocol

Source basis: RFC v1 §8 plus Issue #3 scope. Day-2 protocol freeze should keep JSON examples debuggable even if production chooses msgpack.

## Envelope

```ts
type WsEnvelope<T = unknown> = {
  type: string
  auctionId?: string
  requestId?: string
  traceId?: string
  serverInstanceId?: string
  seq?: number
  serverTimeMs: number
  data: T
}
```

Protocol JSON uses camelCase. Money fields such as `amountCents` are strings at the protocol boundary to avoid JavaScript number ambiguity.

## Client To Server

| type | data | purpose |
|---|---|---|
| `ROOM_JOIN` | `{ auctionId, lastSeq? }` | Join room and request catchup. |
| `ROOM_LEAVE` | `{ auctionId }` | Leave room. |
| `BID_PLACE` | `{ clientBidId, amountCents: string }` | Submit bid. |
| `PING` | `{}` | Heartbeat. |
| `CHAT_SEND` | `{ text }` | Soft room channel. |

## Server To Client

| type | purpose |
|---|---|
| `ROOM_SNAPSHOT` | Current price, winner, leaderboard, `endAtMs`, `seq`, state. |
| `ROOM_STATE_PATCH` | Coalesced high-fanout room projection; advances state high-watermark without delivering every intermediate bid frame. |
| `CATCHUP_EVENTS` | Stream replay from `lastSeq + 1`. |
| `BID_ACCEPTED` | Accepted bid ack with `seq`, amount, updated time, and Lua-authoritative `bidCount`. |
| `BID_REJECTED` | Rejected bid with machine-readable error code. |
| `USER_OUTBID` | Current user was surpassed. |
| `AUCTION_EXTENDED` | Anti-snipe extension event; not a state. |
| `AUCTION_SOLD` | Terminal sold event. |
| `AUCTION_NO_BID` | Terminal no-bid/passed event. |
| `AUCTION_CANCELLED` | Abnormal cancellation. |
| `PONG` | Heartbeat response. |

## Error Codes

Issue #3 freezes the bid rejection code set through the WebSocket contract. Redis/Lua codes used by the protocol are:

`OK_ACCEPTED`, `OK_SOLD`, `DUPLICATE`, `ERR_NOT_LIVE`, `ERR_TOO_LOW`, `ERR_AFTER_END`, `ERR_RATE_LIMITED`, `ERR_AUCTION_PAUSED`, `OK_CANCELLED`, `OK_NO_BID`, `ERR_NOT_DUE`, `ERR_ALREADY_TERMINAL`, `ERR_NOT_ALLOWED`.

`DUPLICATE(previousResult)` is a replayed idempotent ack/result, not a client rejection.

## Channel Queues

Issue #3 is closed with four logical room channels. Backpressure policy follows V8 §0.3 boundary 8: bid-critical messages must not be blocked by soft chat/AI traffic, and WebSocket `bufferedAmount` is watched at 1MB/4MB thresholds.

| Channel | Queue size | Traffic | Drop / degrade rule |
|---|---:|---|---|
| `critical` | 200 | bid ack, auction state, catchup, hammer, cancel | Never drop while the socket is open; if `bufferedAmount` exceeds 4MB, close and force reconnect/catchup. |
| `presence` | 100 | online count, join/leave, room presence | Coalesce by latest room/user state before enqueue. |
| `chat` | 20 | user chat and atmosphere messages | Drop oldest soft messages when full or when `bufferedAmount` exceeds 1MB. |
| `ai` | 20 | LLM auctioneer text and AI sidecar notices | Drop oldest soft messages when full or when `bufferedAmount` exceeds 1MB; AI loss never blocks bidding. |

## Countdown Clock

Clients do not trust local time alone:

```text
remainingMs = endAtMs - (clientNowMs + serverClockOffsetMs)
```

`serverClockOffsetMs` is calibrated from `serverTimeMs` in snapshots and events. Redis TIME is the adjudication source, with expiry boundary `now >= endAtMs`.
